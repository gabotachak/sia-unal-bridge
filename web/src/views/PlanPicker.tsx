import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowLeft,
  Building2,
  Check,
  GraduationCap,
  Layers,
  Search,
  TriangleAlert,
} from 'lucide-react';
import { routes } from '../api/client';
import type {
  CampusesResponse,
  LevelsResponse,
  Program as ProgramRef,
  ProgramsResponse,
} from '../api/types';
import { useApi } from '../hooks/useApi';
import { usePlan } from '../hooks/usePlan';
import { Layout } from '../components/Layout';
import { Empty, Fault, Loading } from '../components/States';
import { fold } from '../lib/format';
import { selectionId, selectionPath } from '../lib/storage';
import './PlanPicker.css';

/**
 * Elegir plan. Una sola pantalla para los tres escalones de la cascada del
 * SIA: nivel, sede, plan.
 *
 * Antes esto eran tres rutas encadenadas y el catálogo colgaba del final, así
 * que la barra de direcciones y las migas de pan describían un camino que
 * había que recorrer entero. Pero el plan no es un camino: es un ajuste que se
 * hace UNA vez y casi nunca se toca. Por eso vive en su propia ruta, se abre a
 * propósito, y al terminar te devuelve al catálogo.
 *
 * Los tres escalones se muestran juntos porque son dependientes pero cortos:
 * el nivel son tres opciones, la sede son nueve. Partirlos en pantallas sería
 * cobrar dos clics de peaje para llegar a la única lista que de verdad hay que
 * mirar.
 */
