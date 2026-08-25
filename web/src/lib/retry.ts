// Reintentos de lo que el SIA falla solo.
//
// Vive acá y no dentro de useApi porque /semestre no usa useApi: dispara sus
// peticiones a mano, varias en paralelo. Las dos rutas tienen que
// reintentar con el MISMO criterio, o la misma materia se comportaría distinto
// según desde qué pantalla se pide.

import { ApiError } from '../api/client';

/**
 * Errores que casi siempre se resuelven repitiendo la petición.
 *
 * No son fallos nuestros ni del servidor: son el estado de sesión del SIA
 * cediendo. Una sesión ADF muere a los ~4.2 min de inactividad y el pool no
 * siempre se entera antes de usarla; el resultado es una respuesta vacía
 * (`sia_noop`) que el back traduce a error explícito. Abrir una sesión nueva y
 * repetir funciona.
 *
 * `busy` es distinto pero se trata igual: el pool tiene un número fijo de
 * conexiones (`SIA_POOL_SIZE`) y estaban todas ocupadas. Esperar un momento es
 * literalmente la solución.
 */
export const TRANSIENT_CODES = new Set(['sia_noop', 'sia_session_lost', 'busy']);

/** Cuántas veces reintentar antes de mostrarle el error a una persona. */
export const MAX_RETRIES = 3;

export function isTransient(e: unknown): boolean {
  return e instanceof ApiError && TRANSIENT_CODES.has(e.code);
}

/**
 * Cuánto esperar antes del intento `attempt` (0 = el primer reintento).
 *
 * Exponencial con jitter: ~600ms, ~1200ms, ~2400ms. El jitter importa cuando
 * /semestre dispara cuatro en paralelo — sin él las cuatro reintentarían en el
 * mismo milisegundo y volverían a chocar contra el mismo pool lleno.
 */
export function backoffMs(attempt: number): number {
  return 300 * 2 ** attempt + Math.random() * 300;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
