import { createContext } from 'react';
import type { Sort } from '../lib/sort';
import type { TableCol } from '../lib/table';

/**
 * Cómo se está MIRANDO la lista del semestre: qué se filtra y cómo se ordena.
 *
 * No es qué materias hay (eso es `PlanApi`) ni qué grupo se eligió de cada
 * una (eso es `ScheduleApi`). Es la tercera cosa que Mi semestre y Mi horario
 * comparten desde que las dos pintan la misma tabla.
 */
export type PlanViewApi = {
  /** Deja solo los grupos con cupo. No toca la selección: un grupo elegido
   *  que se queda sin cupos desaparece de la lista y sigue elegido —y sigue
   *  pintado en el calendario—, igual que antes de compartir este estado. */
  onlyOpen: boolean;
  toggleOnlyOpen: () => void;

  /** `null` = el orden en que se fueron agregando. */
  sort: Sort<TableCol> | null;
  onSort: (col: TableCol) => void;
};

// Sin JSX, misma razón que planContext.ts y scheduleContext.ts: un archivo de
// componentes debe exportar SOLO componentes para que el recargado en caliente
// de Vite no pierda el hilo.
export const PlanViewContext = createContext<PlanViewApi | null>(null);
