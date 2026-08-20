import { createContext, type Dispatch, type SetStateAction } from 'react';

export type CatalogFiltersApi = {
  q: string;
  setQ: Dispatch<SetStateAction<string>>;
  typols: ReadonlySet<string>;
  setTypols: Dispatch<SetStateAction<ReadonlySet<string>>>;
  creds: ReadonlySet<number>;
  setCreds: Dispatch<SetStateAction<ReadonlySet<number>>>;
  onlyOpen: boolean;
  setOnlyOpen: Dispatch<SetStateAction<boolean>>;
  /** Oculta las materias que chocan en horario con un grupo ya elegido en
   *  Mi horario, en vez de solo destacarlas (issue #28). */
  hideConflicts: boolean;
  setHideConflicts: Dispatch<SetStateAction<boolean>>;
  showFacets: boolean;
  setShowFacets: Dispatch<SetStateAction<boolean>>;
  /** Dónde estaba el scroll cuando se salió del catálogo hacia una ficha. */
  scrollY: number;
  setScrollY: (y: number) => void;
};

// Sin JSX, misma razón que planContext.ts: un archivo de componentes debe
// exportar SOLO componentes para que el recargado en caliente de Vite no
// pierda el hilo.
export const CatalogFiltersContext = createContext<CatalogFiltersApi | null>(null);
