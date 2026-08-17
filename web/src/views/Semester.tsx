import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Clock, Eraser, Filter, RefreshCw, Trash2, User } from 'lucide-react';
import { ApiError, FETCH_COOLDOWN, get, routes } from '../api/client';
import type { CourseDetail } from '../api/types';
import { usePlan } from '../hooks/usePlan';
import { formatAge, titleCase } from '../lib/format';
import { pooled } from '../lib/pooled';
import { MAX_RETRIES, backoffMs, isTransient, sleep } from '../lib/retry';
import { itemId, selectionPath, type PlanItem } from '../lib/storage';
import { Layout } from '../components/Layout';
import { useConfirm } from '../components/Confirm';
import { IconButton } from '../components/IconButton';
import { Empty } from '../components/States';
import './Semester.css';

/** El pool del back son 4 sesiones ADF. Pedir de a más no acelera nada. */
const CONCURRENCY = 4;

const DAYS_SHORT = ['', 'lu', 'ma', 'mi', 'ju', 'vi', 'sa', 'do'];

type Row = {
  item: PlanItem;
  detail: CourseDetail | null;
  status: 'idle' | 'loading' | 'done' | 'error';
  error?: string;
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

const newRow = (item: PlanItem): Row => ({
  item,
  detail: null,
  status: 'idle',
  readyAt: 0,
});

/** Cuándo vuelve a estar disponible una materia según lo que respondió la API. */
function readyAtFrom(detail: CourseDetail): number {
  const at = detail.fetched_at ? Date.parse(detail.fetched_at) : NaN;
  return Number.isFinite(at) ? at + FETCH_COOLDOWN * 1000 : 0;
}

export function Semester() {
  const plan = usePlan();
  const [ask, confirmDialog] = useConfirm();
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(false);
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
      plan.items.map((item) => {
        const old = prev.find((r) => itemId(r.item) === itemId(item));
        return old ?? newRow(item);
      }),
    );
  }, [plan.items]);

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
    if (plan.items.length > 0) void fetchAll(false, plan.items);
  }, [plan.items, fetchAll]);

  /**
   * Vaciar la lista sin tocar el plan.
   *
   * Antes la única forma de empezar de cero era cambiar de plan y volver, que
   * es una operación mucho más grande —y que además obligaba a pasar por el
   * selector dos veces— para conseguir esto. Son dos decisiones distintas:
   * "ya no quiero estas materias" no es "me cambié de carrera".
   *
   * Con confirmación porque borra trabajo y no hay deshacer.
   */
  async function clearAll() {
    const n = plan.items.length;
    if (n === 0) return;
    const ok = await ask({
      title: 'Vaciar Mi semestre',
      danger: true,
      confirmLabel: 'Vaciar la lista',
      body: (
        <>
          <p>Se quita {n === 1 ? 'la materia' : `las ${n} materias`} de la lista.</p>
          <p>
            Tu plan sigue siendo el mismo, así que puedes volver a agregarlas desde el catálogo.
          </p>
        </>
      ),
    });
    if (!ok) return;
    plan.clear();
  }

  const totals = summarize(rows);
  const empty = plan.items.length === 0;

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
  // El fallback a plan.items cubre el primer render: las filas se arman en un
  // efecto, así que llegan un frame tarde, y sin esto el botón nacía apagado
  // diciendo que todo estaba recién medido antes de haber medido nada.
  const ready =
    rows.length > 0 ? rows.filter((r) => r.readyAt <= now).map((r) => r.item) : plan.items;
  const waiting = rows.length - ready.length;

  // Despertar justo cuando la primera materia salga del cooldown, en vez de un
  // intervalo de 1 s corriendo cinco minutos para no hacer nada 299 veces.
  // Cada disparo mueve `now` más allá de un readyAt, así que la cadena avanza
  // materia por materia y se agota sola.
  const nextReadyAt = rows.reduce(
    (min, r) => (r.readyAt > now ? Math.min(min, r.readyAt) : min),
    Infinity,
  );
  useEffect(() => {
    if (!Number.isFinite(nextReadyAt)) return;
    const t = window.setTimeout(() => setNow(Date.now()), Math.max(250, nextReadyAt - Date.now()));
    return () => window.clearTimeout(t);
  }, [nextReadyAt]);

  // Sin cuenta atrás a propósito: un número en un tooltip que solo se refresca
  // al abrirlo miente más de lo que informa, y el cooldown no es una espera
  // que haya que vigilar.
  const measureLabel = running
    ? `Midiendo ${done}/${total}…`
    : ready.length === 0
      ? `Todas se midieron hace menos de ${formatAge(FETCH_COOLDOWN)}`
      : waiting > 0
        ? `Medir ${ready.length} materias · ${waiting} son recientes`
        : 'Medir todos los cupos';

  return (
    <Layout>
      {confirmDialog}
      <header className="head">
        <div>
          <p className="eyebrow">planificador</p>
          <h1 className="head__title">Mi semestre</h1>
          <p className="head__meta tnum">
            {plan.items.length} de 10 materias
            {totals.sections > 0 && (
              <>
                <span className="head__dot">·</span>
                {totals.open} de {totals.sections} grupos con cupo
              </>
            )}
          </p>
        </div>

        {!empty && (
          <div className="head__actions">
            <IconButton
              onClick={() => void fetchAll(true, ready)}
              disabled={running || ready.length === 0}
              label={measureLabel}
              // Hacia la izquierda: estos rótulos son frases, no dos palabras,
              // y centrado bajo un botón de la esquina derecha el globito se
              // sale de la página. Hacia dentro tiene todo el ancho que quiera.
              tip="left"
              className={running ? 'is-spinning' : ''}
            >
              <RefreshCw size={18} strokeWidth={1.75} />
            </IconButton>

            <IconButton
              onClick={() => setOnlyOpen((v) => !v)}
              pressed={onlyOpen}
              label="Mostrar solo los grupos con cupo"
              tip="left"
            >
              <Filter size={18} strokeWidth={1.75} />
            </IconButton>

            <span className="head__sep" aria-hidden="true" />

            <IconButton
              onClick={clearAll}
              label="Vaciar la lista (el plan no se toca)"
              tip="left"
              className="iconbtn--danger"
            >
              <Eraser size={18} strokeWidth={1.75} />
            </IconButton>
          </div>
        )}
      </header>

      {empty ? (
        <>
          <Empty
            title="Todavía no agregaste materias"
            note="Toca el + en las asignaturas que estés considerando. Aquí podrás ver los cupos de todos sus grupos con un solo botón."
          />
          {plan.selection && (
            <p className="sem__back">
              <Link className="btn btn--primary" to={selectionPath(plan.selection)}>
                ir al catálogo de {plan.selection.programName}
              </Link>
            </p>
          )}
        </>
      ) : (
        <>
          {/* La barra de progreso ocupa sitio SIEMPRE, aunque esté vacía: si
              apareciera y desapareciera, la lista entera daría un salto de
              4px cada vez que se mide. */}
          <div className={`sem__progress ${running ? 'is-on' : ''}`} aria-hidden="true">
            <i style={{ transform: `scaleX(${running && total > 0 ? done / total : 0})` }} />
          </div>

          <div className="table sem__table">
            <div className="table__head" aria-hidden="true">
              <span className="col-code">código</span>
              <span>asignatura</span>
              <span className="col-typ">tip</span>
              <span className="col-cr">cr</span>
              <span className="col-seats">cupos</span>
              <span />
            </div>
            <ul className="sem">
              {rows.map((r) => (
                <CourseCard
                  key={itemId(r.item)}
                  row={r}
                  onlyOpen={onlyOpen}
                  onRemove={() => plan.remove(itemId(r.item))}
                />
              ))}
            </ul>
          </div>

          <p className="sem__note">
            Los cupos se guardan con su hora de medición, así que lo que ves aquí es lo que
            había en ese momento — no una promesa de que sigan ahí. El botón vuelve a
            preguntarle al SIA, en tandas de {CONCURRENCY} a la vez, que es lo que el pool de
            conexiones puede atender en paralelo. Solo por las materias que lleven más de{' '}
            {formatAge(FETCH_COOLDOWN)} sin medir: por debajo de eso el dato es el mismo y
            preguntar de nuevo solo le cuesta trabajo al SIA.
          </p>
        </>
      )}
    </Layout>
  );
}

