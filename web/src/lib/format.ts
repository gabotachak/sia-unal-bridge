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
 * Segundos que faltan → '43 s', '4:47'.
 *
 * No es formatAge con otro nombre: aquélla redondea hacia abajo porque una
 * edad aproximada basta ('12 min' de antigüedad), y acá el número baja a la
 * vista de quien espera. '4 min' quieto durante sesenta segundos se lee como
 * congelado; el m:ss se mueve cada segundo y termina en cero, que es
 * justamente lo que la persona está mirando.
 */
export function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * El SIA devuelve TODO EN MAYÚSCULAS: 'INGENIERÍA AGRONÓMICA',
 * 'ÁLGEBRA LINEAL I'. Es cómo está en la base de ellos, no una decisión de
 * estilo — y pegado tal cual en una lista de 700 filas grita.
 *
 * Bajarlo entero por CSS era la solución de una línea, pero deja los nombres
 * propios en minúscula ('bogotá', 'colombia'). Esto los devuelve a caja de
 * frase: la primera letra alta y el resto bajo.
 *
 * ponytail: los números romanos se rescatan con una lista fija de tokens.
 * Solo aplica a la palabra suelta, así que 'ÁLGEBRA LINEAL II' vuelve como
 * 'Álgebra lineal II' pero 'VI' dentro de una palabra no se toca. Si algún día
 * aparece un nombre con la palabra 'vi' (de ver), saldrá como 'VI': el caso no
 * existe hoy en el catálogo y arreglarlo de verdad pide un diccionario.
 */
/* Los límites van con lookarounds y no con `\b` porque `\b` en JavaScript es
   ASCII: en 'vínculos' considera que la palabra se corta en la í, así que la v
   suelta pasaba por número romano y salía 'Vínculos' en mitad de la frase. */
const ROMAN = /(?<![\p{L}\p{N}])(i{1,3}|iv|vi{0,3}|ix|xi{0,2})(?![\p{L}\p{N}])/gu;

export function sentence(s: string): string {
  const low = s.toLocaleLowerCase('es');
  return low
    .replace(/\p{Ll}/u, (c) => c.toLocaleUpperCase('es'))
    .replace(ROMAN, (r) => r.toUpperCase());
}

/**
 * Nombres de personas. Van palabra por palabra —'PÉREZ GÓMEZ JUAN' es
 * 'Pérez Gómez Juan'— y no en caja de frase, que los dejaría como 'Pérez gómez
 * juan'. Los separadores incluyen el guion y el apóstrofo por los apellidos
 * compuestos y los D'Angelo.
 */
export function titleCase(s: string): string {
  return s
    .toLocaleLowerCase('es')
    .replace(/(^|[\s\-'’(])(\p{Ll})/gu, (_, sep: string, c: string) => sep + c.toLocaleUpperCase('es'));
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
