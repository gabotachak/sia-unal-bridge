import { ArrowDown, ArrowUp } from 'lucide-react';
import type { Sort } from '../lib/sort';
import { TABLE_COLS, type TableCol } from '../lib/table';

/**
 * La fila de cabeceras de la tabla de asignaturas, ahora con orden.
 *
 * Es un componente y no JSX repetido en cada vista porque el catálogo y Mi
 * semestre tienen exactamente las mismas seis columnas: teniéndolo dos veces,
 * la próxima columna que se añada en una se olvidaría en la otra — que es la
 * clase de deriva que este archivo existe para evitar.
 *
 * Deja de ser `aria-hidden`. Lo era mientras solo pintaba rótulos sobre una
 * rejilla que no es una `<table>`; ahora son controles, y un control que no se
 * puede alcanzar con el teclado no existe.
 */
export function TableHead({
  sort,
  onSort,
}: {
  /** `null` = como lo mandó el SIA, sin ordenar. */
  sort: Sort<TableCol> | null;
  onSort: (col: TableCol) => void;
}) {
  return (
    <div className="table__head">
      {TABLE_COLS.map(({ col, label, cls }) => {
        const on = sort?.col === col;
        const asc = on && sort.dir === 'asc';
        return (
          <span key={col} className={cls}>
            <button
              type="button"
              className={`table__sort ${on ? 'is-on' : ''}`}
              onClick={() => onSort(col)}
              aria-label={
                on
                  ? `Ordenado por ${label}, ${asc ? 'ascendente' : 'descendente'}. Pulsa para invertir.`
                  : `Ordenar por ${label}`
              }
            >
              {label}
              {/* La flecha ocupa sitio siempre —solo cambia de opacidad—, si no
                  el rótulo se correría al activarse el orden. */}
              {on && !asc ? (
                <ArrowDown size={12} strokeWidth={2} aria-hidden="true" />
              ) : (
                <ArrowUp size={12} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </span>
        );
      })}
      <span />
    </div>
  );
}
