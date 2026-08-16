import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  itemId,
  loadPlan,
  loadSelection,
  savePlan,
  saveSelection,
  selectionId,
  type PlanItem,
  type Selection,
} from '../lib/storage';
import { MAX_ITEMS, PlanContext, type PlanApi } from './planContext';

/**
 * El estado compartido de la app: la lista del semestre.
 *
 * Hasta acá cada pantalla se bastaba sola —pedía sus datos y los pintaba— así
 * que no hacía falta nada. Esta lista es distinta: se agrega desde el catálogo,
 * se agrega desde el detalle, se cuenta en el raíl y se lee en /semestre. Ese
 * es el momento en que un dato tiene que vivir por encima de las pantallas.
 *
 * Context es la respuesta de React a eso, y alcanza de sobra: son ~60 líneas
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
      if (prev.length >= MAX_ITEMS) return prev;
      if (prev.some((i) => itemId(i) === itemId(item))) return prev;
      ok = true;
      return [...prev, { ...item, addedAt: Date.now() }];
    });
    return ok;
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => itemId(i) !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  // El plan elegido vive acá y no en cada pantalla porque cambiarlo tiene un
  // efecto sobre la lista: son un solo estado con dos caras.
  const [selection, setSelection] = useState<Selection | null>(() => loadSelection());

  useEffect(() => {
    saveSelection(selection);
  }, [selection]);

  const select = useCallback(
    (next: Selection) => {
      // Elegir el MISMO plan otra vez no borra nada: pasa cada vez que se
      // vuelve al tablero, y perder el semestre por eso sería absurdo.
      if (selection && selectionId(selection) === selectionId(next)) {
        // Es el MISMO plan: no se borra nada. Igual se pisa el guardado, que
        // es cómo un plan adoptado desde una URL pegada —donde solo se sabía
        // el código— se queda con su nombre de verdad al pasar por la sede.
        setSelection(next);
        return;
      }

      if (selection) {
        // Cambio de plan: el semestre se reinicia entero.
        setItems([]);
      } else {
        // Adoptar un plan cuando no había ninguno no es un cambio, así que no
        // se borra todo. Sí se descartan las materias que no son de este plan:
        // pueden haber quedado de antes de que el plan fuera único, y en este
        // plan sus grupos no son los mismos.
        setItems((prev) => prev.filter((i) => selectionId(i) === selectionId(next)));
      }

      setSelection(next);
    },
    [selection],
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
      selection,
      select,
    }),
    [items, has, add, remove, clear, selection, select],
  );

  return <PlanContext value={api}>{children}</PlanContext>;
}
