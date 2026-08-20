// La suma de créditos del semestre y sus umbrales.
//
// Vive acá y no en un componente por la misma convención que format.ts: un
// archivo de componentes exporta SOLO componentes, para que el recargado en
// caliente de Vite no pierda el hilo.

import type { PlanItem } from './storage';

/** Estatutos de la universidad: por debajo de esto no se puede inscribir. */
export const MIN_CREDITS_TO_REGISTER = 6;

/** Y por debajo de esto, al cerrar adiciones y cancelaciones, el semestre
 *  queda corto. Los dos son SOLO informativos acá — ver CreditsBadge — nunca
 *  bloquean agregar ni quitar una materia: la universidad los exige al
 *  inscribir y al cerrar, no en este tablero. */
export const MIN_CREDITS_TO_CLOSE = 10;

export type CreditsLevel = 'danger' | 'warning' | 'ok';

/** La suma de créditos de las materias agregadas al plan. */
export function sumCredits(items: Pick<PlanItem, 'credits'>[]): number {
  return items.reduce((n, i) => n + i.credits, 0);
}

/** danger = no alcanza para inscribir · warning = inscribe pero no cierra ·
 *  ok = alcanza para las dos cosas. */
export function creditsLevel(total: number): CreditsLevel {
  if (total < MIN_CREDITS_TO_REGISTER) return 'danger';
  if (total < MIN_CREDITS_TO_CLOSE) return 'warning';
  return 'ok';
}
