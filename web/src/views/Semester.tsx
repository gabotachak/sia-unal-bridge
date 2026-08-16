import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, get, routes } from '../api/client';
import type { CourseDetail } from '../api/types';
import { usePlan } from '../hooks/usePlan';
import { formatAge } from '../lib/format';
import { pooled } from '../lib/pooled';
import { itemId, selectionPath, type PlanItem } from '../lib/storage';
import { Layout } from '../components/Layout';
import { Empty } from '../components/States';
import './Semester.css';

/** El pool del back son 4 sesiones ADF. Pedir de a más no acelera nada. */
const CONCURRENCY = 4;

/** Cuántas veces reintentar un error transitorio antes de mostrárselo al usuario. */
const MAX_RETRIES = 3;

/** Errores del SIA que suelen resolverse solos al reintentar. */
const TRANSIENT_CODES = new Set(['sia_noop', 'sia_session_lost', 'busy']);

/** Espera `ms` milisegundos. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Row = {
  item: PlanItem;
  detail: CourseDetail | null;
  status: 'idle' | 'loading' | 'done' | 'error';
  error?: string;
};

export function Semester() {
  const plan = usePlan();
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(false);

  // La lista de materias manda: al agregar o quitar, se rearman las filas
  // conservando lo que ya se había traído.
  useEffect(() => {
    setRows((prev) =>
      plan.items.map((item) => {
        const old = prev.find((r) => itemId(r.item) === itemId(item));
        return old ?? { item, detail: null, status: 'idle' as const };
      }),
    );
  }, [plan.items]);

  const patch = useCallback((id: string, next: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (itemId(r.item) === id ? { ...r, ...next } : r)));
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
   */
  const fetchAll = useCallback(
    async (force: boolean) => {
      const targets = plan.items;
      if (targets.length === 0) return;

      setRunning(true);
      setRows((prev) => prev.map((r) => ({ ...r, status: 'loading', error: undefined })));

      await pooled(targets, CONCURRENCY, async (item) => {
        const id = itemId(item);
        const scope = { level: item.level, campus: item.campus, faculty: item.faculty };

        let lastError: unknown;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          // En reintentos, forzar max_age=0: si el primer intento falló por
          // sesión caducada o respuesta vacía, repetir con cache no va a ayudar.
          const forceRetry = force || attempt > 0;
          const path = routes.course(scope, item.program, item.code, forceRetry ? 0 : undefined);
          try {
            const res = await get<CourseDetail>(path);
            patch(id, { detail: res.data, status: 'done' });
            return; // éxito → no seguir reintentando
          } catch (e) {
            lastError = e;
            const isTransient = e instanceof ApiError && TRANSIENT_CODES.has(e.code);
            if (!isTransient || attempt === MAX_RETRIES) break;
            // Backoff exponencial: ~600ms, ~1200ms, ~2400ms con jitter.
            await sleep(300 * 2 ** attempt + Math.random() * 300);
          }
        }

        patch(id, {
          status: 'error',
          error:
            lastError instanceof ApiError ? lastError.humane : 'no se pudo consultar',
        });
      });

      setRunning(false);
    },
    [plan.items, patch],
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
    if (plan.items.length > 0) void fetchAll(false);
  }, [plan.items.length, fetchAll]);

  const done = rows.filter((r) => r.status === 'done').length;
  const totals = summarize(rows);

  return (
    <Layout crumbs={[{ label: 'tablero', to: '/' }, { label: 'mi semestre' }]}>
      <header className="head sem__head">
        <div>
          <p className="eyebrow">planificador</p>
          <h1 className="head__title">Mi semestre</h1>
          <p className="head__meta">
            {plan.items.length} de 10 materias
            {totals.sections > 0 && (
              <>
                <span className="head__dot">·</span>
                {totals.open} de {totals.sections} grupos con cupo
              </>
            )}
          </p>
        </div>

        {plan.items.length > 0 && (
          <div className="sem__actions">
            <button className="btn btn--hero" onClick={() => void fetchAll(true)} disabled={running}>
              {running ? `midiendo ${done}/${plan.items.length}…` : 'medir todos los cupos'}
            </button>
            <label className="sem__toggle">
              <input
                type="checkbox"
                checked={onlyOpen}
                onChange={(e) => setOnlyOpen(e.target.checked)}
              />
              solo grupos con cupo
            </label>
          </div>
        )}
      </header>

      {plan.items.length === 0 ? (
        <>
          <Empty
            title="Todavía no agregaste materias"
            note="Tocá el + en las asignaturas que estés considerando. Acá vas a poder ver los cupos de todos sus grupos con un solo botón."
          />
          {plan.selection && (
            <p className="sem__back">
              <Link className="btn" to={selectionPath(plan.selection)}>
                ir al catálogo de {plan.selection.programName}
              </Link>
            </p>
          )}
        </>
      ) : (
        <>
          {running && (
            <div className="sem__progress" aria-hidden="true">
              <i style={{ transform: `scaleX(${done / plan.items.length})` }} />
            </div>
          )}

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

          <p className="sem__note">
            Los cupos se guardan con su hora de medición, así que lo que ves acá es lo que
            había en ese momento — no una promesa de que sigan ahí. El botón vuelve a
            preguntarle al SIA por las {plan.items.length} materias, de a {CONCURRENCY} a la
            vez, que es lo que el pool de conexiones puede atender en paralelo.
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
  const sections = (detail?.sections ?? []).filter(
    (s) => !onlyOpen || (s.seats?.available ?? 0) > 0,
  );
  const open = (detail?.sections ?? []).filter((s) => (s.seats?.available ?? 0) > 0).length;
  const totalSeats = (detail?.sections ?? []).reduce((n, s) => n + (s.seats?.available ?? 0), 0);

  return (
    <li className={`card ${status === 'loading' ? 'is-loading' : ''}`}>
      <header className="card__head">
        <div className="card__id">
          <Link
            className="card__name"
            to={`/nivel/${item.level}/sede/${item.campus}/plan/${item.program}/asignatura/${encodeURIComponent(item.code)}?f=${item.faculty}`}
          >
            {item.name}
          </Link>
          <p className="card__meta">
            {item.code}
            <span className="head__dot">·</span>
            {item.credits} cr
            <span className="head__dot">·</span>
            {item.level} · sede {item.campus} · plan {item.program}
          </p>
        </div>

        <div className="card__tally">
          {status === 'done' && detail && (
            <>
              <span className={`card__big ${open === 0 ? 'is-zero' : ''}`}>{totalSeats}</span>
              <span className="card__tallyLabel">
                cupos en {open}/{detail.sections.length} grupos
              </span>
            </>
          )}
          {status === 'loading' && <span className="card__tallyLabel">midiendo…</span>}
          <button className="card__remove" onClick={onRemove} title="Quitar del semestre">
            🗑️ <span>quitar</span>
          </button>
        </div>
      </header>

      {status === 'error' && <p className="card__error">{error}</p>}

      {status === 'done' && detail?.sections.length === 0 && (
        <p className="card__error card__error--soft">Sin grupos este semestre.</p>
      )}

      {sections.length > 0 && (
        <ul className="slots">
          {sections.map((s) => {
            const seats = s.seats?.available ?? null;
            const zero = seats === 0;
            return (
              <li key={s.key} className={`slot ${zero ? 'is-zero' : ''}`}>
                <span className="slot__key">{s.key}</span>
                <span className="slot__who">{s.instructor || '—'}</span>
                <span className="slot__when">
                  {s.schedule.length === 0
                    ? 'sin horario'
                    : s.schedule
                        .map((c) => `${['', 'lu', 'ma', 'mi', 'ju', 'vi', 'sa', 'do'][c.weekday]} ${c.start_time}`)
                        .join(' · ')}
                </span>
                <span className="slot__seats">
                  {seats === null ? '—' : seats}
                  {s.seats && <small>hace {formatAge(s.seats.age_seconds)}</small>}
                </span>
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
