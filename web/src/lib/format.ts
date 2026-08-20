// Funciones de formato. Viven acá y no dentro de un componente por una
// convención de React: un archivo de componentes debe exportar SOLO
// componentes, porque el recargado en caliente de Vite trabaja por archivo y
// pierde el hilo si un archivo mezcla ambas cosas.

import type { ClassSession } from '../api/types';

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

/** Días de la semana, 1-indexado como `ClassSession.weekday` (1 = lunes).
 *  El índice 0 no se usa — queda vacío para que `WEEKDAYS_LONG[weekday]`
 *  lea directo sin restar uno en cada sitio que lo consulta. */
export const WEEKDAYS_LONG = [
  '',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
  'domingo',
];
export const WEEKDAYS_SHORT = ['', 'lu', 'ma', 'mi', 'ju', 'vi', 'sa', 'do'];

/** '11:00' → '11', '11:30' → '11:30'. En punto no hace falta escribir el
 *  minuto — es la misma regla que un reloj análogo, que a las 11 en punto
 *  no dibuja el minutero apuntando al doce. */
export function formatClockTime(t: string): string {
  const [h, m] = t.split(':');
  const hour = String(Number(h));
  return m === '00' ? hour : `${hour}:${m}`;
}

/**
 * El horario de un grupo, compacto: une los días que caen EXACTAMENTE a la
 * misma hora en una sola entrada — 'lu 11:00–13:00 · mi 11:00–13:00' se lee
 * 'lu · mi 11-13' — y recorta los minutos en punto (`formatClockTime`).
 *
 * Agrupa por el par (inicio, fin), no por adyacencia en la lista: un
 * horario lu/mi/vi donde el miércoles cae distinto dos días iguales
 * separados por uno distinto igual se unen. Un día que no repite el
 * horario de los demás se queda con el suyo aparte — nunca se fuerza la
 * agrupación con un horario que no es el mismo.
 */
export function formatScheduleSummary(sessions: ClassSession[]): string {
  const order: string[] = [];
  const groups = new Map<string, { start: string; end: string; days: number[] }>();

  for (const s of sessions) {
    const key = `${s.start_time}-${s.end_time}`;
    let group = groups.get(key);
    if (!group) {
      group = { start: s.start_time, end: s.end_time, days: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.days.push(s.weekday);
  }

  return order
    .map((key) => {
      const g = groups.get(key)!;
      const days = g.days.map((d) => WEEKDAYS_SHORT[d]).join(' · ');
      return `${days} ${formatClockTime(g.start)}–${formatClockTime(g.end)}`;
    })
    .join(' · ');
}

export type ScheduleGroup = {
  days: string;
  time: string;
  place?: string;
};

/**
 * La versión sin comprimir de `formatScheduleSummary`, para el tooltip: días
 * completos ('lunes · miércoles', no 'lu · mi'), la hora sin recortar el
 * minuto en punto, y el salón — que el resumen de la fila ni carga, porque
 * ahí no cabe. Misma agrupación por (inicio, fin) que la de arriba, así que
 * las dos cuentan la misma historia a dos resoluciones distintas.
 */
export function groupSchedule(sessions: ClassSession[]): ScheduleGroup[] {
  const order: string[] = [];
  const groups = new Map<
    string,
    { start: string; end: string; days: number[]; room?: string; building?: string }
  >();

  for (const s of sessions) {
    const key = `${s.start_time}-${s.end_time}`;
    let group = groups.get(key);
    if (!group) {
      group = { start: s.start_time, end: s.end_time, days: [], room: s.room, building: s.building };
      groups.set(key, group);
      order.push(key);
    }
    group.days.push(s.weekday);
  }

  return order.map((key) => {
    const g = groups.get(key)!;
    const place = [g.building, g.room].filter(Boolean).join(' · ');
    return {
      days: g.days.map((d) => WEEKDAYS_LONG[d]).join(' · '),
      time: `${g.start}–${g.end}`,
      place: place || undefined,
    };
  });
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
