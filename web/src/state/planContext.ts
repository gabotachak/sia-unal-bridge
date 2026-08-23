import { createContext } from 'react';
import { MAX_ITEMS, MAX_PLANS } from '../lib/storage';
import type { PlanItem, Selection } from '../lib/storage';

export { MAX_ITEMS, MAX_PLANS };

export type PlanApi = {
  items: PlanItem[];
  has: (id: string) => boolean;
  add: (item: Omit<PlanItem, 'addedAt'>) => boolean;
  remove: (id: string) => void;
  clear: () => void;
  full: boolean;

  /** El primer plan, o null si todavía no se eligió ninguno. Mismo
   *  significado de siempre para quien tiene un plan solo (D1). */
  selection: Selection | null;

  /** Mis planes, en orden de elección. 1 o 2 (o 0 antes de elegir). No hay
   *  "plan activo" (D2): con el catálogo unido no existe la pregunta de cuál
   *  se está mirando. */
  plans: Selection[];
  /** Si `s` es uno de mis planes. */
  owns: (s: Pick<Selection, 'level' | 'campus' | 'program'>) => boolean;
  /**
   * Fija el conjunto de planes. Uno o dos, de una sola vez (D4): no hay
   * "agregar un segundo plan" ni "quitar uno" en caliente.
   *
   * Mismo conjunto que ya estaba ⇒ no borra nada (es volver al tablero).
   * Conjunto distinto ⇒ borra el semestre entero, como hoy; quien llama ya
   * confirmó. Devuelve `false` y no toca nada si los dos planes no
   * comparten sede y nivel (D3), o si son más de MAX_PLANS.
   */
  select: (next: Selection[]) => boolean;
};

// El contexto vive en su propio archivo .ts —sin JSX— porque un archivo que
// exporta componentes debe exportar SOLO componentes: es lo que necesita el
// recargado en caliente de Vite para no perder el hilo.
export const PlanContext = createContext<PlanApi | null>(null);
