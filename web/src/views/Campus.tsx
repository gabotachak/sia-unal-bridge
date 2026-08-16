import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { routes } from '../api/client';
import type { ProgramsResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { Layout } from '../components/Layout';
import { Empty, Fault, Loading } from '../components/States';
import { fold } from '../lib/format';
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
  const { data, error, loading, freshness, elapsed, reload } = useApi<ProgramsResponse>(
    routes.programs({ level, campus }),
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

  return (
    <Layout
      crumbs={[
        { label: level, to: `/nivel/${level}` },
        { label: 'sedes', to: `/nivel/${level}` },
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
                      <Link to={`/nivel/${level}/sede/${campus}/plan/${p.code}?f=${p.faculty_code}`}>
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

