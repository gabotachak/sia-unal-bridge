import { createContext } from 'react';
import type { PlanItem } from '../lib/storage';

/** Tope deliberado. Es un planificador de semestre, no una lista de deseos:
 *  con más de 10, refrescar todos los cupos deja de ser un gesto barato. */
export const MAX_ITEMS = 10;

export type PlanApi = {
  items: PlanItem[];
  has: (id: string) => boolean;
  add: (item: Omit<PlanItem, 'addedAt'>) => boolean;
  remove: (id: string) => void;
  clear: () => void;
  full: boolean;
};

// El contexto vive en su propio archivo .ts —sin JSX— porque un archivo que
// exporta componentes debe exportar SOLO componentes: es lo que necesita el
// recargado en caliente de Vite para no perder el hilo.
export const PlanContext = createContext<PlanApi | null>(null);
