// Unir los catálogos de uno o dos planes en una sola lista
// (PLAN-DOUBLE-TITULATION.md, D5 y D6).

import { STALE_SEATS_SECONDS } from '../api/client';
import type { CourseDetail, CourseSeats, CourseSummary } from '../api/types';
import type { Selection } from './storage';
import { typologyRank } from './typology';

/**
 * ¿La celda de CUPOS de esta asignatura es un signo de pregunta?
 *
 * Un solo sitio para el criterio, porque hasta ahora vivía copiado en tres:
 * `sortKeyOf` (dónde cae al ordenar), `hasRoom` (si sobrevive al filtro "con
 * cupos") y la medición automática (a quién hay que preguntarle). Con tres
 * copias, tocar el umbral en una dejaba una fila con `?` que el filtro
 * escondía, o una medición que no correspondía a ningún `?` en pantalla.
 *
 * Incógnita es exactamente esto:
 *
 *   - nunca se pidió el detalle (`detail_fetched_at` ausente), o
 *   - lo que hay —los cupos si los hay, el sello del detalle si no— tiene
 *     más de STALE_SEATS_SECONDS.
 *
 * NO es incógnita "se preguntó hace poco y no tiene grupos": eso es un dato.
 */
export function seatsUnknown(c: Pick<CourseSummary, 'seats' | 'detail_fetched_at'>): boolean {
  const stamp = c.seats?.measured_at ?? c.detail_fetched_at;
  if (!stamp) return true;
  const age = (Date.now() - Date.parse(stamp)) / 1000;
  return !Number.isFinite(age) || age > STALE_SEATS_SECONDS;
}

/**
 * El agregado de cupos de una asignatura, sacado de su detalle.
 *
 * El detalle de la API NO trae `seats` a nivel de asignatura —ese campo es
 * del listado (openapi.yaml: CourseSummary sí, CourseDetail no)—, solo los
 * cupos de cada grupo. El tipo `CourseDetail` lo hereda de `CourseSummary` y
 * por eso leer `detail.seats` compila, pero siempre da `undefined`: la celda
 * pasaba de la rueda a "sin grupos" con los grupos recién medidos en la mano.
 *
 * Misma cuenta que `ProgramCourses` en el back (internal/store/course.go):
 * suma de los grupos CON medición, sello del más viejo, cuántos son. Sin
 * ningún grupo medido no hay agregado — igual que allá.
 */
export function seatsFromDetail(detail: Pick<CourseDetail, 'sections'>): CourseSeats | undefined {
  const measured = detail.sections.flatMap((s) => (s.seats ? [s.seats] : []));
  if (measured.length === 0) return undefined;
  const oldest = measured.reduce((a, b) =>
    Date.parse(a.measured_at) <= Date.parse(b.measured_at) ? a : b,
  );
  return {
    available: measured.reduce((n, s) => n + s.available, 0),
    measured_at: oldest.measured_at,
    sections: measured.length,
    age_seconds: oldest.age_seconds,
  };
}

export type MergedCourse = CourseSummary & {
  /** De qué plan salió esta fila: lo que arma su PlanItem y su itemId, y lo
   *  que se le dice a la persona (CourseCard, Course). */
  plan: Selection;
  /** El mismo código visto desde el otro plan, si estaba — con qué
   *  tipología aparece allá. Solo informativo: nunca decide nada. */
  alsoIn?: { plan: Selection; typology: string };
};

/** `a` gana si es de rango igual o mayor. En empate se queda el que ya
 *  estaba —el del plan elegido antes, porque `parts` se recorre en orden de
 *  elección— así que el desempate es estable entre cargas. */
function wins(a: CourseSummary, b: CourseSummary): boolean {
  return typologyRank(a.typology) >= typologyRank(b.typology);
}

/**
 * Une los catálogos de 1 o 2 planes. Dedup por `code` con la regla de D6: la
 * tipología de mayor rango manda, y con ella su plan.
 *
 * Con un solo plan es, en efecto, un `map`: mismo orden, mismo largo, sin
 * `alsoIn` — es lo que mantiene el catálogo idéntico a `main` para quien
 * tiene un plan.
 */
export function mergeCatalogs(
  parts: { plan: Selection; courses: CourseSummary[] }[],
): MergedCourse[] {
  // Un `Map` conserva el orden de la PRIMERA inserción de cada clave —
  // reasignarla no la mueve—, así que alcanza para el orden de salida: no
  // hace falta una lista aparte.
  const byCode = new Map<string, MergedCourse>();

  for (const { plan, courses } of parts) {
    for (const course of courses) {
      const existing = byCode.get(course.code);
      if (!existing) {
        byCode.set(course.code, { ...course, plan });
        continue;
      }
      // Ya había una fila con este código —del mismo plan (una repetición,
      // ver "La invariante" en el plan) o del otro— y hay que desempatar.
      if (wins(existing, course)) {
        if (existing.plan !== plan) existing.alsoIn = { plan, typology: course.typology };
      } else {
        byCode.set(course.code, {
          ...course,
          plan,
          alsoIn: { plan: existing.plan, typology: existing.typology },
        });
      }
    }
  }

  return [...byCode.values()];
}
