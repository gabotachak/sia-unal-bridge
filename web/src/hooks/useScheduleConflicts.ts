import { useMemo } from 'react';
import type { Row } from './useCourseDetails';
import { computeConflicts, type Block } from '../lib/conflicts';
import { itemId, type ScheduleSelection } from '../lib/storage';

/**
 * Qué grupos elegidos chocan entre sí, a partir de los mismos `rows` que ya
 * trae `useCourseDetails` y la misma `selection` de `useScheduleSelection`.
 *
 * Compartido entre Mi semestre (que solo necesita `conflicts` para pintar
 * `.slot.is-conflict`) y Mi horario (que además usa `chosen` para armar los
 * bloques del calendario) — la única diferencia es qué parte del resultado
 * usa cada pantalla.
 */
export function useScheduleConflicts(rows: Row[], selection: ScheduleSelection) {
  const chosen = useMemo(
    () =>
      rows.flatMap((row) => {
        const id = itemId(row.item);
        const key = selection[id];
        const section = key ? row.detail?.sections.find((s) => s.key === key) : undefined;
        return section ? [{ row, id, section }] : [];
      }),
    [rows, selection],
  );

  const blocksRaw: Block[] = useMemo(
    () =>
      chosen.flatMap(({ id, section }) =>
        section.schedule.map((session) => ({ itemId: id, sectionKey: section.key, session })),
      ),
    [chosen],
  );

  const conflicts = useMemo(() => computeConflicts(blocksRaw), [blocksRaw]);

  return { chosen, conflicts };
}
