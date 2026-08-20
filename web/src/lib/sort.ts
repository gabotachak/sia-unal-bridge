import type { Row } from '../hooks/useCourseDetails';
import type { TableCol } from './table';

export type SortDir = 'asc' | 'desc';
export type Sort<K extends string> = { col: K; dir: SortDir };

export type SortKey = string | number;

/**
 * Dónde caen, en la escala de cupos, los tres estados que no son un número.
 *
 * La columna de cupos parece una columna de enteros y no lo es: tiene un
 * número medido, un cero medido, un 'sin grupos' y un 'nunca se preguntó'.
 * Meterlos todos en el mismo cero —que es lo fácil— junta cosas que dicen
 * lo contrario entre sí.
 *
 * El criterio del orden no es "cuántos cupos hay" sino **qué tan posible es
 * entrar**, que es la pregunta con la que alguien mira esta columna:
 *
 *   —  sin grupos        lo peor: no hay ni oferta que se pueda llenar
 *   0  medido y lleno    hay grupos; podrían liberarse
 *   ?  sin consultar     no se sabe, y podrían ser cien
 *   1+ el número
 *
 * Por eso son negativos y no `null`: así son un punto de la misma recta y el
 * descendente sale exactamente invertido del ascendente, sin casos aparte.
 */
export const SEATS_RANK = {
  /** '—' · se preguntó y no hay grupos programados. */
  noOffer: -3,
  /** '0' · hay grupos y están llenos. */
  full: -2,
  /** '?' · nadie le ha preguntado al SIA todavía. */
  unknown: -1,
} as const;

/** Misma columna → invierte. Otra columna → empieza ascendente. */
export function toggleSort<K extends string>(cur: Sort<K> | null, col: K): Sort<K> {
  return cur?.col === col ? { col, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' };
}

/**
 * `Array.prototype.sort` es estable desde ES2019, así que los empates conservan
 * el orden en que venían — que en el catálogo es el del SIA, y es lo que hace
 * que ordenar por créditos no revuelva los nombres dentro de cada grupo.
 */
export function sortBy<T>(items: readonly T[], keyOf: (t: T) => SortKey, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    // 'es' con sensitivity base: 'Álgebra' cae junto a 'Algebra' y no al final
    // del alfabeto, que es donde lo mandaría comparar por código de carácter.
    return String(x).localeCompare(String(y), 'es', { sensitivity: 'base' }) * sign;
  });
}

/**
 * La clave de orden de una materia de la lista del semestre, por columna.
 *
 * Vive acá y no en una vista porque Mi semestre y Mi horario pintan la misma
 * tabla sobre las mismas filas: teniéndola dos veces, ordenar por cupos podía
 * significar dos cosas distintas según desde dónde se pulsara.
 *
 * Misma escala de cupos que el catálogo: los cuatro estados en una recta.
 */
export function courseSortKey(r: Row, col: TableCol): SortKey {
  switch (col) {
    case 'code':
      return r.item.code;
    case 'name':
      return r.item.name;
    case 'typology':
      return r.item.typology;
    case 'credits':
      return r.item.credits;
    case 'seats': {
      if (!r.detail) return SEATS_RANK.unknown;
      if (r.detail.sections.length === 0) return SEATS_RANK.noOffer;
      const n = r.detail.sections.reduce((sum, sec) => sum + (sec.seats?.available ?? 0), 0);
      return n === 0 ? SEATS_RANK.full : n;
    }
  }
}
