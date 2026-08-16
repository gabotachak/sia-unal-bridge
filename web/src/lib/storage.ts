// Persistencia en el navegador.
//
// localStorage es un mapa de texto a texto que sobrevive a recargas y a cerrar
// la pestaña. Es lo único que necesita esta app: no hay login ni servidor de
// preferencias, y la lista del semestre es de quien tiene el navegador abierto.

/** Todo bajo una clave con versión: si mañana cambia la forma, se sube a v2
 *  y los datos viejos se ignoran solos en vez de romper la página. */
const KEY = 'tablero.semestre.v2';

/** El plan elegido. Clave aparte de la lista: son dos cosas con vidas
 *  distintas —el plan se elige una vez, la lista cambia todo el tiempo— y
 *  guardarlas juntas obligaría a reescribir el plan en cada agregado. */
const PICK_KEY = 'tablero.plan.v1';

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

/**
 * El plan elegido: dónde estudia quien usa esto.
 *
 * Se pregunta una sola vez. A partir de ahí el tablero abre directo en el
 * catálogo de este plan, y las pantallas de nivel/sede solo se vuelven a ver
 * si se pide cambiar de plan a propósito.
 *
 * Lleva los nombres además de los códigos porque el raíl los muestra y no
 * vale la pena pedir el directorio entero de la sede para pintar un rótulo.
 */
export type Selection = {
  level: string; // 'pregrado'
  campus: string; // '1101'
  campusName: string;
  faculty: string; // '2055'
  facultyName: string;
  program: string; // '2A74'
  programName: string;
};

/** La identidad de un plan. Sin la sede no identifica: el mismo código de plan
 *  se repite entre sedes (136 colisiones de 852).
 *
 *  La facultad NO entra, a propósito. Dentro de una sede el código ya no
 *  colisiona, y la facultad viaja en la query (`?f=`), que se puede perder al
 *  pegar una URL a mano: incluirla haría que el mismo plan pareciera dos. Es
 *  la misma clave que usa itemId(). */
export function selectionId(s: Pick<Selection, 'level' | 'campus' | 'program'>): string {
  return `${s.level}/${s.campus}/${s.program}`;
}

export function loadSelection(): Selection | null {
  try {
    const raw = localStorage.getItem(PICK_KEY);
    if (!raw) return null;
    const x = JSON.parse(raw);
    if (
      !x ||
      typeof x.level !== 'string' ||
      typeof x.campus !== 'string' ||
      typeof x.program !== 'string'
    ) {
      return null;
    }
    // Los nombres son decoración: si faltan se cae al código, que siempre está.
    return {
      level: x.level,
      campus: x.campus,
      campusName: typeof x.campusName === 'string' ? x.campusName : x.campus,
      faculty: typeof x.faculty === 'string' ? x.faculty : '',
      facultyName: typeof x.facultyName === 'string' ? x.facultyName : '',
      program: x.program,
      programName: typeof x.programName === 'string' ? x.programName : x.program,
    };
  } catch {
    return null;
  }
}

export function saveSelection(s: Selection | null): void {
  try {
    if (s) localStorage.setItem(PICK_KEY, JSON.stringify(s));
    else localStorage.removeItem(PICK_KEY);
  } catch {
    // Cuota llena o modo privado: no vale la pena romper la app por esto.
  }
}

/** La ruta del catálogo de un plan. Un solo sitio la arma, porque la escriben
 *  el raíl, la redirección de la raíz y los avisos de cambio de plan. */
export function selectionPath(
  s: Pick<Selection, 'level' | 'campus' | 'faculty' | 'program'>,
): string {
  const q = s.faculty ? `?f=${s.faculty}` : '';
  return `/nivel/${s.level}/sede/${s.campus}/plan/${s.program}${q}`;
}
