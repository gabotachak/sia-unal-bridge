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
 * Si CUALQUIER grupo de esta materia choca en horario con un bloque YA
 * elegido de OTRA materia (issue #28, filtro por horario del catálogo).
 *
 * A diferencia de `computeConflicts` —que compara grupos ya elegidos entre
 * sí— esto mira una materia que todavía puede no tener grupo elegido: sirve
 * para avisar en el catálogo, antes de comprometerse, que lo que se está
 * mirando no va a encajar con lo que ya se armó en Mi horario. Compara TODOS
 * los grupos, no solo uno, porque en el catálogo no hay una elección todavía
 * de la cual partir.
 */
export function courseConflictsWithChosen(
  itemId: string,
  sections: readonly { schedule: readonly ClassSession[] }[],
  chosenBlocks: readonly Block[],
): boolean {
  const otherBlocks = chosenBlocks.filter((b) => b.itemId !== itemId);
  if (otherBlocks.length === 0) return false;
  return sections.some((s) =>
    s.schedule.some((session) => otherBlocks.some((b) => overlaps(session, b.session))),
  );
}
