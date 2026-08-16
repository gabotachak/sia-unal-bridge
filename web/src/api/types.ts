// Lo que devuelve la API, escrito como tipos.
//
// Es el reflejo de internal/httpapi/openapi.yaml. Si el back cambia una ruta o
// un campo, acá es donde se toca primero y el editor marca en rojo todo lo que
// hay que seguir.

export type Level = {
  slug: string; // 'pregrado' — el ID público, estable
  name: string; // 'Pregrado' — la etiqueta del SIA
};

export type Campus = {
  code: string; // '1101'
  name: string; // 'SEDE BOGOTÁ'
};

export type Faculty = {
  code: string; // '2055'
  name: string; // 'FACULTAD DE INGENIERÍA'
};

export type Program = {
  campus_code: string;
  faculty_code: string;
  code: string; // '2A74' — NO identifica solo: se repite entre sedes
  name: string;
  campus_name: string;
  faculty_name: string;
  level: string;
  catalog_fetched_at?: string | null;
};

/** Cupos de una asignatura tal como YA están guardados: la suma de los grupos
 *  que este plan ve. Ausente si nunca se pidió el detalle — no es un cero. */
export type CourseSeats = {
  available: number;
  measured_at: string;
  sections: number;
  age_seconds: number;
};

export type CourseSummary = {
  campus_code: string;
  code: string; // '1000003-B'
  name: string;
  credits: number;
  typology: string; // literal del SIA: 'LIBRE ELECCIÓN (L)'
  description?: string;
  fetched_at: string;
  /** Cuándo se pidió el detalle desde este plan, ausente si nunca.
   *  Con esto puesto y sin `seats`, la asignatura no tiene grupos: el cero
   *  es un dato. Sin esto, nadie preguntó todavía. */
  detail_fetched_at?: string | null;
  seats?: CourseSeats;
};

export type ClassSession = {
  weekday: number; // 1 = lunes … 7 = domingo
  start_time: string; // '09:00'
  end_time: string; // '11:00'
  room?: string;
  building?: string;
};

export type Seats = {
  available: number;
  measured_at: string;
  age_seconds: number;
};

export type Section = {
  term: string; // '2026-2'
  key: string; // '1', 'AMAZ-07' — la identidad real del grupo
  number: number; // 'Grupo 1' — NO es único
  label?: string;
  instructor?: string;
  shift?: string; // 'DIURNO'
  duration?: string; // 'Semestral'
  site?: string;
  site_campus?: string;
  start_date?: string;
  end_date?: string;
  fetched_at: string;
  schedule: ClassSession[];
  seats?: Seats;
};

export type CourseDetail = CourseSummary & {
  sections: Section[];
};

// Envolturas: la API devuelve las listas dentro de un objeto con nombre.
export type LevelsResponse = { levels: Level[] };
export type CampusesResponse = { campuses: Campus[] };
export type FacultiesResponse = { faculties: Faculty[] };
export type ProgramsResponse = { programs: Program[] };
export type CoursesResponse = { courses: CourseSummary[] };

// Un candidato del 300: el mismo código bajo otra sede o facultad.
export type Candidate = {
  program: string;
  name: string;
  campus_code: string;
  campus_name: string;
  faculty_code: string;
  faculty_name: string;
};
