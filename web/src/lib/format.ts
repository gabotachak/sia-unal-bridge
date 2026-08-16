// Funciones de formato. Viven acá y no dentro de un componente por una
// convención de React: un archivo de componentes debe exportar SOLO
// componentes, porque el recargado en caliente de Vite trabaja por archivo y
// pierde el hilo si un archivo mezcla ambas cosas.

/** Segundos → '45 s', '12 min', '3 h', '2 d'. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

/**
 * Normaliza para comparar: ignora mayúsculas y tildes.
 *
 * Sin esto, buscar 'algebra' no encuentra 'ÁLGEBRA LINEAL' — que es
 * exactamente el fallo que tiene hoy la búsqueda del back, donde el ILIKE de
 * Postgres tampoco ignora acentos.
 */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}
