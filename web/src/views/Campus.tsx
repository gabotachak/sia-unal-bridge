import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { routes } from '../api/client';
import type { Program as ProgramRef, ProgramsResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { CHANGING_QS, useChangingPlan } from '../hooks/useChangingPlan';
import { usePlan } from '../hooks/usePlan';
import { Layout } from '../components/Layout';
import { Empty, Fault, Loading } from '../components/States';
import { fold } from '../lib/format';
import { selectionId, selectionPath } from '../lib/storage';
import './Campus.css';

/**
 * Los planes de una sede, agrupados por facultad.
 *
 * Se pide el directorio completo de la sede (sin ?faculty=) porque es gratis:
 * un miss llena TODAS las facultades en la misma cascada, así que filtrar
 * después en memoria no cuesta ni una petición más.
 */
export function Campus() {
  const { campus = '', level = 'pregrado' } = useParams();
  const plan = usePlan();
  const { selection, select } = plan;
  const changing = useChangingPlan();

  // Igual que en la pantalla de sedes: si se va a rebotar al catálogo, no se
  // pide el directorio. Un miss de esta ruta es una cascada entera al SIA.
  const bounce = !!selection && !changing;

  const { data, error, loading, freshness, elapsed, reload } = useApi<ProgramsResponse>(
    bounce ? null : routes.programs({ level, campus }),
  );
  const [q, setQ] = useState('');

  // useMemo evita reagrupar 125 planes en cada tecleo. Solo recalcula cuando
  // cambian los datos o la búsqueda.
  const groups = useMemo(() => {
    const needle = fold(q);
    const byFaculty = new Map<string, { name: string; items: ProgramsResponse['programs'] }>();
    for (const p of data?.programs ?? []) {
      if (needle && !fold(p.name).includes(needle) && !fold(p.code).includes(needle)) continue;
      const g = byFaculty.get(p.faculty_code) ?? { name: p.faculty_name, items: [] };
      g.items.push(p);
      byFaculty.set(p.faculty_code, g);
    }
    return [...byFaculty.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, 'es'));
  }, [data, q]);

  const campusName = data?.programs[0]?.campus_name ?? campus;
  const total = data?.programs.length ?? 0;

  /**
   * Ponerle nombre al plan guardado.
   *
   * Un plan adoptado desde una URL pegada se guarda con el código como
   * rótulo, porque ahí no hay de dónde sacar el nombre. Acá sí: el directorio
   * de la sede ya está en pantalla. Se aprovecha y se corrige, sin pedir nada
   * de más y sin tocar el semestre — es el mismo plan.
   */
  useEffect(() => {
    if (!selection || selection.level !== level || selection.campus !== campus) return;
    const p = data?.programs.find((x) => x.code === selection.program);
    if (!p) return;
    if (
      selection.programName === p.name &&
      selection.campusName === p.campus_name &&
      selection.faculty === p.faculty_code &&
      selection.facultyName === p.faculty_name
    ) {
      return; // ya está completo: sin esto el efecto se llamaría a sí mismo
    }
    select({
      level,
      campus,
      campusName: p.campus_name,
      faculty: p.faculty_code,
      facultyName: p.faculty_name,
      program: p.code,
      programName: p.name,
    });
  }, [data, selection, select, level, campus]);

  /**
   * Elegir plan. Esta es la pantalla donde se decide, y la única que reinicia
   * el tablero.
   *
   * El semestre guardado pertenece al plan desde el que se armó —la tipología
   * y los grupos visibles dependen del plan, no de la asignatura— así que
   * arrastrarlo a otro plan mostraría datos que ahí no existen. Se borra, pero
   * avisando: es la única acción de la app que destruye trabajo del usuario.
   */
  function choose(e: React.MouseEvent, p: ProgramRef) {
    const next = {
      level,
      campus,
      campusName,
      faculty: p.faculty_code,
      facultyName: p.faculty_name,
      program: p.code,
      programName: p.name,
    };

    const current = plan.selection;
    const isSwitch = current && selectionId(current) !== selectionId(next);

    if (isSwitch && plan.items.length > 0) {
      const n = plan.items.length;
      const ok = window.confirm(
        `Cambiar a «${p.name}» reinicia el tablero.\n\n` +
          `Se van a borrar las ${n} ${n === 1 ? 'materia guardada' : 'materias guardadas'} en Mi semestre, ` +
          `porque son del plan ${current.programName} y sus grupos no son los mismos acá.`,
      );
      if (!ok) {
        e.preventDefault(); // se queda donde estaba, con su plan intacto
        return;
      }
    }

    plan.select(next);
  }

  if (bounce && selection) return <Navigate to={selectionPath(selection)} replace />;

  return (
    <Layout
      crumbs={[
        { label: level, to: `/nivel/${level}${changing ? CHANGING_QS : ''}` },
        { label: 'sedes', to: `/nivel/${level}${changing ? CHANGING_QS : ''}` },
        { label: campusName },
      ]}
      freshness={freshness}
    >
      <header className="head">
        <p className="eyebrow">sede {campus}</p>
        <h1 className="head__title">{campusName.replace(/^SEDE\s+/, '')}</h1>
        {total > 0 && (
          <p className="head__meta">
            {total} planes de estudio
            <span className="head__dot">·</span>
            {groups.length} {groups.length === 1 ? 'facultad' : 'facultades'}
          </p>
        )}
      </header>

      {loading && !data && <Loading elapsed={elapsed} what={`Trayendo los planes de ${campusName}`} />}
      {error && <Fault error={error} onRetry={() => reload()} />}

      {data && (
        <>
          <div className="filters">
            <label className="field">
              <span className="sr-only">Buscar plan</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filtrar por nombre o código…"
              />
            </label>
          </div>

          {groups.length === 0 ? (
            <Empty title="Ningún plan coincide" note="Probá con menos letras." />
          ) : (
            groups.map(([code, g]) => (
              <section key={code} className="faculty">
                <h2 className="faculty__name">
                  {g.name}
                  <span className="faculty__code">{code}</span>
                </h2>
                <ul className="plans">
                  {g.items.map((p) => (
                    <li key={`${p.faculty_code}-${p.code}`}>
                      <Link
                        to={`/nivel/${level}/sede/${campus}/plan/${p.code}?f=${p.faculty_code}`}
                        onClick={(e) => choose(e, p)}
                        className={
                          plan.selection &&
                          selectionId(plan.selection) ===
                            selectionId({ level, campus, program: p.code })
                            ? 'is-mine'
                            : undefined
                        }
                      >
                        <span className="plans__code">{p.code}</span>
                        <span className="plans__name">{p.name}</span>
                        {p.catalog_fetched_at && <span className="plans__cached" title="catálogo ya cacheado">•</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}
    </Layout>
  );
}

