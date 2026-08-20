import { useCallback, useMemo, useState } from 'react';
import { useTableSort } from '../hooks/useTableSort';
import { PlanViewContext, type PlanViewApi } from './planViewContext';

/**
 * El filtro y el orden de la tabla del plan, compartidos entre Mi semestre y
 * Mi horario.
 *
 * Mismo razonamiento que `ScheduleProvider`: dejó de ser de un solo
 * consumidor. Las dos pantallas pintan la MISMA tabla —misma cabecera con
 * orden, mismo chip de "con cupos"— así que ordenar o filtrar en una tiene
 * que verse hecho en la otra.
 *
 * El orden se persiste (`useTableSort`, localStorage); `onlyOpen` no, a
 * propósito. Son dos cosas distintas: el orden es una preferencia de cómo se
 * lee la lista, y esconder los grupos sin cupo es una pregunta de este rato
 * —"¿qué puedo tomar AHORA?"— cuya respuesta caduca. Un filtro que sobrevive
 * a cerrar la pestaña es de donde salen los "me faltan materias".
 */
export function PlanViewProvider({ children }: { children: React.ReactNode }) {
  const [onlyOpen, setOnlyOpen] = useState(false);
  const toggleOnlyOpen = useCallback(() => setOnlyOpen((v) => !v), []);
  const { sort, onSort } = useTableSort('plan');

  const api = useMemo<PlanViewApi>(
    () => ({ onlyOpen, toggleOnlyOpen, sort, onSort }),
    [onlyOpen, toggleOnlyOpen, sort, onSort],
  );

  return <PlanViewContext value={api}>{children}</PlanViewContext>;
}
