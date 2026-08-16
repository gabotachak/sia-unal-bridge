import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { routes } from '../api/client';
import type { CoursesResponse, CourseSummary } from '../api/types';
import { useApi } from '../hooks/useApi';
import { Layout } from '../components/Layout';
import { AddButton } from '../components/AddButton';
import { Empty, Fault, Loading } from '../components/States';
import { fold, formatAge } from '../lib/format';
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

  return (
    <Layout
      crumbs={[
        { label: level, to: `/nivel/${level}` },
        { label: campus, to: `/nivel/${level}/sede/${campus}` },
        { label: program },
      ]}
      freshness={freshness}
    >
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
