// Persistencia en el navegador.
//
// localStorage es un mapa de texto a texto que sobrevive a recargas y a cerrar
// la pestaña. Es lo único que necesita esta app: no hay login ni servidor de
// preferencias, y la lista del semestre es de quien tiene el navegador abierto.

/** Todo bajo una clave con versión: si mañana cambia la forma, se sube a v2
 *  y los datos viejos se ignoran solos en vez de romper la página. */
const KEY = 'tablero.semestre.v2';

/** El plan elegido, formato viejo: un solo objeto. Clave aparte de la lista:
 *  son dos cosas con vidas distintas —el plan se elige una vez, la lista
 *  cambia todo el tiempo— y guardarlas juntas obligaría a reescribir el plan
 *  en cada agregado. Se sigue LEYENDO —es el seguro de rollback de la
 *  doble titulación, ver PLAN-DOUBLE-TITULATION.md— pero ya no se escribe. */
const PICK_KEY = 'tablero.plan.v1';

/** v2: varios planes, en orden de elección (doble titulación). Mientras
 *  `PICK_KEY` guardaba un objeto, esto guarda un array — de uno o dos. */
const PLANS_KEY = 'tablero.planes.v2';

/** Doble titulación: dos planes, nunca más. La casilla del picker lo dice
 *  literalmente. Sube a N cambiando esto si algún día aparece el caso. */
export const MAX_PLANS = 2;

/** Tope de materias en el semestre. Es un presupuesto de mediciones contra
 *  el SIA —una petición de detalle por materia, pool de 4—, no una cuota
 *  académica: no depende de cuántos planes haya. */
export const MAX_ITEMS = 20;

/** El orden de cada tabla. Ver loadSort. */
const SORT_KEY = 'tablero.orden.v1';

/** El grupo elegido por materia en Horario. Ver loadScheduleSelection. */
const SCHEDULE_KEY = 'tablero.horario.v1';

/** El ancho del panel de materias en Horario, si alguien lo arrastró.
 *  Ver loadScheduleListWidth. */
const SCHEDULE_WIDTH_KEY = 'tablero.horario.ancho.v1';

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
    const valid = parsed.filter(
      (x): x is PlanItem =>
        x &&
        typeof x.code === 'string' &&
        typeof x.level === 'string' &&
        typeof x.campus === 'string' &&
        typeof x.program === 'string',
    );
    // Cinturón de la invariante (PLAN-DOUBLE-TITULATION.md): una materia, una
    // sola fila, aunque hayan quedado dos `code` iguales guardados a mano o
    // por una versión futura. No debería disparar nunca — `add()` ya lo
    // impide en origen.
    const seen = new Set<string>();
    const deduped: PlanItem[] = [];
    for (const item of valid) {
      if (seen.has(item.code)) continue;
      seen.add(item.code);
      deduped.push(item);
    }
    return deduped;
  } catch {
    return [];
  }
}

