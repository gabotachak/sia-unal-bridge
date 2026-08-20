// Exportar Mi horario a un .ics (RFC 5545), a mano — sin librería.
//
// Es un formato de texto chico y determinista: un VCALENDAR con un VTIMEZONE
// fijo para America/Bogotá (Colombia no tiene horario de verano, así que el
// offset -05:00 no cambia nunca) y un VEVENT semanal por cada sesión de cada
// grupo elegido. `ClassSession.schedule` ya trae el día de la semana y las
// horas — lo único que este archivo decide es en qué fecha cae la PRIMERA
// ocurrencia y hasta cuándo repite (`section.start_date`/`end_date`, si
// están; el SIA no siempre los trae).

import type { ClassSession, Section } from '../api/types';

export type IcsCourse = {
  code: string;
  name: string;
  section: Section;
};

/** BYDAY de RFC 5545, indexado como `ClassSession.weekday` (1 = lunes). El
 *  índice 0 no se usa — mismo truco que WEEKDAYS_LONG en lib/format.ts. */
const ICS_BYDAY = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** Bogotá es UTC-5 todo el año. Si algún día Colombia cambia esto, es la
 *  única constante que hay que tocar — el resto del archivo no asume nada
 *  más sobre el huso horario. */
const BOGOTA_UTC_OFFSET_HOURS = 5;

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

type YMD = { y: number; m: number; d: number };

function parseDate(s: string | undefined): YMD | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function parseTime(s: string): { h: number; mi: number } {
  const [h, mi] = s.split(':').map(Number);
  return { h: h || 0, mi: mi || 0 };
}

/** 1 (lunes) .. 7 (domingo), calculado en UTC para no depender del huso del
 *  navegador — es aritmética de calendario, no una hora real. */
function isoWeekday({ y, m, d }: YMD): number {
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=dom..6=sáb
  return jsDay === 0 ? 7 : jsDay;
}

/** La primera fecha >= `from` que cae en `weekday` (1=lunes..7=domingo). */
function firstOnOrAfter(from: YMD, weekday: number): YMD {
  const fromWeekday = isoWeekday(from);
  let delta = weekday - fromWeekday;
  if (delta < 0) delta += 7;
  const dt = new Date(Date.UTC(from.y, from.m - 1, from.d) + delta * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function dtLocal(date: YMD, time: { h: number; mi: number }): string {
  return `${date.y}${pad(date.m)}${pad(date.d)}T${pad(time.h)}${pad(time.mi)}00`;
}

/** `end_date` a las 23:59:59 hora Bogotá, llevado a UTC sumando el offset
 *  fijo — es lo que exige RFC 5545 §3.3.10 para UNTIL cuando DTSTART lleva
 *  TZID: tiene que quedar en UTC aunque el evento no lo esté. */
function untilUtc(end: YMD): string {
  const ms = Date.UTC(end.y, end.m - 1, end.d, 23 + BOGOTA_UTC_OFFSET_HOURS, 59, 59);
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(
    dt.getUTCHours(),
  )}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}Z`;
}

function dtStampUtc(now: Date): string {
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(
    now.getUTCHours(),
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

/** Texto de una propiedad ICS: escapa lo que RFC 5545 §3.3.11 pide antes de
 *  que un `,` o un `;` de un nombre se lea como separador de la gramática. */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Plegado de línea a 75 octetos (RFC 5545 §3.1): las líneas largas
 *  —DESCRIPTION con el enlace de Google Maps adentro, sobre todo— se parten
 *  en continuaciones que empiezan con un espacio. Cuenta bytes UTF-8, no
 *  caracteres: una tilde o una ñ pesan más de un octeto. */
function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    if (bytes + chBytes > 75) {
      out.push(current);
      current = ' ' + ch;
      bytes = 1 + chBytes;
    } else {
      current += ch;
      bytes += chBytes;
    }
  }
  out.push(current);
  return out.join('\r\n');
}

function sanitizeUid(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '-');
}

/**
 * El texto de ubicación —solo edificio y salón, tal como los trae el SIA— y
 * el enlace de Google Maps que se arma a partir de ese mismo texto.
 *
 * No hay coordenadas: el SIA no las da, así que esto es una búsqueda por
 * texto (`/maps/search/?api=1&query=`), no un pin exacto. Se le suma
 * "Universidad Nacional de Colombia" y la sede del GRUPO —`site_campus`
 * si el grupo es PEAMA, si no la sede del plan— porque un salón como
 * '206' o 'Edificio 453' sin ese contexto no ubica nada en un mapa.
 */
function locationFor(
  session: ClassSession,
  section: Section,
  planCampusName?: string,
): { text?: string; mapsUrl?: string } {
  const parts = [session.building, session.room].filter((p): p is string => !!p);
  if (parts.length === 0) return {};

  const text = parts.join(', ');
  const campusName = section.site_campus || planCampusName;
  const query = [...parts, 'Universidad Nacional de Colombia', campusName]
    .filter(Boolean)
    .join(' ');
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  return { text, mapsUrl };
}

/** Las líneas SIN plegar de un VEVENT. El plegado (`foldLine`) pasa una sola
 *  vez, al final, sobre el archivo entero (`buildIcsCalendar`) — hacerlo acá
 *  Y otra vez arriba re-pliega un bloque ya plegado como si fuera una única
 *  línea gigante y lo destroza (una `DTSTART` de 44 bytes terminaba cortada
 *  a la mitad porque el bloque completo del evento, unido con `\r\n`, sí
 *  pasaba de 75). */
function buildVEventLines(
  course: IcsCourse,
  session: ClassSession,
  now: Date,
  planCampusName?: string,
): string[] {
  const { code, name, section } = course;
  const anchor = parseDate(section.start_date) ?? { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  const firstDate = firstOnOrAfter(anchor, session.weekday);
  const start = parseTime(session.start_time);
  const end = parseTime(session.end_time);

  const uid = `${sanitizeUid(code)}-${sanitizeUid(section.key)}-${session.weekday}-${sanitizeUid(session.start_time)}@sia-bridge`;

  const rruleParts = [`FREQ=WEEKLY`, `BYDAY=${ICS_BYDAY[session.weekday]}`];
  const end_date = parseDate(section.end_date);
  if (end_date) rruleParts.push(`UNTIL=${untilUtc(end_date)}`);

  const { text: locationText, mapsUrl } = locationFor(session, section, planCampusName);

  const descriptionLines: string[] = [];
  if (section.instructor) descriptionLines.push(`Profesor: ${section.instructor}`);
  descriptionLines.push(
    `Grupo ${section.number}${section.label ? ` · ${section.label}` : ''} (${section.key})`,
  );
  if (section.shift) descriptionLines.push(`Jornada: ${section.shift}`);
  if (section.site_campus) descriptionLines.push(`Sede del grupo: ${section.site_campus}`);
  if (mapsUrl) descriptionLines.push(`Ubicación en Google Maps: ${mapsUrl}`);

  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtStampUtc(now)}`,
    `DTSTART;TZID=America/Bogota:${dtLocal(firstDate, start)}`,
    `DTEND;TZID=America/Bogota:${dtLocal(firstDate, end)}`,
    `RRULE:${rruleParts.join(';')}`,
    `SUMMARY:${escapeText(`${name} · Grupo ${section.key}`)}`,
  ];
  if (locationText) lines.push(`LOCATION:${escapeText(locationText)}`);
  if (mapsUrl) lines.push(`URL:${mapsUrl}`);
  lines.push(`DESCRIPTION:${escapeText(descriptionLines.join('\n'))}`);
  lines.push('END:VEVENT');

  return lines;
}