function CourseCard({
  row,
  onlyOpen,
  onRemove,
}: {
  row: Row;
  onlyOpen: boolean;
  onRemove: () => void;
}) {
  const { item, detail, status, error } = row;
  const all = detail?.sections ?? [];
  const sections = all.filter((s) => !onlyOpen || (s.seats?.available ?? 0) > 0);
  const totalSeats = all.reduce((n, s) => n + (s.seats?.available ?? 0), 0);
  const noGroups = status === 'done' && detail && all.length === 0;

  // La edad más antigua entre los grupos: el dato que limita.
  const oldestAge = all.reduce<number | null>(
    (max, s) =>
      s.seats ? (max === null ? s.seats.age_seconds : Math.max(max, s.seats.age_seconds)) : max,
    null,
  );

  // Para "sin grupos": edad desde la última consulta al SIA.
  const noGroupsAge =
    noGroups && detail?.fetched_at
      ? (Date.now() - Date.parse(detail.fetched_at)) / 1000
      : null;

  return (
    <li className={`card ${status === 'loading' ? 'is-loading' : ''}`}>
      <header className="card__head table__row">
        <span className="card__code tnum col-code">{item.code}</span>

        <Link
          className="card__name"
          to={`/nivel/${item.level}/sede/${item.campus}/plan/${item.program}/asignatura/${encodeURIComponent(item.code)}?f=${item.faculty}`}
        >
          {item.name}
        </Link>

        <span
          className={`tag tag--${slugTypology(item.typology)} col-typ`}
          title={item.typology}
        >
          {shortTypology(item.typology)}
        </span>

        <span className="card__credits tnum col-cr" aria-label={`${item.credits} créditos`}>
          {item.credits}
        </span>

        {/* La cabecera de columnas es aria-hidden —es una rejilla, no una
            <table>—, así que sin rótulo propio un lector de pantalla
            anunciaría '12' a secas. */}
        <div
          className="card__tally col-seats"
          aria-label={
            status === 'done' && detail
              ? noGroups
                ? 'Sin grupos programados'
                : `${totalSeats} cupos disponibles`
              : undefined
          }
        >
          {status === 'done' && detail && (
            <>
              {noGroups ? (
                <span className="card__big card__big--none tnum" aria-hidden="true">—</span>
              ) : (
                <span className={`card__big tnum ${totalSeats === 0 ? 'is-zero' : ''}`}>
                  {totalSeats}
                </span>
              )}
              <span className="card__tallyLabel tnum" aria-hidden="true">
                {noGroups ? (
                  <>
                    sin grupos
                    {/* El separador va DENTRO del span: en el teléfono la columna se
                        angosta y la edad se oculta, y un ' · ' suelto quedaría
                        colgando de 'sin grupos'. Los espacios son duros para que
                        'sin grupos · 2 h' no se parta en dos líneas. */}
                    <span className="card__age">
                      {'\u00a0·\u00a0'}
                      {noGroupsAge !== null ? formatAge(noGroupsAge) : '—'}
                    </span>
                  </>
                ) : oldestAge !== null ? (
                  formatAge(oldestAge)
                ) : (
                  '—'
                )}
              </span>
            </>
          )}
          {status === 'loading' && <span className="card__tallyLabel">midiendo…</span>}
        </div>

        <IconButton onClick={onRemove} label="Quitar del semestre" tip="left" className="iconbtn--danger">
          <Trash2 size={16} strokeWidth={1.75} />
        </IconButton>
      </header>

      {status === 'error' && <p className="card__error">{error}</p>}

      {noGroups && (
        <p className="card__error card__error--soft">Sin grupos este semestre.</p>
      )}

      {onlyOpen && all.length > 0 && sections.length === 0 && (
        <p className="card__error card__error--soft">Ningún grupo con cupo ahora mismo.</p>
      )}

      {sections.length > 0 && (
        <ul className="slots">
          {sections.map((s) => {
            const seats = s.seats?.available ?? null;
            return (
              <li key={s.key} className={`slot ${seats === 0 ? 'is-zero' : ''}`}>
                <span className="slot__key tnum">{s.key}</span>
                <span className="slot__who">
                  <User size={12} strokeWidth={1.75} aria-hidden="true" />
                  {s.instructor ? titleCase(s.instructor) : 'sin profesor asignado'}
                </span>
                <span className={`slot__when${s.schedule.length > 0 ? ' tnum' : ''}`}>
                  <Clock size={12} strokeWidth={1.75} aria-hidden="true" />
                  {s.schedule.length === 0
                    ? 'sin horario'
                    : s.schedule
                        .map((c) => `${DAYS_SHORT[c.weekday]} ${c.start_time}`)
                        .join(' · ')}
                </span>
                <span className="slot__seats">
                  <b className="tnum">{seats === null ? '—' : seats}</b>
                </span>
                <span className="slot__radio" aria-hidden="true" />
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function summarize(rows: Row[]) {
  let sections = 0;
  let open = 0;
  for (const r of rows) {
    for (const s of r.detail?.sections ?? []) {
      sections++;
      if ((s.seats?.available ?? 0) > 0) open++;
    }
  }
  return { sections, open };
}

/** 'FUND. OBLIGATORIA (B)' → 'B'. Misma lógica que Program.tsx. */
function shortTypology(t: string): string {
  return t.match(/\(([^)]+)\)/)?.[1] ?? t.slice(0, 3);
}

function slugTypology(t: string): string {
  if (t.startsWith('LIBRE')) return 'libre';
  if (t.includes('OBLIGATORIA')) return 'obligatoria';
  if (t.includes('OPTATIVA')) return 'optativa';
  return 'otra';
}
