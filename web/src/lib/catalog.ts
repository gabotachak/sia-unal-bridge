// Unir los catálogos de uno o dos planes en una sola lista
// (PLAN-DOUBLE-TITULATION.md, D5 y D6).

import { STALE_SEATS_SECONDS } from '../api/client';
import type { CourseSummary } from '../api/types';
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