/**
 * El calendario entero: un VEVENT semanal por cada sesión de cada grupo
 * elegido. Puro — no toca el DOM ni localStorage, solo arma el texto. Quien
 * llama decide qué hacer con el resultado (`downloadIcsFile`, más abajo).
 *
 * `now` es una prop y no `new Date()` adentro para que esto se pueda probar
 * sin depender del reloj de quien corre el test.
 */
export function buildIcsCalendar(courses: IcsCourse[], planCampusName?: string, now: Date = new Date()): string {
  const eventLines = courses.flatMap((course) =>
    course.section.schedule.flatMap((session) => buildVEventLines(course, session, now, planCampusName)),
  );

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SIA Bridge//Mi horario//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Mi horario UNAL',
    'X-WR-TIMEZONE:America/Bogota',
    // Huso fijo: sin reglas DAYLIGHT porque Colombia no las tiene.
    'BEGIN:VTIMEZONE',
    'TZID:America/Bogota',
    'BEGIN:STANDARD',
    'DTSTART:19930101T000000',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0500',
    'TZNAME:-05',
    'END:STANDARD',
    'END:VTIMEZONE',
    ...eventLines,
    'END:VCALENDAR',
  ];

  // El plegado pasa UNA sola vez, acá, sobre cada línea lógica del archivo
  // entero — nunca antes, por línea suelta y otra vez por bloque: ver el
  // comentario de `buildVEventLines`.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** `horario-2026-2.ics` — el término sale del primer grupo con `term`; sin
 *  ninguno (lista vacía), un nombre genérico. */
export function icsFileName(courses: IcsCourse[]): string {
  const term = courses.find((c) => c.section.term)?.section.term;
  const safe = term ? term.replace(/[^A-Za-z0-9-]+/g, '-') : 'mi-horario';
  return `horario-${safe}.ics`;
}

/** Dispara la descarga en el navegador: Blob + un `<a download>` temporal.
 *  No hay backend que sirva este archivo — todo lo que necesita ya está en
 *  el cliente (ver Schedule.tsx). */
export function downloadIcsFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** `true` si el navegador puede compartir ESTE archivo puntual —no solo si
 *  existe `navigator.share`—: Safari/Chrome de escritorio a veces exponen la
 *  API pero la rechazan para `text/calendar`, así que la única respuesta que
 *  vale es la que da `canShare` con el archivo real en la mano. */
function canShareIcsFile(file: File): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  );
}

/**
 * Comparte el .ics por la hoja nativa del sistema si el navegador puede
 * —en iOS/Android esa hoja trae un "Agregar a calendario" directo, sin que
 * quien lo usa tenga que saber qué es un .ics— y si no, cae al `<a
 * download>` de siempre. Es el mismo archivo en los dos casos: un solo
 * VCALENDAR con todas las materias, nunca una materia a la vez.
 *
 * Cancelar la hoja de compartir (`AbortError`) NO cae a la descarga: quien
 * cancela dijo que no, y una descarga disparándose sola después de eso se
 * leería como que la cancelación no sirvió de nada. Cualquier OTRO error sí
 * cae a la descarga —la hoja pudo fallar por una razón ajena a la decisión
 * de quien la usa—.
 */
export async function exportIcsFile(filename: string, content: string, title: string): Promise<void> {
  const file = new File([content], filename, { type: 'text/calendar' });

  if (canShareIcsFile(file) && typeof navigator.share === 'function') {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      // Cualquier otro error: seguir abajo y caer a la descarga.
    }
  }

  downloadIcsFile(filename, content);
}

/** Heurística barata para el ÍCONO del botón, antes de tener el archivo en
 *  la mano: sin esto habría que construir el .ics en cada render solo para
 *  decidir qué dibujar. `canShareIcsFile` (arriba, con el archivo real) es
 *  la que de verdad decide qué pasa al hacer click. */
export function supportsFileShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}
