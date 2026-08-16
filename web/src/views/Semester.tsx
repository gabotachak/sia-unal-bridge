import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Eraser, Filter, RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, get, routes } from '../api/client';
import type { CourseDetail } from '../api/types';
import { usePlan } from '../hooks/usePlan';
import { formatAge } from '../lib/format';
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
};

export function Semester() {
  const plan = usePlan();
  const [ask, confirmDialog] = useConfirm();
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
            if (!isTransient(e) || attempt === MAX_RETRIES) break;
            await sleep(backoffMs(attempt));
          }
        }

        patch(id, {
          status: 'error',
          error: lastError instanceof ApiError ? lastError.humane : 'no se pudo consultar',
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
            Tu plan sigue siendo el mismo, así que podés volver a agregarlas desde el catálogo.
          </p>
        </>
      ),
    });
    if (!ok) return;
    plan.clear();
  }

  const done = rows.filter((r) => r.status === 'done').length;
  const totals = summarize(rows);
  const empty = plan.items.length === 0;

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
              onClick={() => void fetchAll(true)}
              disabled={running}
              label={running ? `Midiendo ${done}/${plan.items.length}…` : 'Medir todos los cupos'}
              className={running ? 'is-spinning' : ''}
            >
              <RefreshCw size={18} strokeWidth={1.75} />
            </IconButton>

            <IconButton
              onClick={() => setOnlyOpen((v) => !v)}
              pressed={onlyOpen}
              label="Mostrar solo los grupos con cupo"
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
            note="Tocá el + en las asignaturas que estés considerando. Acá vas a poder ver los cupos de todos sus grupos con un solo botón."
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
            <i style={{ transform: `scaleX(${running ? done / plan.items.length : 0})` }} />
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
  const all = detail?.sections ?? [];
  const sections = all.filter((s) => !onlyOpen || (s.seats?.available ?? 0) > 0);
  const open = all.filter((s) => (s.seats?.available ?? 0) > 0).length;
  const totalSeats = all.reduce((n, s) => n + (s.seats?.available ?? 0), 0);

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
          <p className="card__meta tnum">
            {item.code}
            <span className="head__dot">·</span>
            {item.credits} cr
            <span className="head__dot">·</span>
            {item.typology}
          </p>
        </div>

        <div className="card__end">
          {status === 'done' && detail && (
            <div className="card__tally">
              <span className={`card__big tnum ${totalSeats === 0 ? 'is-zero' : ''}`}>
                {totalSeats}
              </span>
              <span className="card__tallyLabel tnum">
                cupos · {open}/{all.length} grupos
              </span>
            </div>
          )}
          {status === 'loading' && <span className="card__tallyLabel">midiendo…</span>}

          <IconButton onClick={onRemove} label="Quitar del semestre" tip="left" className="iconbtn--danger">
            <Trash2 size={16} strokeWidth={1.75} />
          </IconButton>
        </div>
      </header>

      {status === 'error' && <p className="card__error">{error}</p>}

      {status === 'done' && all.length === 0 && (
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
                <span className="slot__who">{s.instructor || '—'}</span>
                <span className="slot__when tnum">
                  {s.schedule.length === 0
                    ? 'sin horario'
                    : s.schedule
                        .map((c) => `${DAYS_SHORT[c.weekday]} ${c.start_time}`)
                        .join(' · ')}
                </span>
                <span className="slot__seats">
                  <b className="tnum">{seats === null ? '—' : seats}</b>
                  {s.seats && <small className="tnum">{formatAge(s.seats.age_seconds)}</small>}
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
