import { useMemo, useRef, useState } from 'react';
import { DEFAULT_AVAILABILITY, type AvailabilityFilter } from '../lib/availability';
import { CatalogFiltersContext, type CatalogFiltersApi } from './catalogFiltersContext';

/**
 * Los filtros del catálogo (Program.tsx) y por dónde iba el scroll,
 * sobreviviendo a ir a una ficha y volver.
 *
 * Context y no `useState` local de Program: la pantalla se desmonta al
 * navegar a 'course' —no hay ruta que la mantenga viva— así que cualquier
 * estado que viva ahí adentro se pierde en el viaje. Es sesión, no
 * localStorage: alcanza con que sobreviva la navegación, no una recarga —
 * a diferencia de `useTableSort`, que si guarda entre visitas porque es una
 * preferencia, no el punto donde alguien dejó de mirar.
 */
export function CatalogFiltersProvider({ children }: { children: React.ReactNode }) {
  const [q, setQ] = useState('');
  const [typols, setTypols] = useState<ReadonlySet<string>>(new Set());
  const [creds, setCreds] = useState<ReadonlySet<number>>(new Set());
  const [progs, setProgs] = useState<ReadonlySet<string>>(new Set());
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [hideConflicts, setHideConflicts] = useState(false);
  const [availability, setAvailability] = useState<AvailabilityFilter>(DEFAULT_AVAILABILITY);
  const [showFacets, setShowFacets] = useState(false);

  // Ref y no estado: cambia en cada pixel de scroll, y CatalogFiltersProvider
  // envuelve TODA la app — un re-render por scroll ahí arriba repintaría
  // cada pantalla al pedo. Nadie necesita reaccionar a este valor, solo
  // leerlo una vez al volver.
  const scrollYRef = useRef(0);

  const api = useMemo<CatalogFiltersApi>(
    () => ({
      q,
      setQ,
      typols,
      setTypols,
      creds,
      setCreds,
      progs,
      setProgs,
      onlyOpen,
      setOnlyOpen,
      hideConflicts,
      setHideConflicts,
      availability,
      setAvailability,
      showFacets,
      setShowFacets,
      get scrollY() {
        return scrollYRef.current;
      },
      setScrollY: (y: number) => {
        scrollYRef.current = y;
      },
    }),
    [q, typols, creds, progs, onlyOpen, hideConflicts, availability, showFacets],
  );

  return <CatalogFiltersContext value={api}>{children}</CatalogFiltersContext>;
}