export function savePlan(items: PlanItem[]): void {
  try {
    // Lista vacía = clave borrada, no `[]` guardado. Empezar de nuevo tiene que
    // dejar el navegador como estaba antes de la primera visita.
    if (items.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Cuota llena o modo privado: no vale la pena romper la app por esto.
  }
}

/**
 * Agregar una materia al semestre, con las dos reglas que no dependen de
 * React: el tope de materias, y la invariante de la doble titulación — una
 * asignatura, un plan (D7, PLAN-DOUBLE-TITULATION.md). Rechaza por `code`,
 * NO por `itemId`: comparar por `itemId` dejaría entrar la misma asignatura
 * una vez por cada plan, que es justo lo que hay que impedir.
 *
 * `null` = no se agregó (lleno, o el código ya está desde cualquier plan).
 * Pura y testeable: `now` entra por parámetro en vez de leer `Date.now()`.
 */
export function addToPlan(
  items: readonly PlanItem[],
  item: Omit<PlanItem, 'addedAt'>,
  now: number,
): PlanItem[] | null {
  if (items.length >= MAX_ITEMS) return null;
  if (items.some((i) => i.code === item.code)) return null;
  return [...items, { ...item, addedAt: now }];
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

/** Los nombres de uno o dos planes en una frase: "Ingeniería" o "Ingeniería
 *  y Matemáticas". Un solo formateador para toda la app —Topbar, PlanPicker,
 *  Program— en vez de reescribir el `.join(' y ')` en cada sitio. */
export function planNames(plans: readonly Pick<Selection, 'programName'>[]): string {
  return plans.map((p) => p.programName).join(' y ');
}

/** Los códigos de uno o dos planes, para el chip y el eyebrow: "2A74" o
 *  "2A74 · 2B10". */
export function planCodes(plans: readonly Pick<Selection, 'program'>[]): string {
  return plans.map((p) => p.program).join(' · ');
}

/** Valida un valor cualquiera como Selection — campo por campo, nunca
 *  confiando en lo guardado. Compartida por `loadSelection` (v1, un objeto)
 *  y `loadPlans` (v2, un array de esto mismo). Los nombres son decoración:
 *  si faltan se cae al código, que siempre está. */
function parseSelection(x: unknown): Selection | null {
  if (!x || typeof x !== 'object') return null;
  const s = x as Record<string, unknown>;
  if (
    typeof s.level !== 'string' ||
    typeof s.campus !== 'string' ||
    typeof s.program !== 'string'
  ) {
    return null;
  }
  return {
    level: s.level,
    campus: s.campus,
    campusName: typeof s.campusName === 'string' ? s.campusName : s.campus,
    faculty: typeof s.faculty === 'string' ? s.faculty : '',
    facultyName: typeof s.facultyName === 'string' ? s.facultyName : '',
    program: s.program,
    programName: typeof s.programName === 'string' ? s.programName : s.program,
  };
}

export function loadSelection(): Selection | null {
  try {
    const raw = localStorage.getItem(PICK_KEY);
    return raw ? parseSelection(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * Los planes elegidos, en orden de elección (doble titulación:
 * PLAN-DOUBLE-TITULATION.md). Reglas, en este orden:
 *
 *  1. Si la clave v2 EXISTE, manda ella sola — sin mirar la v1, aunque
 *     termine vacía tras validar. Cada plan se valida campo por campo.
 *  2. Se deduplica por `selectionId` y se recorta a MAX_PLANS.
 *  3. Si no hay v2 pero sí v1: se migra a `[loadSelection()]` y se ESCRIBE
 *     la v2 — pero la v1 se deja donde está, intacta: es el seguro de
 *     rollback (ver "Compatibilidad" en el plan). Ya no se vuelve a escribir
 *     nunca desde acá.
 *  4. Sin nada: `[]`.
 */
export function loadPlans(): Selection[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(PLANS_KEY);
  } catch {
    raw = null;
  }

  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const list = Array.isArray(parsed) ? parsed : [];
    const valid = list.map(parseSelection).filter((s): s is Selection => s !== null);
    const deduped: Selection[] = [];
    for (const s of valid) {
      if (!deduped.some((d) => selectionId(d) === selectionId(s))) deduped.push(s);
    }
    return deduped.slice(0, MAX_PLANS);
  }

  const v1 = loadSelection();
  if (v1) {
    savePlans([v1]);
    return [v1];
  }
  return [];
}

export function savePlans(plans: Selection[]): void {
  try {
    if (plans.length === 0) localStorage.removeItem(PLANS_KEY);
    else localStorage.setItem(PLANS_KEY, JSON.stringify(plans));
  } catch {
    // Cuota llena o modo privado: no vale la pena romper la app por esto.
  }
}

/** D3: los dos planes de una doble titulación son de la misma sede y del
 *  mismo nivel — no es una suposición, así que se hace cumplir acá en vez
 *  de confiar en que la interfaz nunca deje elegir otra cosa. */
function sameCampusAndLevel(a: Selection, b: Selection): boolean {
  return a.level === b.level && a.campus === b.campus;
}

/** Qué le pasa al semestre al fijar un conjunto de planes (D4):
 *
 *   'keep'   → el MISMO conjunto que ya estaba: no se toca nada. Pasa cada
 *              vez que se vuelve al tablero sin cambiar de plan.
 *   'filter' → no había NINGÚN plan elegido todavía: no es un cambio, así
 *              que no se borra todo — se descartan solo las materias que no
 *              son de ninguno de los planes nuevos (pueden haber quedado de
 *              antes, o de un `localStorage` viejo).
 *   'wipe'   → conjunto distinto de verdad: el semestre se reinicia entero.
 */
export type SelectOutcome = 'keep' | 'filter' | 'wipe';

/**
 * `null` = el conjunto no es válido —vacío, más de MAX_PLANS, o dos planes
 * que no comparten sede y nivel (D3)— y entonces no se toca nada.
 */
export function planSelection(
  current: readonly Selection[],
  next: readonly Selection[],
): SelectOutcome | null {
  if (next.length === 0 || next.length > MAX_PLANS) return null;
  if (next.length === 2 && !sameCampusAndLevel(next[0], next[1])) return null;
  const nextIds = new Set(next.map(selectionId));
  const sameSet =
    nextIds.size === current.length && current.every((p) => nextIds.has(selectionId(p)));
  if (sameSet) return 'keep';
  return current.length === 0 ? 'filter' : 'wipe';
}

/**
 * `planSelection` más lo que le pasa a `items`: el estado completo después
 * de fijar un conjunto de planes. Es lo que llama `PlanProvider.select()`,
 * separado de React para poder testearlo sin montar nada.
 *
 * `null` = el conjunto no era válido (mismo motivo que `planSelection`) y no
 * se toca nada.
 */
export function applySelect(
  currentPlans: readonly Selection[],
  currentItems: readonly PlanItem[],
  nextPlans: Selection[],
): { plans: Selection[]; items: PlanItem[] } | null {
  const outcome = planSelection(currentPlans, nextPlans);
  if (!outcome) return null;
  if (outcome === 'wipe') return { plans: nextPlans, items: [] };
  if (outcome === 'filter') {
    const ids = new Set(nextPlans.map(selectionId));
    return { plans: nextPlans, items: currentItems.filter((i) => ids.has(selectionId(i))) };
  }
  return { plans: nextPlans, items: [...currentItems] };
}

/**
 * Empezar de nuevo: borra TODO lo guardado del plan y del semestre.
 *
 * El tema no entra: es una preferencia del navegador, no del plan, y perderlo
 * al reiniciar sería un efecto secundario que nadie pidió.
 *
 * Escribe directo en vez de pasar por el estado de React a propósito. Quien
 * llama a esto recarga la página enseguida, y los efectos que persisten el
 * estado corren DESPUÉS del pintado: para cuando les tocara el turno, la
 * pestaña ya se está yendo.
 */
export function clearStored(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(PICK_KEY);
    localStorage.removeItem(PLANS_KEY);
    localStorage.removeItem(SORT_KEY);
    localStorage.removeItem(SCHEDULE_KEY);
    localStorage.removeItem(SCHEDULE_WIDTH_KEY);
  } catch {
    // Modo privado. Si no se puede escribir, tampoco había nada guardado.
  }
}

/* ── El grupo elegido por materia en Horario ────────────────────────
   itemId() → section.key. Clave aparte de la lista del semestre: son dos
   preferencias con vidas distintas —qué materias llevo vs. qué grupo elegí
   de cada una— y agregar una materia no debería tener que tocar esto. */

export type ScheduleSelection = Record<string, string>;

export function loadScheduleSelection(): ScheduleSelection {
  try {
    const raw = localStorage.getItem(SCHEDULE_KEY);
    if (!raw) return {};
    const parsed = raw ? JSON.parse(raw) : null;
    // Nunca confiar en lo guardado: puede venir de otra versión o de
    // alguien jugando con las devtools.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ScheduleSelection = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveScheduleSelection(sel: ScheduleSelection): void {
  try {
    if (Object.keys(sel).length === 0) localStorage.removeItem(SCHEDULE_KEY);
    else localStorage.setItem(SCHEDULE_KEY, JSON.stringify(sel));
  } catch {
    // Cuota llena o modo privado: no vale la pena romper la app por esto.
  }
}

/** `null` = nunca lo arrastró, o lo devolvió a su ancho original — en los
 *  dos casos el panel usa el default del hook, no un número guardado. */
export function loadScheduleListWidth(): number | null {
  try {
    const raw = localStorage.getItem(SCHEDULE_WIDTH_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function saveScheduleListWidth(remWidth: number | null): void {
  try {
    if (remWidth === null) localStorage.removeItem(SCHEDULE_WIDTH_KEY);
    else localStorage.setItem(SCHEDULE_WIDTH_KEY, String(remWidth));
  } catch {
    // Cuota llena o modo privado: no vale la pena romper la app por esto.
  }
}

/* ── El orden de las tablas ─────────────────────────────────────────
   Cómo ordenaste una tabla es una preferencia, no un estado de pantalla:
   ordenas por cupos, entras a mirar una asignatura, vuelves — y esperas
   encontrarla como la dejaste. Viviendo en `useState` se perdía al
   desmontar la vista.

   Guardado bajo UNA clave con las dos tablas dentro, y no una por tabla,
   porque son la misma preferencia con dos ámbitos: así `clearStored`
   olvida las dos de un borrado y no hay forma de dejarse una a medias.

   No va en la URL a propósito. La ficha vuelve al catálogo por un enlace
   que arma la ruta de cero, así que un `?sort=` se perdería justo en el
   caso que esto viene a arreglar; y de dónde vienes ordenando no es parte
   de la identidad del catálogo, que es lo que se copia y se pega.        */

/** Qué tabla. Son dos y cada una recuerda la suya.
 *
 *  `plan` es UNA sola preferencia para Mi semestre y Mi horario, no una por
 *  pantalla: las dos pintan la misma tabla sobre la misma lista, así que
 *  ordenarla en una y encontrarla desordenada en la otra sería el mismo
 *  desconcierto que motivó guardar el orden en primer lugar. El catálogo sí
 *  va aparte — es otra lista, con otras razones para ordenarse. */
export type SortScope = 'catalog' | 'plan';

/** Lo guardado. `col` se valida contra la tabla que la usa, no acá: este
 *  módulo no sabe qué columnas existen y no tiene por qué saberlo. */
export type StoredSort = { col: string; dir: 'asc' | 'desc' };

function readSorts(): Record<string, StoredSort> {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function loadSort(scope: SortScope): StoredSort | null {
  const v = readSorts()[scope];
  // Nunca confiar en lo guardado: puede venir de una versión con otras
  // columnas, o de alguien jugando con las devtools.
  if (!v || typeof v.col !== 'string') return null;
  return v.dir === 'asc' || v.dir === 'desc' ? { col: v.col, dir: v.dir } : null;
}

export function saveSort(scope: SortScope, sort: StoredSort | null): void {
  try {
    const all = readSorts();
    if (sort) all[scope] = sort;
    else delete all[scope];
    // Sin ninguna tabla ordenada, la clave se borra en vez de guardar `{}`:
    // volver al orden de partida tiene que dejar el navegador como estaba.
    if (Object.keys(all).length === 0) localStorage.removeItem(SORT_KEY);
    else localStorage.setItem(SORT_KEY, JSON.stringify(all));
  } catch {
    // Cuota llena o modo privado: no vale la pena romper la app por esto.
  }
}
