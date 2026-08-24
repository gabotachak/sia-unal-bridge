import { createContext, type Dispatch, type SetStateAction } from 'react';
import type { AvailabilityFilter } from '../lib/availability';

export type CatalogFiltersApi = {
  q: string;
  setQ: Dispatch<SetStateAction<string>>;
  typols: ReadonlySet<string>;
  setTypols: Dispatch<SetStateAction<ReadonlySet<string>>>;
  creds: ReadonlySet<number>;
  setCreds: Dispatch<SetStateAction<ReadonlySet<number>>>;
  /** Códigos de plan elegidos, solo con doble titulación (D6). */
  progs: ReadonlySet<string>;
  setProgs: Dispatch<SetStateAction<ReadonlySet<string>>>;
  onlyOpen: boolean;
  setOnlyOpen: Dispatch<SetStateAction<boolean>>;
  /** Oculta las materias que chocan en horario con un grupo ya elegido en
   *  Mi horario, en vez de solo destacarlas (issue #28). */
  hideConflicts: boolean;
  setHideConflicts: Dispatch<SetStateAction<boolean>>;
  /** Días + rango horario elegidos — "cuándo puedo tomar clase". `days`
   *  vacío = filtro apagado, no "disponible en ningún horario". Vive como
   *  una fila más de `showFacets`, no con su propio toggle: es un filtro
   *  igual que tipología o créditos. */
  availability: AvailabilityFilter;
  setAvailability: Dispatch<SetStateAction<AvailabilityFilter>>;
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
