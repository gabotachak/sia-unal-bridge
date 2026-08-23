// Unir los catálogos de uno o dos planes en una sola lista
// (PLAN-DOUBLE-TITULATION.md, D5 y D6).

import type { CourseSummary } from '../api/types';
import type { Selection } from './storage';
import { typologyRank } from './typology';

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