export function PlanPicker() {
  const plan = usePlan();
  const navigate = useNavigate();
  const current = plan.selection;

  // El punto de partida es donde ya estás: cambiar de plan casi siempre es
  // cambiar DENTRO de la misma sede, así que empezar en blanco haría repetir
  // dos elecciones idénticas.
  const [level, setLevel] = useState(current?.level ?? 'pregrado');
  const [campus, setCampus] = useState(current?.campus ?? '');
  const [q, setQ] = useState('');

  const levels = useApi<LevelsResponse>(routes.levels());
  const campuses = useApi<CampusesResponse>(routes.campuses(level));

  // Sin sede no se pide el directorio: un miss de esa ruta es una cascada
  // entera contra el SIA, y sería para nadie.
  const programs = useApi<ProgramsResponse>(
    campus ? routes.programs({ level, campus }) : null,
  );

  /**
   * Cambiar de nivel invalida la sede.
   *
   * El back cachea las sedes POR NIVEL y las listas no son idénticas, así que
   * una sede elegida en pregrado puede no existir en posgrado. Si sobrevive,
   * se conserva; si no, se suelta y hay que volver a elegir.
   */
  useEffect(() => {
    if (!campus || !campuses.data) return;
    if (!campuses.data.campuses.some((c) => c.code === campus)) setCampus('');
  }, [campuses.data, campus]);

  // Se pide el directorio completo de la sede (sin ?faculty=) porque es
  // gratis: un miss llena TODAS las facultades en la misma cascada, así que
  // filtrar después en memoria no cuesta ni una petición más.
  const groups = useMemo(() => {
    const needle = fold(q);
    const byFaculty = new Map<string, { name: string; items: ProgramRef[] }>();
    for (const p of programs.data?.programs ?? []) {
      if (needle && !fold(p.name).includes(needle) && !fold(p.code).includes(needle)) continue;
      const g = byFaculty.get(p.faculty_code) ?? { name: p.faculty_name, items: [] };
      g.items.push(p);
      byFaculty.set(p.faculty_code, g);
    }
    return [...byFaculty.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, 'es'));
  }, [programs.data, q]);

  const shown = groups.reduce((n, [, g]) => n + g.items.length, 0);
  const total = programs.data?.programs.length ?? 0;
  const campusName =
    campuses.data?.campuses.find((c) => c.code === campus)?.name.replace(/^SEDE\s+/i, '') ?? campus;

  /**
   * Elegir. Es la única acción de la app que destruye trabajo del usuario, así
   * que el precio se dice antes de cobrarlo.
   *
   * El semestre guardado pertenece al plan desde el que se armó —la tipología
   * y los grupos visibles dependen del plan, no de la asignatura— así que
   * arrastrarlo a otro plan mostraría datos que ahí no existen.
   */
  function choose(p: ProgramRef) {
    const next = {
      level,
      campus,
      campusName: p.campus_name,
      faculty: p.faculty_code,
      facultyName: p.faculty_name,
      program: p.code,
      programName: p.name,
    };

    const isSwitch = current && selectionId(current) !== selectionId(next);
    if (isSwitch && plan.items.length > 0) {
      const n = plan.items.length;
      const ok = window.confirm(
        `Cambiar a «${p.name}» reinicia el tablero.\n\n` +
          `Se van a borrar las ${n} ${n === 1 ? 'materia guardada' : 'materias guardadas'} en Mi semestre, ` +
          `porque son del plan ${current.programName} y sus grupos no son los mismos acá.`,
      );
      if (!ok) return;
    }

    plan.select(next);
    navigate(selectionPath(next), { replace: true });
  }

  const first = !current; // primera vez: no hay nada que perder ni a dónde volver

  return (
    <Layout>
      <header className="setup__head">
        <p className="eyebrow">{first ? 'catálogo de asignaturas · sia unal' : 'ajustes'}</p>
        <h1 className="setup__title">{first ? 'Elegí tu plan' : 'Cambiar de plan'}</h1>
        <p className="setup__lead">
          {first ? (
            <>
              Todo lo demás cuelga de acá. El mismo código de plan existe en varias sedes,
              así que preguntar sin decir dónde no significa nada.
            </>
          ) : (
            <>
              Tu plan es <b>{current.programName}</b> en {current.campusName.replace(/^SEDE\s+/i, '')}.
            </>
          )}
        </p>

        {!first && plan.items.length > 0 && (
          <p className="setup__warn">
            <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />
            Elegir otro plan borra las {plan.items.length}{' '}
            {plan.items.length === 1 ? 'materia' : 'materias'} de Mi semestre: sus grupos y su
            tipología son de este plan.
          </p>
        )}

        {!first && (
          <button className="btn setup__back" onClick={() => navigate(selectionPath(current))}>
            <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
            seguir con {current.program}
          </button>
        )}
      </header>

      {/* ── 1. Nivel ─────────────────────────────────────────────────
          No está hardcodeado a los tres de siempre: sale de /v1/levels,
          igual que en el back. Si la UNAL agrega uno, aparece acá solo. */}
      <section className="step">
        <h2 className="step__label">
          <GraduationCap size={16} strokeWidth={1.75} aria-hidden="true" />
          Nivel
        </h2>
        <div className="chips">
          {(levels.data?.levels ?? []).map((l) => (
            <button
              key={l.slug}
              className={`chip ${l.slug === level ? 'is-on' : ''}`}
              onClick={() => setLevel(l.slug)}
              aria-pressed={l.slug === level}
            >
              {l.slug === level && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
              {l.name}
            </button>
          ))}
        </div>
      </section>

      {/* ── 2. Sede ───────────────────────────────────────────────── */}
      <section className="step">
        <h2 className="step__label">
          <Building2 size={16} strokeWidth={1.75} aria-hidden="true" />
          Sede
        </h2>
        {campuses.error && <Fault error={campuses.error} onRetry={() => campuses.reload()} />}
        {campuses.loading && !campuses.data ? (
          <Loading
            elapsed={campuses.elapsed}
            attempt={campuses.attempt}
            what="Trayendo las sedes"
          />
        ) : (
          <div className="chips">
            {(campuses.data?.campuses ?? []).map((c) => (
              <button
                key={c.code}
                className={`chip ${c.code === campus ? 'is-on' : ''}`}
                onClick={() => setCampus(c.code)}
                aria-pressed={c.code === campus}
              >
                {c.code === campus && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
                {c.name.replace(/^SEDE\s+/i, '')}
                <span className="chip__code tnum">{c.code}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ── 3. Plan ───────────────────────────────────────────────── */}
      <section className="step">
        <h2 className="step__label">
          <Layers size={16} strokeWidth={1.75} aria-hidden="true" />
          Plan de estudios
          {total > 0 && (
            <span className="step__count tnum">
              {shown === total ? total : `${shown}/${total}`}
            </span>
          )}
        </h2>

        {!campus ? (
          <p className="step__hint">Elegí una sede para ver sus planes.</p>
        ) : (
          <>
            <label className="search">
              <Search size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="sr-only">Buscar plan</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Buscar entre los planes de ${campusName}…`}
              />
            </label>

            {programs.loading && !programs.data && (
              <Loading
                elapsed={programs.elapsed}
                attempt={programs.attempt}
                what={`Trayendo los planes de ${campusName}`}
              />
            )}
            {programs.error && <Fault error={programs.error} onRetry={() => programs.reload()} />}

            {programs.data &&
              (groups.length === 0 ? (
                <Empty title="Ningún plan coincide" note="Probá con menos letras." />
              ) : (
                groups.map(([code, g]) => (
                  <section key={code} className="faculty">
                    <h3 className="faculty__name">
                      {g.name}
                      <span className="faculty__code tnum">{code}</span>
                    </h3>
                    <ul className="plans">
                      {g.items.map((p) => {
                        const mine =
                          current &&
                          selectionId(current) === selectionId({ level, campus, program: p.code });
                        return (
                          <li key={`${p.faculty_code}-${p.code}`}>
                            <button
                              className={`plan ${mine ? 'is-mine' : ''}`}
                              onClick={() => choose(p)}
                            >
                              <span className="plan__code tnum">{p.code}</span>
                              <span className="plan__name">{p.name}</span>
                              {p.catalog_fetched_at && (
                                <span className="plan__cached" title="catálogo ya cacheado" />
                              )}
                              {mine && (
                                <Check
                                  className="plan__check"
                                  size={15}
                                  strokeWidth={2.5}
                                  aria-hidden="true"
                                />
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))
              ))}
          </>
        )}
      </section>
    </Layout>
  );
}
