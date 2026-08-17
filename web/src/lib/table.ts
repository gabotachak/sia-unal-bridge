// Las columnas de la tabla de asignaturas.
//
// Viven acá y no en TableHead.tsx por la misma razón que las funciones de
// lib/format.ts: un archivo de componentes debe exportar SOLO componentes,
// porque el recargado en caliente de Vite trabaja por archivo y pierde el hilo
// si un archivo mezcla ambas cosas.

/**
 * En orden y en un solo sitio.
 *
 * Es la lista de la que sale el tipo `TableCol`, la que pinta la cabecera Y la
 * que usa el hook de orden para descartar una columna guardada que ya no
 * exista. Declararlas dos veces era garantizar que un día no coincidieran.
 */
export const TABLE_COLS = [
  { col: 'code', label: 'código', cls: 'col-code' },
  { col: 'name', label: 'asignatura', cls: '' },
  { col: 'typology', label: 'tip', cls: 'col-typ' },
  { col: 'credits', label: 'cr', cls: 'col-cr' },
  { col: 'seats', label: 'cupos', cls: 'col-seats' },
] as const;

export type TableCol = (typeof TABLE_COLS)[number]['col'];
