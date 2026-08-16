import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ArrowLeftRight, CornerUpLeft, Search, SlidersHorizontal, X } from 'lucide-react';
import { routes } from '../api/client';
import type { CoursesResponse, CourseSummary, ProgramsResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { usePlan } from '../hooks/usePlan';
import { Layout } from '../components/Layout';
import { useConfirm } from '../components/Confirm';
import { AddButton } from '../components/AddButton';
import { Empty, Fault, Loading } from '../components/States';
import { fold, formatAge } from '../lib/format';
import { selectionId, selectionPath } from '../lib/storage';
import './Program.css';

/**
 * El catálogo de un plan. Hasta ~700 asignaturas (Medellín: 694).
 *
 * Los filtros son en memoria a propósito: el catálogo completo ya vino en la
 * misma respuesta, así que filtrar en el servidor costaría otra consulta al
 * SIA para mostrar menos de lo que ya tenemos.
 */
export function Program() {
  const { campus = '', program = '', level = 'pregrado' } = useParams();
  const [params] = useSearchParams();
  const faculty = params.get('f') ?? '';

  const path = routes.courses({ level, campus, faculty }, program);
  const { data, error, loading, elapsed, attempt, reload } =
    useApi<CoursesResponse>(path);

  const [q, setQ] = useState('');
  const [typology, setTypology] = useState('');
  const [credits, setCredits] = useState('');

  const typologies = useMemo(() => {
    const set = new Set((data?.courses ?? []).map((c) => c.typology).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b, 'es'));
  }, [data]);

  const creditValues = useMemo(() => {
    const set = new Set((data?.courses ?? []).map((c) => c.credits));
    return [...set].sort((a, b) => a - b);
  }, [data]);

  const shown = useMemo(() => {
    const needle = fold(q);
    return (data?.courses ?? []).filter((c) => {
      if (needle && !fold(c.name).includes(needle) && !fold(c.code).includes(needle)) return false;
      if (typology && c.typology !== typology) return false;
      if (credits && String(c.credits) !== credits) return false;
      return true;
    });
  }, [data, q, typology, credits]);

  const total = data?.courses.length ?? 0;
  const filtering = !!(q || typology || credits);

  /**
   * El plan de la URL contra el plan elegido.
   *
   * Se puede llegar acá sin haber pasado por /plan: una URL pegada en un chat,
   * un marcador viejo, el botón de atrás. Dos casos, dos respuestas distintas:
   *
   *  - sin plan elegido → este vale como la elección. No hay nada que perder,
   *    así que no hay nada que preguntar.
   *  - con otro plan elegido → NO se toca nada por las malas. Se avisa y se
   *    deja decidir: el cambio borra el semestre y eso no puede pasar por
   *    haber tocado "atrás".
   */
  const plan = usePlan();
  const [ask, confirmDialog] = useConfirm();
  const { selection, select } = plan;
  const here = { level, campus, program };
  const foreign = selection && selectionId(selection) !== selectionId(here);

  useEffect(() => {
    if (selection) return;
    select({
      ...here,
      // Entrando por URL directa no hay lista de planes a mano de dónde sacar
      // los nombres. El código alcanza como rótulo hasta que se complete abajo.
      campusName: campus,
      faculty,
      facultyName: '',
      programName: program,
    });
    // Solo importa el plan de la URL: los nombres son decoración.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, select, level, campus, faculty, program]);

  /**
   * Ponerle nombre a un plan adoptado desde una URL pegada.
   *
   * Ese camino guarda el código como rótulo, porque ahí no hay de dónde sacar
   * el nombre — y el chip de la barra terminaría diciendo "2A74 · 2A74". El
   * directorio de la sede sí lo tiene, así que se pide UNA vez, solo cuando
   * falta: la condición es que el nombre siga siendo igual al código.
   */
  const needsName = !!selection && !foreign && selection.programName === selection.program;
  const directory = useApi<ProgramsResponse>(
    needsName ? routes.programs({ level, campus, faculty }) : null,
  );

  useEffect(() => {
    if (!needsName || !selection) return;
    const p = directory.data?.programs.find((x) => x.code === program);
    if (!p) return;
    select({
      level,
      campus,
      campusName: p.campus_name,
      faculty: p.faculty_code,
      facultyName: p.faculty_name,
      program: p.code,
      programName: p.name,
    });
  }, [directory.data, needsName, selection, select, level, campus, program]);

  async function adoptThis() {
    if (!selection) return;
    const n = plan.items.length;
    if (n > 0) {
      const ok = await ask({
        title: `Cambiar al plan ${program}`,
        danger: true,
        confirmLabel: 'Cambiar de plan',
        body: (
          <>
            <p>
              Se va a borrar {n === 1 ? 'la materia guardada' : `las ${n} materias guardadas`} en Mi
              semestre, porque {n === 1 ? 'es' : 'son'} del plan <b>{selection.programName}</b>.
            </p>
            <p>Sus grupos y su tipología son de ese plan, no de este.</p>
          </>
        ),
      });
      if (!ok) return;
    }
    select({ ...here, campusName: campus, faculty, facultyName: '', programName: program });
  }

  return (
    <Layout>
      {confirmDialog}
      {foreign && selection && (
        <div className="stray" role="status">
          <p className="stray__text">
            Estás mirando el plan <b>{program}</b>, y el tuyo es <b>{selection.programName}</b>.
            Podés mirar todo lo que quieras, pero para agregar materias al semestre tenés que
            estar en tu plan.
          </p>
          <div className="stray__actions">
            <Link className="btn" to={selectionPath(selection)}>
              <CornerUpLeft size={15} strokeWidth={1.75} aria-hidden="true" />
              volver al mío
            </Link>
            <button className="btn btn--ghost" onClick={adoptThis}>
              <ArrowLeftRight size={15} strokeWidth={1.75} aria-hidden="true" />
              cambiarme a este
            </button>
          </div>
        </div>
      )}

      <header className="head">
        <div>
          <p className="eyebrow">plan {program}</p>
          <h1 className="head__title">Catálogo</h1>
        </div>
        {total > 0 && (
          <p className="head__meta tnum">
            {shown.length === total ? `${total} asignaturas` : `${shown.length} de ${total}`}
          </p>
        )}
      </header>

      {loading && !data && (
        <Loading elapsed={elapsed} attempt={attempt} what="Trayendo el catálogo del plan" />
      )}
      {error && <Fault error={error} onRetry={() => reload()} />}

      {data && (
        <>
          <div className="toolbar">
            <label className="search search--flex">
              <Search size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="sr-only">Buscar asignatura</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar por nombre o código…"
              />
            </label>

            <div className="toolbar__filters">
              <SlidersHorizontal
                className="toolbar__icon"
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
              />

              <label className="pick">
                <span className="sr-only">Tipología</span>
                <select value={typology} onChange={(e) => setTypology(e.target.value)}>
                  <option value="">tipología</option>
                  {typologies.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>

              <label className="pick pick--narrow">
                <span className="sr-only">Créditos</span>
                <select value={credits} onChange={(e) => setCredits(e.target.value)}>
                  <option value="">cr</option>
                  {creditValues.map((c) => (
                    <option key={c} value={String(c)}>
                      {c} cr
                    </option>
                  ))}
                </select>
              </label>

              {filtering && (
                <button
                  className="toolbar__clear"
                  onClick={() => {
                    setQ('');
                    setTypology('');
                    setCredits('');
                  }}
                  aria-label="Quitar los filtros"
                  title="Quitar los filtros"
                >
                  <X size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {shown.length === 0 ? (
            <Empty
              title="Ninguna asignatura coincide"
              note="Quitá algún filtro. Ojo: la tipología depende del plan, no de la asignatura."
            />
          ) : (
            <div className="table">
              {/* La cabecera comparte la MISMA rejilla que las filas: es lo que
                  hace que las columnas queden alineadas sin usar <table>, que
                  no sabe truncar celdas sin romper el ancho. */}
              <div className="table__head" aria-hidden="true">
                <span className="col-code">código</span>
                <span>asignatura</span>
                <span className="col-typ">tip</span>
                <span className="col-cr">cr</span>
                <span className="col-seats">cupos</span>
                <span />
              </div>

              <ul className="rows">
                {shown.map((c) => (
                  <li key={c.code}>
                    <Link
                      className="row"
                      to={`/nivel/${level}/sede/${campus}/plan/${program}/asignatura/${encodeURIComponent(c.code)}${
                        faculty ? `?f=${faculty}` : ''
                      }`}
                    >
                      <span className="row__code tnum col-code">{c.code}</span>
                      <span className="row__name">{c.name}</span>
                      <span
                        className={`tag tag--${slugTypology(c.typology)} col-typ`}
                        title={c.typology}
                      >
                        {shortTypology(c.typology)}
                      </span>
                      <span className="row__credits tnum col-cr">{c.credits}</span>
                      <SeatsCell seats={c.seats} />
                      <AddButton
                        item={{
                          level,
                          campus,
                          program,
                          faculty,
                          code: c.code,
                          name: c.name,
                          credits: c.credits,
                          typology: c.typology,
                        }}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Layout>
  );
}

/**
 * Los cupos de la asignatura, sumados sobre los grupos que este plan ve.
 *
 * Sin botón de recargar a propósito: acá se muestra lo que la base YA tiene.
 * Un botón por fila invitaría a disparar una consulta al SIA por cada una de
 * las 313 asignaturas. Para medir se entra a la materia, donde una sola
 * consulta trae todos sus grupos.
 */
function SeatsCell({ seats }: { seats?: CourseSummary['seats'] }) {
  if (!seats) {
    return (
      <span
        className="row__seats is-unknown col-seats"
        title="Nunca se pidió el detalle de esta asignatura"
      >
        —
      </span>
    );
  }
  return (
    <span
      className={`row__seats col-seats ${seats.available === 0 ? 'is-zero' : 'is-open'}`}
      title={`${seats.available} cupos en ${seats.sections} grupos · medido ${new Date(seats.measured_at).toLocaleString('es-CO')}`}
    >
      <b className="tnum">{seats.available}</b>
      <small className="tnum">{formatAge(seats.age_seconds)}</small>
    </span>
  );
}

/** 'FUND. OBLIGATORIA (B)' → 'B'. La letra entre paréntesis es lo que informa. */
function shortTypology(t: string): string {
  return t.match(/\(([^)]+)\)/)?.[1] ?? t.slice(0, 3);
}

function slugTypology(t: string): string {
  if (t.startsWith('LIBRE')) return 'libre';
  if (t.includes('OBLIGATORIA')) return 'obligatoria';
  if (t.includes('OPTATIVA')) return 'optativa';
  return 'otra';
}
