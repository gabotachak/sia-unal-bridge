// Persistencia en el navegador.
//
// localStorage es un mapa de texto a texto que sobrevive a recargas y a cerrar
// la pestaña. Es lo único que necesita esta app: no hay login ni servidor de
// preferencias, y la lista del semestre es de quien tiene el navegador abierto.

/** Todo bajo una clave con versión: si mañana cambia la forma, se sube a v2
 *  y los datos viejos se ignoran solos en vez de romper la página. */
const KEY = 'tablero.semestre.v2';

export type PlanItem = {
  level: string; // 'pregrado' — el mismo código puede existir en otro nivel
  campus: string; // '1101'
  program: string; // '2A74'
  faculty: string; // '2055' — hace falta para desambiguar el plan
  code: string; // '1000003-B'
  name: string;
  credits: number;
  typology: string;
  addedAt: number;
};

export function loadPlan(): PlanItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Nunca confiar en lo que hay guardado: puede venir de una versión vieja,
    // de otra pestaña, o de alguien jugando con las devtools.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is PlanItem =>
        x &&
        typeof x.code === 'string' &&
        typeof x.level === 'string' &&
        typeof x.campus === 'string' &&
        typeof x.program === 'string',
    );
  } catch {
    return [];
  }
}

export function savePlan(items: PlanItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Cuota llena o modo privado: no vale la pena romper la app por esto.
  }
}

/** La identidad de una materia en la lista.
 *
 *  Lleva nivel, sede y plan porque la misma asignatura vista desde dos planes
 *  distintos son dos entradas distintas: los grupos visibles dependen del plan
 *  desde el que se consulta. */
export function itemId(i: Pick<PlanItem, 'level' | 'campus' | 'program' | 'code'>): string {
  return `${i.level}/${i.campus}/${i.program}/${i.code}`;
}
