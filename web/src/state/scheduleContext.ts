import { createContext } from 'react';
import type { ScheduleSelection } from '../lib/storage';

export type ScheduleApi = {
  /** itemId() → section.key elegida. */
  selection: ScheduleSelection;
  /** `null` desmarca: es una selección válida, no "no hay nada que hacer". */
  pick: (itemId: string, sectionKey: string | null) => void;
};

// Sin JSX, misma razón que planContext.ts: un archivo de componentes debe
// exportar SOLO componentes para que el recargado en caliente de Vite no
// pierda el hilo.
export const ScheduleContext = createContext<ScheduleApi | null>(null);
