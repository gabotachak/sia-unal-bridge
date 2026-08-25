import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, FETCH_COOLDOWN, get, routes } from '../api/client';
import type { CourseDetail } from '../api/types';
import { formatAge, formatCountdown } from '../lib/format';
import { MAX_RETRIES, backoffMs, isTransient, sleep } from '../lib/retry';
import { pooled } from '../lib/pooled';
import { getDetail, putDetail } from '../lib/detailCache';
import { itemId, type PlanItem } from '../lib/storage';

/**
 * Cuántas peticiones en vuelo a la vez. Tiene que seguir a `SIA_POOL_SIZE`:
 * del otro lado hay ese número de sesiones ADF y cada una es estrictamente
 * secuencial, así que pedir de a más no acelera nada — las de sobra se
 * encolan en `Pool.Acquire` hasta `SIA_ACQUIRE_TIMEOUT_SECONDS` y salen 503.
 *
 * Y no puede pasarse de `RATE_LIMIT_BURST`: el limitador por IP no encola,
 * rechaza con 429 en el acto (`internal/httpapi/ratelimit.go`). Una ráfaga
 * inicial mayor que el balde se come el sobrante de una.
 *
 * Invariante, con los valores de `.env.example`:
 *
 *     CONCURRENCY ≤ SIA_POOL_SIZE  y  CONCURRENCY ≤ RATE_LIMIT_BURST
 *            32   ≤       32                32   ≤        40
 */
export const CONCURRENCY = 32;

export type Row = {
  item: PlanItem;
  detail: CourseDetail | null;
  status: 'idle' | 'loading' | 'done' | 'error';
  error?: string;
  /** El `code` del ApiError, cuando lo hay. 'unknown_course' es el caso de
   *  reconciliación (docs/PLAN-SIACHANGES.md D2): la materia se apagó del
   *  catálogo del plan y reintentar nunca la va a traer de vuelta. */
  errorCode?: string;
  /**
   * Epoch ms a partir del cual esta materia se puede volver a medir. 0 = ya.
   *
   * Es un instante y no una edad porque una edad se queda quieta: llega
   * '30 s' y sigue diciendo '30 s' cinco minutos después. El instante se
   * compara contra el reloj y no hay que refrescarlo.
   *
   * Sale de `detail.fetched_at` y no de la edad de los cupos porque es
   * exactamente lo que mira el backend (`course_program.detail_fetched_at`,
   * ver internal/httpapi/cooldown.go). Medir contra otra cosa haría que el
   * botón se encendiera un segundo antes que el permiso del servidor.
   */
  readyAt: number;
};

export type Measure = { text: string; code: string; title: string };

// Nace con lo que la sesión ya sepa de esta materia: agregarla a Mi semestre
// después de haberla mirado en el catálogo pinta sus grupos de una, sin el
// parpadeo de una fila vacía esperando una petición que no hace falta.
const newRow = (item: PlanItem): Row => {
  const known = getDetail(itemId(item)) ?? null;
  return {
    item,
    detail: known,
    status: known ? 'done' : 'idle',
    readyAt: known ? readyAtFrom(known) : 0,
  };
};

/** Cuándo vuelve a estar disponible una materia según lo que respondió la API. */
function readyAtFrom(detail: CourseDetail): number {
  const at = detail.fetched_at ? Date.parse(detail.fetched_at) : NaN;
  return Number.isFinite(at) ? at + FETCH_COOLDOWN * 1000 : 0;
}

/**
 * Trae y mantiene los grupos+cupos de una lista de materias.
 *
 * Extraído de Semester.tsx: Mi semestre y Horario piden exactamente lo
 * mismo —el detalle de cada materia de `plan.items`, con el mismo pool de
 * `CONCURRENCY` conexiones y el mismo cooldown del back— así que la lógica vive una sola
 * vez acá y cada pantalla decide cómo pintarla.
 */
