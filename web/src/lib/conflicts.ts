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
