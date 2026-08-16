import { useSearchParams } from 'react-router';

/**
 * La intención de cambiar de plan, escrita en la URL.
 *
 * Con un plan elegido, las pantallas de nivel y sede dejan de ser el camino:
 * el tablero ES el catálogo del plan. Pero siguen existiendo, porque en algún
 * momento hay que poder cambiarlo. Hace falta distinguir dos llegadas a la
 * misma ruta:
 *
 *   /nivel/pregrado             → de rebote (atrás, un enlace viejo) → al catálogo
 *   /nivel/pregrado?cambiar=1   → a propósito, desde el botón → mostrar el elector
 *
 * Va en la query y no en el `state` del router porque sobrevive a un F5 y se
 * puede pegar: si alguien recarga en mitad de elegir plan, sigue eligiendo en
 * vez de que la página se lo lleve de vuelta.
 */
const FLAG = 'cambiar';

/** Lo que hay que colgarle a un enlace para seguir en modo cambiar. */
export const CHANGING_QS = `?${FLAG}=1`;

export function useChangingPlan(): boolean {
  const [params] = useSearchParams();
  return params.get(FLAG) === '1';
}
