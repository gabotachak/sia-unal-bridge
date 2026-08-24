/** Los ocho tonos categóricos de tokens.css, en orden. Solo distinguen una
 *  materia de otra — ver el comentario de `--course-1` en tokens.css para
 *  por qué no compiten con los cuatro colores de significado de la app. */
const COURSE_COLOR_VARS = [
  '--course-1',
  '--course-2',
  '--course-3',
  '--course-4',
  '--course-5',
  '--course-6',
  '--course-7',
  '--course-8',
];

/** El color de una materia según su posición en Mi semestre. Cicla si hay
 *  más de ocho — no debería pasar, el plan tope en diez, pero ciclar es más
 *  barato que fallar. */
export function courseColorVar(index: number): string {
  return `var(${COURSE_COLOR_VARS[index % COURSE_COLOR_VARS.length]})`;
}

/**
 * El color categórico de UN PLAN — mismo truco que `courseColorVar`, pero
 * por posición en `plan.plans` en vez de en Mi semestre. Con doble
 * titulación, cada plan se queda con un color y lo lleva SIEMPRE que su
 * código aparece (`PlanAttributionRow`, el hover de tipología y el chip
 * del plan elegido en Topbar): se reconoce cuál es cuál de un vistazo sin
 * pisar los 4 colores de significado ni la tipología, que ya usan
 * jade/musgo/ocre/óxido.
 *
 * No encontrarlo (código de un plan ajeno, D6 §5) cae al color 0: mejor un
 * color de más que uno que no aparece.
 */
export function planColorVar(program: string, plans: readonly { program: string }[]): string {
  const i = plans.findIndex((p) => p.program === program);
  return courseColorVar(i < 0 ? 0 : i);
}
