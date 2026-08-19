import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePlan } from '../hooks/usePlan';
import {
  itemId,
  loadScheduleSelection,
  saveScheduleSelection,
  type ScheduleSelection,
} from '../lib/storage';
import { ScheduleContext, type ScheduleApi } from './scheduleContext';

/**
 * Qué grupo eligió cada materia, compartido entre Mi semestre y Mi horario.
 *
 * Es Context y no un hook local —a diferencia de la primera versión de
 * esto— porque dejó de ser de un solo consumidor: las dos pantallas pintan
 * la MISMA tarjeta con el MISMO radio (ver CourseCard.tsx), así que marcar
 * un grupo en una tiene que verse marcado en la otra sin recargar. Mismo
 * razonamiento que llevó a `PlanProvider` a ser Context.
 */
export function ScheduleProvider({ children }: { children: React.ReactNode }) {
  const plan = usePlan();
  const [selection, setSelection] = useState<ScheduleSelection>(() => loadScheduleSelection());

  useEffect(() => {
    saveScheduleSelection(selection);
  }, [selection]);

  // Poda las materias que ya no están en Mi semestre: quitarlas de ahí no
  // pasa por acá, y sin esto su grupo elegido se queda huérfano para
  // siempre en localStorage.
  useEffect(() => {
    const validIds = new Set(plan.items.map(itemId));
    setSelection((prev) => {
      const stale = Object.keys(prev).filter((id) => !validIds.has(id));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [plan.items]);

  const pick = useCallback((id: string, sectionKey: string | null) => {
    setSelection((prev) => {
      if (sectionKey === null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: sectionKey };
    });
  }, []);

  const api = useMemo<ScheduleApi>(() => ({ selection, pick }), [selection, pick]);

  return <ScheduleContext value={api}>{children}</ScheduleContext>;
}
