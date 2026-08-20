import { useContext } from 'react';
import { PlanViewContext, type PlanViewApi } from '../state/planViewContext';

/** Filtro y orden de la tabla del plan, compartidos entre Mi semestre y Mi
 *  horario. Ver el error explícito de `usePlan`: mismo motivo. */
export function usePlanView(): PlanViewApi {
  const ctx = useContext(PlanViewContext);
  if (!ctx) throw new Error('usePlanView debe usarse dentro de <PlanViewProvider>');
  return ctx;
}