export function useCourseDetails(items: PlanItem[]) {
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  // Cuántas materias terminaron en ESTA ronda. No se deriva de los status:
  // en un remedido todas entran ya en 'done' de la ronda anterior, así que
  // contarlas daría la barra llena antes de empezar.
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // La lista de materias manda: al agregar o quitar, se rearman las filas
  // conservando lo que ya se había traído.
  useEffect(() => {
    setRows((prev) =>
      items.map((item) => {
        const old = prev.find((r) => itemId(r.item) === itemId(item));
        return old ?? newRow(item);
      }),
    );
  }, [items]);

  // Acepta una función porque el caso del 429 necesita leer la fila para
  // devolverla a como estaba: no sabe desde fuera si tenía detalle o no.
  const patch = useCallback((id: string, next: Partial<Row> | ((r: Row) => Partial<Row>)) => {
    setRows((prev) =>
      prev.map((r) =>
        itemId(r.item) === id ? { ...r, ...(typeof next === 'function' ? next(r) : next) } : r,
      ),
    );
  }, []);

  /**
   * Trae los grupos de cada materia.
   *
   * `force` decide si vale lo cacheado o hay que medir de nuevo:
   *
   *  - al abrir la página: sin forzar, así aparece al instante lo que ya está
   *    en Postgres, con la edad de cada dato a la vista
   *  - con el botón: max_age=0, que obliga a la API a preguntarle al SIA
   *
   * Una petición POR MATERIA, no por grupo: el detalle trae todos los grupos
   * con sus cupos en el mismo POST, así que pedir grupo por grupo sería
   * multiplicar el trabajo del SIA por nada.
   *
   * Los errores transitorios del SIA (sesión caducada, respuesta vacía, pool
   * lleno) se reintentan silenciosamente hasta MAX_RETRIES veces con backoff
   * exponencial. El error solo se muestra si todos los intentos fallan.
   *
   * `targets` viene de fuera y no se calcula acá: con el botón son solo las
   * materias fuera del cooldown, y quien sabe cuáles son es el render, que ya
   * las cuenta para decidir si el botón se enciende.
   */
  const fetchAll = useCallback(
    async (force: boolean, targets: PlanItem[]) => {
      if (targets.length === 0) return;

      setRunning(true);
      setDone(0);
      setTotal(targets.length);
      setRows((prev) => prev.map((r) => ({ ...r, error: undefined })));

      await pooled(targets, CONCURRENCY, async (item) => {
        const id = itemId(item);
        const scope = { level: item.level, campus: item.campus, faculty: item.faculty };

        // `loading` se marca acá y no de entrada para las diez: en vuelo solo
        // hay CONCURRENCY, y apagar la lista entera decía que se estaban
        // midiendo todas cuando seis seguían en la cola. La barra ya lleva la
        // cuenta del total; esto marca quién está siendo medida AHORA. Las que
        // esperan turno siguen mostrando su número anterior, con su edad al
        // lado, que es más útil que una columna en blanco.
        patch(id, { status: 'loading' });

        try {
          let lastError: unknown;
          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            // En reintentos, forzar max_age=0: si el primer intento falló por
            // sesión caducada o respuesta vacía, repetir con cache no va a ayudar.
            const forceRetry = force || attempt > 0;
            const path = routes.course(scope, item.program, item.code, forceRetry ? 0 : undefined);
            try {
              const res = await get<CourseDetail>(path);
              // Compartido con el resto de la app: el catálogo lo usa para
              // marcar choques sin volver a pedirlo (lib/detailCache.ts).
              putDetail(id, res.data);
              patch(id, { detail: res.data, status: 'done', readyAt: readyAtFrom(res.data) });
              return; // éxito → no seguir reintentando
            } catch (e) {
              // Un 429 no es un fallo. La materia está fresca y el número que
              // ya está en pantalla es correcto: lo único que pasó es que se
              // pidió antes de tiempo. Se anota cuándo vuelve a estar
              // disponible —el servidor es la autoridad, no el FETCH_COOLDOWN
              // horneado— y la fila queda como estaba, sin banner rojo.
              //
              // Con el filtrado del botón esto no debería dispararse casi
              // nunca; queda como red: otra pestaña pudo medir hace 10 s, y un
              // reintento tras un error transitorio fuerza max_age=0 aunque la
              // ronda no fuera forzada.
              if (e instanceof ApiError && e.status === 429) {
                patch(id, (r) => ({
                  status: r.detail ? 'done' : 'idle',
                  readyAt: Date.now() + (e.retryAfter ?? FETCH_COOLDOWN) * 1000,
                }));
                return;
              }
              lastError = e;
              if (!isTransient(e) || attempt === MAX_RETRIES) break;
              await sleep(backoffMs(attempt));
            }
          }

          patch(id, {
            status: 'error',
            error: lastError instanceof ApiError ? lastError.humane : 'no se pudo consultar',
            errorCode: lastError instanceof ApiError ? lastError.code : undefined,
          });
        } finally {
          // En el finally porque el camino feliz sale por `return`: la materia
          // que falló también terminó, y la barra tiene que llegar al final.
          setDone((n) => n + 1);
        }
      });

      setRunning(false);
    },
    [patch],
  );

  // Carga inicial: lo que ya esté cacheado, que aparece al instante. Después
  // manda el botón.
  //
  // El ref es por StrictMode: en desarrollo React monta cada componente dos
  // veces a propósito, para delatar efectos mal escritos. Sin el guardia,
  // abrir la página dispararía dos rondas de peticiones.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (items.length > 0) void fetchAll(false, items);
    // Solo al montar: `items` puede cambiar después (agregar/quitar en otra
    // pestaña) y no hay que relanzar la ronda entera por eso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Qué materias se pueden medir ahora mismo.
   *
   * El botón medía las diez siempre, y las que se habían medido hacía un
   * momento volvían con un 429 que se pintaba en rojo debajo de la fila. Eso
   * decía "algo falló" cuando lo que pasaba era lo contrario: el dato estaba
   * tan fresco que no había nada que volver a preguntar.
   *
   * Ahora el cooldown se respeta antes de pedir. Las recientes ni se piden —no
   * hay error que mostrar porque no hay petición—, y si no queda ninguna
   * medible el botón se apaga y lo dice en su rótulo.
   */
  // El fallback a `items` cubre el primer render: las filas se arman en un
  // efecto, así que llegan un frame tarde, y sin esto el botón nacía apagado
  // diciendo que todo estaba recién medido antes de haber medido nada.
  const ready = rows.length > 0 ? rows.filter((r) => r.readyAt <= now).map((r) => r.item) : items;
  const waiting = rows.length - ready.length;

  // Cuándo sale del cooldown la primera materia que sigue dentro.
  const nextReadyAt = rows.reduce(
    (min, r) => (r.readyAt > now ? Math.min(min, r.readyAt) : min),
    Infinity,
  );
  const waitLeft = Number.isFinite(nextReadyAt) ? Math.max(0, Math.ceil((nextReadyAt - now) / 1000)) : 0;

  useEffect(() => {
    if (!Number.isFinite(nextReadyAt)) return;
    // Con el chip apagado hay una cuenta atrás a la vista y hay que moverla
    // cada segundo. Con alguna materia medible no hay número que mover: basta
    // un único despertar cuando la siguiente salga del cooldown, y así no se
    // gastan cientos de renders en cinco minutos para no cambiar nada.
    const delay = ready.length === 0 ? 1000 : Math.max(250, nextReadyAt - Date.now());
    const t = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(t);
    // `now` está en las dependencias a propósito: es lo que vuelve a armar el
    // temporizador después de cada tic. Sin él solo habría un disparo.
  }, [nextReadyAt, ready.length, now]);

  /**
   * Lo que dice el chip de medir, y por qué lo dice con palabras.
   *
   * El `chip__code` —el mismo hueco donde el catálogo pone cuántos filtros hay
   * puestos— dice una cosa distinta en cada estado, nunca dos a la vez:
   *
   *   apagado  → cuánto falta para que se libere la PRIMERA materia
   *   parcial  → cuántas se van a medir de verdad
   *   entero   → nada, no hay matiz que contar
   */
  const measure = useMemo(
    () =>
      running
        ? { text: `midiendo ${done}/${total}`, code: '', title: 'Preguntándole al SIA por los cupos.' }
        : ready.length === 0
          ? {
              text: 'medir cupos',
              code: formatCountdown(waitLeft),
              title: `Todas se midieron hace menos de ${formatAge(FETCH_COOLDOWN)}. El dato que ves es el mismo que traería preguntar otra vez.`,
            }
          : {
              text: 'medir cupos',
              code: waiting > 0 ? String(ready.length) : '',
              title:
                waiting > 0
                  ? `Mide ${ready.length} de ${rows.length} materias. Las otras ${waiting} se midieron hace menos de ${formatAge(FETCH_COOLDOWN)} y se dejan como están.`
                  : 'Le pregunta al SIA por los cupos de todas las materias de la lista.',
            },
    [running, done, total, ready.length, waiting, waitLeft, rows.length],
  );

  return { rows, running, done, total, ready, waiting, waitLeft, measure, fetchAll };
}
