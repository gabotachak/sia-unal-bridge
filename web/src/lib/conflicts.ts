import type { ClassSession } from '../api/types';

export type Block = {
  itemId: string;
  sectionKey: string;
  session: ClassSession;
};

/** Identidad de un bloque en el calendario: una materia solo tiene un grupo
 *  elegido, pero ese grupo puede traer varias sesiones (lunes Y miércoles). */
export function blockId(b: Block): string {
  return `${b.itemId}:${b.sectionKey}:${b.session.weekday}:${b.session.start_time}`;
}

export function overlaps(a: ClassSession, b: ClassSession): boolean {
  if (a.weekday !== b.weekday) return false;
  return a.start_time < b.end_time && b.start_time < a.end_time;
}

/**
 * Qué bloques chocan entre sí.
 *
 * Solo compara materias DISTINTAS: una materia tiene un único grupo elegido
 * (son radio buttons), así que dos sesiones de la misma materia nunca son un
 * conflicto — son la misma elección vista dos días.
 */
export function computeConflicts(blocks: Block[]): {
  conflictBlocks: Set<string>;
  conflictItems: Set<string>;
} {
  const conflictBlocks = new Set<string>();
  const conflictItems = new Set<string>();

  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i];
      const b = blocks[j];
      if (a.itemId === b.itemId) continue;
      if (!overlaps(a.session, b.session)) continue;
      conflictBlocks.add(blockId(a));
      conflictBlocks.add(blockId(b));
      conflictItems.add(a.itemId);
      conflictItems.add(b.itemId);
    }
  }

  return { conflictBlocks, conflictItems };
}

/**
 * Qué CLAVES de grupo de esta materia —elegido o no— chocan con un bloque YA
 * elegido de OTRA materia (issue #28, filtro por horario).
 *
 * A diferencia de `computeConflicts` —que solo compara grupos ya elegidos
 * entre sí— esto mira grupo por grupo de una materia que puede no tener
 * ninguno elegido todavía: sirve tanto para marcar la fila EXACTA que choca
 * en Mi semestre/Mi horario y en el detalle de la materia, como de primitiva
 * para la pregunta de nivel materia (`allSectionsConflict`).
 *
 * Es un set y no un booleano a propósito: una materia con un grupo ya
 * elegido que NO choca sigue estando bien, aunque una alternativa suya sí
 * chocaría —el grupo elegido es el único que importa una vez elegido.
 *
 * Un grupo con `schedule` vacío ("horario no informado" del SIA) nunca entra
 * al set: `some` sobre `[]` es `false`. Cuenta como servible, que es la
 * dirección conservadora —no marcar de más.
 */
export function candidateConflictKeys(
  itemId: string,
  sections: readonly { key: string; schedule: readonly ClassSession[] }[],
  chosenBlocks: readonly Block[],
): Set<string> {
  const keys = new Set<string>();
  const otherBlocks = chosenBlocks.filter((b) => b.itemId !== itemId);
  if (otherBlocks.length === 0) return keys;
  for (const s of sections) {
    if (s.schedule.some((session) => otherBlocks.some((b) => overlaps(session, b.session)))) {
      keys.add(s.key);
    }
  }
  return keys;
}

/**
 * Si a esta materia NO le queda ningún grupo servible: TODOS chocan con un
 * bloque ya elegido de OTRA materia (issue #34).
 *
 * Es la pregunta de nivel MATERIA, no de nivel grupo, y tiene la misma forma
 * que `courseFitsAvailability` en availability.ts: alcanza con que UN grupo
 * sirva para que la materia siga en pie. Antes esto era "¿choca alguno?", y
 * por eso una materia con cuatro grupos de los que uno solo chocaba salía
 * marcada como inservible —el bug de #34.
 *
 * Sin grupos que evaluar → `false`: no hay nada que avisar, y "todos chocan"
 * sobre una lista vacía sería vacuamente cierto.
 */
export function allSectionsConflict(
  itemId: string,
  sections: readonly { key: string; schedule: readonly ClassSession[] }[],
  chosenBlocks: readonly Block[],
): boolean {
  if (sections.length === 0) return false;
  return candidateConflictKeys(itemId, sections, chosenBlocks).size === sections.length;
}

/** Lo mínimo que hace falta de un grupo para clasificar la materia. */
export type SectionLike = {
  key: string;
  schedule: readonly ClassSession[];
  seats?: { available: number } | null;
};

/**
 * Cómo hay que pintar una materia en el catálogo.
 *
 *   'active'    → rojo:     el grupo que YA elegiste choca. Un bloqueo real.
 *   'potential' → amarillo: no elegiste grupo y NINGUNO te sirve.
 *   null        → nada.
 */
export type ConflictMark = 'active' | 'potential' | null;

/**
 * Un grupo sigue siendo alternativa mientras no se sepa que está lleno.
 *
 * `seats` ausente es "nadie midió", no "cero" (ver la tabla de docs/API.md):
 * descartarlo marcaría materias por un dato que no tenemos. Sin cupos
 * medidos, la materia se salva.
 */
function stillOpen(s: SectionLike): boolean {
  return !s.seats || s.seats.available > 0;
}

/**
 * Rojo, amarillo o nada para UNA materia del catálogo — toda la decisión en
 * un solo sitio, y por eso testeable caso por caso (issue #34).
 *
 * Antes esto estaba desparramado en dos ramas de un `useMemo` más un bucle
 * sobre las materias cacheadas, y esa tercera pasada podía marcar en amarillo
 * una materia que YA tenía grupo elegido y sin choque.
 *
 * El orden importa:
 *
 *  1. Sin detalle a mano no se sabe nada → nada. Falla abierto a propósito:
 *     el catálogo llega con `seats` pero sin horarios, así que "no sé" es el
 *     estado normal de la mayoría de las filas hasta que llega su detalle.
 *  2. Con grupo elegido manda ESE y solo ese: choca (rojo) o no choca (nada).
 *     Que una alternativa suya chocara no es un problema — nadie la eligió.
 *  3. Sin grupo elegido, amarillo solo si NO queda ninguno servible. Que uno
 *     de cuatro choque no es noticia: quedan tres.
 */
export function classifyConflict(input: {
  itemId: string;
  /** `undefined` = todavía no se conoce el detalle de esta materia. */
  sections: readonly SectionLike[] | undefined;
  /** La clave del grupo elegido en Mi horario, si hay. */
  pickedKey?: string | null;
  /** Todos los bloques ya elegidos, los de esta materia incluidos. */
  chosenBlocks: readonly Block[];
  /** El chip "con cupos": con él puesto, un grupo lleno no es escapatoria. */
  onlyOpen?: boolean;
}): ConflictMark {
  const { itemId, sections, pickedKey, chosenBlocks, onlyOpen = false } = input;

  if (!sections) return null;

  if (pickedKey) {
    const picked = sections.filter((s) => s.key === pickedKey);
    // Una clave elegida que ya no está entre los grupos es una elección
    // rancia (el SIA renombró el grupo): se trata como si no hubiera
    // elección en vez de dar por bueno un grupo que no existe.
    if (picked.length > 0) {
      return candidateConflictKeys(itemId, picked, chosenBlocks).size > 0 ? 'active' : null;
    }
  }

  const viable = onlyOpen ? sections.filter(stillOpen) : sections;
  // Sin grupos —o sin ninguno con cupo— no hay nada que avisar: de eso ya
  // habla la columna CUPOS y el chip "con cupos", no el aviso de horario.
  if (viable.length === 0) return null;

  return allSectionsConflict(itemId, viable, chosenBlocks) ? 'potential' : null;
}
