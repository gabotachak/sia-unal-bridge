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
