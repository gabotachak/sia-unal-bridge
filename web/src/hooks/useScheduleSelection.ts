import { useContext } from 'react';
import { ScheduleContext, type ScheduleApi } from '../state/scheduleContext';

/** Acceso a la selección de grupos de Mi horario, compartida con Mi
 *  semestre. Ver el error explícito de `usePlan`: mismo motivo. */
export function useScheduleSelection(): ScheduleApi {
  const ctx = useContext(ScheduleContext);
  if (!ctx) throw new Error('useScheduleSelection debe usarse dentro de <ScheduleProvider>');
  return ctx;
}
