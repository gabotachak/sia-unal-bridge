import { useContext } from 'react';
import { PlanContext, type PlanApi } from '../state/planContext';

/**
 * Acceso a la lista del semestre desde cualquier pantalla.
 *
 * El error explícito es a propósito: si alguien usa esto fuera del
 * PlanProvider, mejor un mensaje claro que un `null` que revienta tres
 * archivos más allá.
 */
export function usePlan(): PlanApi {
  const ctx = useContext(PlanContext);
  if (!ctx) throw new Error('usePlan debe usarse dentro de <PlanProvider>');
  return ctx;
}
