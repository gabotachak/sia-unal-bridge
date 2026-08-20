import { useCallback, useState } from 'react';
import { TABLE_COLS, type TableCol } from '../lib/table';
import { toggleSort, type Sort } from '../lib/sort';
import { loadSort, saveSort, type SortScope } from '../lib/storage';

/**
 * El orden de una tabla, recordado entre visitas.
 *
 * Cómo ordenaste una tabla es una preferencia y no un estado de pantalla:
 * ordenas por cupos, entras a mirar una asignatura, vuelves — y esperas
 * encontrarla como la dejaste. En `useState` a secas se perdía al desmontar
 * la vista, que es exactamente lo que pasa al navegar a la ficha.
 *
 * Cada tabla recuerda la suya: el catálogo y la lista del plan se ordenan por
 * razones distintas y no tienen por qué arrastrarse una a la otra. La lista
 * del plan es UNA tabla aunque se pinte en dos pantallas —Mi semestre y el
 * panel de Mi horario—, así que las dos comparten el ámbito `plan`; quien lo
 * reparte entre ellas es `PlanViewProvider`.
 */
export function useTableSort(scope: SortScope) {
  const [sort, setSort] = useState<Sort<TableCol> | null>(() => {
    const stored = loadSort(scope);
    if (!stored) return null;
    // La columna guardada puede ser de una versión con otras columnas. Se
    // descarta en vez de intentar ordenar por una clave que nadie sabe
    // calcular — volver sin orden es peor que romperse.
    const known = TABLE_COLS.some((c) => c.col === stored.col);
    return known ? { col: stored.col as TableCol, dir: stored.dir } : null;
  });

  const onSort = useCallback(
    (col: TableCol) => {
      const next = toggleSort(sort, col);
      setSort(next);
      saveSort(scope, next);
    },
    [sort, scope],
  );

  return { sort, onSort };
}
