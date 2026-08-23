import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addToPlan,
  itemId,
  loadPlan,
  loadPlans,
  planSelection,
  savePlan,
  savePlans,
  selectionId,
  type PlanItem,
  type Selection,
} from '../lib/storage';
import { MAX_ITEMS, PlanContext, type PlanApi } from './planContext';

/**
 * El estado compartido de la app: la lista del semestre y los planes
 * elegidos (uno, o dos con doble titulación — PLAN-DOUBLE-TITULATION.md).
 *
 * Hasta acá cada pantalla se bastaba sola —pedía sus datos y los pintaba— así
 * que no hacía falta nada. Esta lista es distinta: se agrega desde el catálogo,
 * se agrega desde el detalle, se cuenta en el raíl y se lee en /semestre. Ese
 * es el momento en que un dato tiene que vivir por encima de las pantallas.
 *
 * Context es la respuesta de React a eso, y alcanza de sobra: son ~90 líneas
 * legibles. Redux o Zustand resolverían un problema de escala que esta app no
 * tiene.
 */
export function PlanProvider({ children }: { children: React.ReactNode }) {
  // Se lee de localStorage UNA vez, al arrancar. La función dentro de
  // useState se ejecuta solo en el primer render, no en cada repintado.
  const [items, setItems] = useState<PlanItem[]>(() => loadPlan());

  // Y se guarda cada vez que cambia. Un efecto por cada cosa que hace: este
  // solo persiste.
  useEffect(() => {
    savePlan(items);
  }, [items]);

  const has = useCallback((id: string) => items.some((i) => itemId(i) === id), [items]);

  const add = useCallback((item: Omit<PlanItem, 'addedAt'>) => {
    let ok = false;
    setItems((prev) => {
      // Actualizar en función del valor anterior, no del que capturó el
      // render: es la forma correcta cuando el nuevo estado depende del viejo.
      const next = addToPlan(prev, item, Date.now());
      if (next === null) return prev;
      ok = true;
      return next;
    });
    return ok;
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => itemId(i) !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  // Los planes elegidos viven acá y no en cada pantalla porque cambiarlos
  // tiene un efecto sobre la lista: son un solo estado con dos caras.
  const [plans, setPlans] = useState<Selection[]>(() => loadPlans());

  useEffect(() => {
    savePlans(plans);
  }, [plans]);

  const owns = useCallback(
    (s: Pick<Selection, 'level' | 'campus' | 'program'>) =>
      plans.some((p) => selectionId(p) === selectionId(s)),
    [plans],
  );

  const select = useCallback(
    (next: Selection[]) => {
      const result = planSelection(plans, next);
      if (!result) return false;
      // Cambio de verdad de conjunto: el semestre se reinicia entero. El
      // MISMO conjunto no borra nada — pasa cada vez que se vuelve al
      // tablero, y perder el semestre por eso sería absurdo.
      if (result.clear) setItems([]);
      setPlans(next);
      return true;
    },
    [plans],
  );

  // useMemo evita construir un objeto nuevo en cada repintado: si cambiara la
  // identidad del valor, TODO lo que consume el contexto se repintaría al
  // pedo.
  const api = useMemo<PlanApi>(
    () => ({
      items,
      has,
      add,
      remove,
      clear,
      full: items.length >= MAX_ITEMS,
      selection: plans[0] ?? null,
      plans,
      owns,
      select,
    }),
    [items, has, add, remove, clear, plans, owns, select],
  );

  return <PlanContext value={api}>{children}</PlanContext>;
}
