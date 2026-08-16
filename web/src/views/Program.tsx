import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { routes } from '../api/client';
import type { CoursesResponse, CourseSummary } from '../api/types';
import { useApi } from '../hooks/useApi';
import { usePlan } from '../hooks/usePlan';
import { Layout } from '../components/Layout';
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
  const { data, error, loading, freshness, elapsed, reload } = useApi<CoursesResponse>(path);

  const [q, setQ] = useState('');
  const [typology, setTypology] = useState('');
  const [credits, setCredits] = useState('');

  const typologies = useMemo(() => {
    const set = new Set((data?.courses ?? []).map((c) => c.typology).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b, 'es'));
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

  /**
   * El plan de la URL contra el plan elegido.
   *
   * Se puede llegar acá sin haber pasado por la pantalla de elegir: una URL
   * pegada en un chat, un marcador viejo, el botón de atrás. Dos casos, dos
   * respuestas distintas:
   *
   *  - sin plan elegido → este vale como la elección. No hay nada que perder,
   *    así que no hay nada que preguntar.
   *  - con otro plan elegido → NO se toca nada por las malas. Se avisa y se
   *    deja decidir: el cambio borra el semestre y eso no puede pasar por
   *    haber tocado "atrás".
   */
  const plan = usePlan();
  const { selection, select } = plan;
  const here = { level, campus, program };
  const foreign = selection && selectionId(selection) !== selectionId(here);

  useEffect(() => {
    if (selection) return;
    select({
      ...here,
      // Entrando por URL directa no hay lista de planes a mano de dónde sacar
      // los nombres. El código alcanza como rótulo hasta que se elija desde la
      // sede, que es donde vienen con nombre.
      campusName: campus,
      faculty,
      facultyName: '',
      programName: program,
    });
    // Solo importa el plan de la URL: los nombres son decoración.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, select, level, campus, faculty, program]);

  function adoptThis() {
    if (!selection) return;
    const n = plan.items.length;
    if (n > 0) {
      const ok = window.confirm(
        `Cambiar al plan ${program} reinicia el tablero.\n\n` +
          `Se van a borrar las ${n} ${n === 1 ? 'materia guardada' : 'materias guardadas'} en Mi semestre, ` +
          `porque son del plan ${selection.programName}.`,
      );
      if (!ok) return;
    }
    select({ ...here, campusName: campus, faculty, facultyName: '', programName: program });
  }

  return (
    <Layout
      // Las migas ya no suben a nivel y sede: con un plan elegido, ese camino
      // solo lleva a rebotar de vuelta acá. El tablero es este catálogo.
      crumbs={[{ label: 'tablero', to: '/' }, { label: `plan ${program}` }]}
      freshness={freshness}
    >
      {foreign && selection && (
        <div className="stray" role="status">
          <p className="stray__text">
            Estás mirando el plan <b>{program}</b>, y el tuyo es{' '}
            <b>{selection.programName}</b>. Podés mirar todo lo que quieras, pero para
            agregar materias al semestre tenés que estar en tu plan.
          </p>
          <div className="stray__actions">
            <Link className="btn" to={selectionPath(selection)}>
              volver a mi plan
            </Link>
            <button className="btn btn--ghost" onClick={adoptThis}>
              cambiar a este plan
            </button>
          </div>
        </div>
      )}

      <header className="head">
        <p className="eyebrow">plan {program}</p>
        <h1 className="head__title">Catálogo</h1>
        {total > 0 && (
          <p className="head__meta">
            {shown.length === total ? `${total} asignaturas` : `${shown.length} de ${total}`}
          </p>
        )}
      </header>

      {loading && !data && (
        <Loading elapsed={elapsed} what="Trayendo el catálogo del plan" />
      )}
      {error && <Fault error={error} onRetry={() => reload()} />}

      {data && (
        <>
          <div className="filters">
            <label className="field">
              <span className="sr-only">Buscar asignatura</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filtrar por nombre o código…"
              />
            </label>

            <label className="field">
              <span className="sr-only">Tipología</span>
              <select value={typology} onChange={(e) => setTypology(e.target.value)}>
                <option value="">todas las tipologías</option>
                {typologies.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="sr-only">Créditos</span>
              <input
                type="number"
                min="0"
                value={credits}
                onChange={(e) => setCredits(e.target.value)}
                placeholder="créditos"
                className="field--narrow"
              />
            </label>
          </div>

          {shown.length === 0 ? (
            <Empty
              title="Ninguna asignatura coincide"
              note="Quitá algún filtro. Ojo: la tipología depende del plan, no de la asignatura."
            />
          ) : (
            <ul className="courses">
              {shown.map((c) => (
                <li key={c.code} className="courses__row">
                  <Link
                    to={`/nivel/${level}/sede/${campus}/plan/${program}/asignatura/${encodeURIComponent(c.code)}${
                      faculty ? `?f=${faculty}` : ''
                    }`}
                  >
                    <span className="courses__code">{c.code}</span>
                    <span className="courses__name">{c.name}</span>
                    <span className={`tag tag--${slugTypology(c.typology)}`}>
                      {shortTypology(c.typology)}
                    </span>
                    <span className="courses__credits">
                      {c.credits}
                      <small>cr</small>
                    </span>
                    <CourseSeatsCell seats={c.seats} />
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
function CourseSeatsCell({ seats }: { seats?: CourseSummary['seats'] }) {
  if (!seats) {
    return (
      <span className="cseats cseats--none" title="Nunca se pidió el detalle de esta asignatura">
        —
      </span>
    );
  }
  return (
    <span
      className={`cseats ${seats.available === 0 ? 'is-zero' : ''}`}
      title={`${seats.available} cupos en ${seats.sections} grupos · medido ${new Date(seats.measured_at).toLocaleString('es-CO')}`}
    >
      <b>{seats.available}</b>
      <small>hace {formatAge(seats.age_seconds)}</small>
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
