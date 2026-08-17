// La ÚNICA puerta a la API. Ningún otro archivo hace fetch.
//
// Es el mismo principio que los puertos del back: si mañana cambia la forma de
// hablar con el servidor, se cambia acá y nada más.

import type { Candidate } from './types';

/** Lo que la API dice sobre la frescura de cada respuesta. */
export type Freshness = {
  /** 'hit' = salió de Postgres. 'miss' = costó una consulta al SIA. */
  cache: 'hit' | 'miss' | null;
  /** Segundos desde que se midió el dato más viejo de la respuesta. */
  age: number;
  /** Cuántos segundos la API considera fresco este recurso. */
  maxAge: number;
  /** Solo en un miss: cuánto tardó el SIA. */
  siaMs: number;
};

export type Result<T> = {
  data: T;
  freshness: Freshness;
};

/**
 * Cada cuánto acepta la API un `?max_age=0` para la misma asignatura.
 *
 * Sale de FETCH_COOLDOWN, la misma variable que lee el backend (ver
 * web/vite.config.ts), así que es una PISTA para no ofrecer un botón que va a
 * rebotar — no la autoridad. La autoridad es el 429 del servidor con su
 * `retry_after_seconds`, que es quien manda cuando los dos no coinciden.
 */
export const FETCH_COOLDOWN = Number(import.meta.env.VITE_FETCH_COOLDOWN) || 300;

/** Un error de la API con su significado, no un `Error` genérico. */
export class ApiError extends Error {
  status: number;
  /** 'unknown_campus', 'sia_noop', 'ambiguous_program', … */
  code: string;
  hint?: string;
  /** Solo en un 300: las opciones entre las que hay que elegir. */
  candidates?: Candidate[];
  /** Solo en un 429: segundos que faltan para poder volver a medir. */
  retryAfter?: number;

  constructor(status: number, code: string, message: string, extra?: Partial<ApiError>) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }

  /** Texto para mostrarle a una persona, no al desarrollador. */
  get humane(): string {
    switch (this.code) {
      case 'sia_noop':
        return 'El SIA respondió vacío. Suele ser una sesión caducada del lado de ellos; reintentar casi siempre funciona.';
      case 'sia_session_lost':
        return 'Se perdió la sesión contra el SIA. Reintentar abre una nueva.';
      case 'busy':
        return 'El SIA está atendiendo otras consultas ahora mismo. Es momentáneo.';
      case 'unknown_campus':
        return 'Esa sede no existe en el catálogo del SIA.';
      case 'unknown_program':
        return 'Ese plan de estudios no existe en esta sede.';
      case 'unknown_course':
        return 'Esa asignatura no está en el catálogo de este plan.';
      case 'unknown_section':
        return 'Ese grupo no existe, o todavía no reporta cupos.';
      case 'rate_limit':
        return this.retryAfter
          ? `Esta asignatura se midió hace un momento. Se puede volver a medir en ${this.retryAfter} s.`
          : 'Esta asignatura se midió hace un momento. Hay que esperar un poco para volver a medir.';
      case 'offline':
        return 'No se pudo contactar a la API. ¿Está corriendo en el puerto 18080?';
      default:
        return this.message || 'Algo salió mal.';
    }
  }
}

// Number(null) es 0, no NaN, así que el header ausente hay que descartarlo a
// mano o un 429 sin Retry-After diría "volvé en 0 s".
function retryAfterHeader(res: Response): number | undefined {
  const raw = res.headers.get('Retry-After');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseMaxAge(header: string | null): number {
  const m = header?.match(/max-age=(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * Pide a la API y devuelve los datos JUNTO con su frescura.
 *
 * Van juntos a propósito: en esta app la edad de un dato es parte del dato.
 * Separarlos llevaría a pintar un cupo sin poder decir de cuándo es, que es
 * justo lo que el back se esfuerza en evitar.
 */
export async function get<T>(path: string): Promise<Result<T>> {
  let res: Response;
  try {
    // `cache: 'no-store'` no es paranoia: la API manda
    // `Cache-Control: max-age=604800` en el catálogo —siete días— porque para
    // ELLA eso es cierto, el catálogo casi no cambia. Pero el navegador lo
    // toma al pie de la letra y sirve el JSON de su disco sin preguntar, así
    // que una pestaña que cargó antes de que se midieran unos cupos nunca los
    // vería aparecer: ni recargar ni volver a la pestaña llegan a la red.
    //
    // Quien decide qué está fresco es el read-through del back, que ya tiene
    // el dato en Postgres y responde en milisegundos. La caché del navegador
    // encima de eso solo agrega una copia vieja que nadie puede invalidar.
    res = await fetch(`/v1${path}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    // fetch solo rechaza si la red falló: el servidor no respondió en absoluto.
    throw new ApiError(0, 'offline', 'sin conexión con la API');
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? 'internal', body?.message ?? res.statusText, {
      hint: body?.hint,
      candidates: body?.candidates,
      // El servidor es la autoridad sobre el cooldown: el front lo tiene
      // horneado en tiempo de build y puede quedar desfasado.
      retryAfter: body?.retry_after_seconds ?? retryAfterHeader(res),
    });
  }

  return {
    data: body as T,
    freshness: {
      cache: (res.headers.get('X-Cache') as Freshness['cache']) ?? null,
      age: Number(res.headers.get('Age') ?? 0),
      maxAge: parseMaxAge(res.headers.get('Cache-Control')),
      siaMs: Number(res.headers.get('X-SIA-Fetch-Ms') ?? 0),
    },
  };
}

// ── Rutas ──────────────────────────────────────────────────────────
//
// Se arman acá y no en las vistas: la sede es un segmento obligatorio de la
// URL (program.code se repite entre sedes) y el nivel condiciona TODO lo que
// cuelga de ella —el back cachea el directorio por (sede, nivel)—, así que
// ambas reglas se respetan en un solo sitio.

const enc = encodeURIComponent;

/** Arma el query string ignorando lo vacío. Evita el `?a=&b=` de concatenar a mano. */
function q(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Dónde estás parado en la cascada del SIA. */
export type Scope = {
  level: string; // slug: 'pregrado'
  campus: string; // '1101'
  faculty?: string; // '2055' — desempata la colisión intra-sede
};

export const routes = {
  levels: () => '/levels',
  campuses: (level?: string) => `/campuses${q({ level })}`,
  faculties: (s: Pick<Scope, 'level' | 'campus'>) =>
    `/campuses/${enc(s.campus)}/faculties${q({ level: s.level })}`,
  programs: (s: Scope) =>
    `/campuses/${enc(s.campus)}/programs${q({ faculty: s.faculty, level: s.level })}`,
  courses: (s: Scope, program: string) =>
    `/campuses/${enc(s.campus)}/programs/${enc(program)}/courses${q({ faculty: s.faculty, level: s.level })}`,
  course: (s: Scope, program: string, code: string, maxAge?: number) =>
    `/campuses/${enc(s.campus)}/programs/${enc(program)}/courses/${enc(code)}` +
    q({ faculty: s.faculty, level: s.level, max_age: maxAge }),
};
