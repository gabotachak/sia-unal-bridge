// El filtro de disponibilidad del catálogo: "quiero materias que quepan
// lunes y miércoles después de las 12" — una preferencia de UNA persona,
// no la disponibilidad cruzada de varias como un when2meet. Por eso es
// días + un rango horario que aplica a todos esos días, no una grilla
// pintable celda por celda: nadie describió su semana así, y pintar 180
// celdas de precisión para decir "después del mediodía" es la herramienta
// equivocada para la pregunta.
//
// Vive acá y no en un componente por la misma convención que conflicts.ts:
// un archivo de componentes exporta SOLO componentes.

import type { ClassSession } from '../api/types';

/** Ventana del selector: la jornada típica del SIA, la misma que usa el
 *  calendario de Mi horario (WeekCalendar.tsx) por defecto. */
export const AVAIL_START_MIN = 6 * 60;
export const AVAIL_END_MIN = 21 * 60;
export const AVAIL_STEP_MIN = 30;

/** Lunes a sábado: el SIA programa clases los seis, domingo no existe en la
 *  práctica y agregarlo sería una opción que nadie toca nunca. */
export const AVAIL_DAYS = [1, 2, 3, 4, 5, 6];

export type AvailabilityFilter = {
  /** Vacío = cualquier día sirve — no "disponible ningún día". Elegir un
   *  rango de hora sin tocar los días de la semana es válido: filtra por
   *  hora nomás, los seis días. */
  days: ReadonlySet<number>;
  fromMin: number;
  toMin: number;
};

export const DEFAULT_AVAILABILITY: AvailabilityFilter = {
  days: new Set(),
  fromMin: AVAIL_START_MIN,
  toMin: AVAIL_END_MIN,
};

/** Activo si se tocó CUALQUIERA de las dos partes — un día marcado, o el
 *  rango angostado — no solo los días. Antes exigía un día elegido, así
 *  que angostar nada más el rango ("después de las 12, cualquier día") no
 *  hacía nada hasta que además se tocara un chip de día. */
export function isAvailabilityActive(f: AvailabilityFilter): boolean {
  return f.days.size > 0 || f.fromMin !== AVAIL_START_MIN || f.toMin !== AVAIL_END_MIN;
}

/** 'HH:MM' → minutos desde medianoche. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Las opciones del selector, cada media hora entre AVAIL_START_MIN y
 *  AVAIL_END_MIN — '06:00', '06:30', … '21:00'. */
export function availabilityTimeOptions(): { min: number; label: string }[] {
  const out: { min: number; label: string }[] = [];
  for (let min = AVAIL_START_MIN; min <= AVAIL_END_MIN; min += AVAIL_STEP_MIN) {
    const h = String(Math.floor(min / 60)).padStart(2, '0');
    const m = String(min % 60).padStart(2, '0');
    out.push({ min, label: `${h}:${m}` });
  }
  return out;
}

function sessionFits(session: ClassSession, f: AvailabilityFilter): boolean {
  if (f.days.size > 0 && !f.days.has(session.weekday)) return false;
  return toMinutes(session.start_time) >= f.fromMin && toMinutes(session.end_time) <= f.toMin;
}

/**
 * Si la materia tiene AL MENOS UN grupo cuyas sesiones caen TODAS dentro de
 * los días y el rango elegidos. Un grupo con una sola sesión fuera no
 * sirve — "lunes y miércoles después de las 12" es un compromiso con las
 * DOS clases del grupo, no con una.
 */
export function courseFitsAvailability(
  sections: readonly { schedule: readonly ClassSession[] }[],
  f: AvailabilityFilter,
): boolean {
  if (!isAvailabilityActive(f)) return true;
  return sections.some((s) => s.schedule.length > 0 && s.schedule.every((c) => sessionFits(c, f)));
}
