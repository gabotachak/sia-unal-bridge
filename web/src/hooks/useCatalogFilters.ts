import { useContext } from 'react';
import { CatalogFiltersContext, type CatalogFiltersApi } from '../state/catalogFiltersContext';

/** Los filtros del catálogo, compartidos entre visitas. Ver el error
 *  explícito de `usePlan`: mismo motivo. */
export function useCatalogFilters(): CatalogFiltersApi {
  const ctx = useContext(CatalogFiltersContext);
  if (!ctx) throw new Error('useCatalogFilters debe usarse dentro de <CatalogFiltersProvider>');
  return ctx;
}
