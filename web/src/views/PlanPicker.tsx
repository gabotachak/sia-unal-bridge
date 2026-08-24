import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  Check,
  Combine,
  GraduationCap,
  Layers,
  TriangleAlert,
  X,
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
import { SearchInput } from '../components/SearchInput';
import { useConfirm } from '../components/Confirm';
import { Empty, Fault, Loading } from '../components/States';
import { abbreviateEngineering, fold, sentence } from '../lib/format';
import { planCodes, planNames, planSelection, selectionId, type Selection } from '../lib/storage';
import { useNav } from '../state/nav';
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
 *
 * Doble titulación (PLAN-DOUBLE-TITULATION.md): una casilla, sin marcar por
 * defecto, deja elegir DOS planes en vez de uno. Toda la elección vive en un
 * borrador local de esta pantalla (`draft`) y `plan.select()` se llama una
 * sola vez, con la lista completa — así nunca queda un estado a medias
 * guardado en el navegador.
 */
export function PlanPicker() {
  const plan = usePlan();
  const [ask, confirmDialog] = useConfirm();
  const { navigate } = useNav();
  const current = plan.selection;

  // El punto de partida es donde ya estás: cambiar de plan casi siempre es
  // cambiar DENTRO de la misma sede, así que empezar en blanco haría repetir
  // dos elecciones idénticas.
  const [level, setLevel] = useState(current?.level ?? 'pregrado');
  const [campus, setCampus] = useState(current?.campus ?? '');
  const [q, setQ] = useState('');

  // La casilla nace de lo que ya hay, así que volver a esta pantalla con dos
  // planes la encuentra marcada sola. El borrador es SOLO de esta pantalla:
  // mientras no haya dos planes elegidos, nada de esto tocó el navegador.
  const [double, setDouble] = useState(() => plan.plans.length > 1);
  const [draft, setDraft] = useState<Selection[]>([]);
  // Con el primer plan del borrador puesto, sede y nivel quedan fijos (D3):
  // la doble titulación no cruza sedes ni mezcla niveles.
  const locked = draft.length > 0;

  // Elegir sede revela doble titulación + plan más abajo; el scroll los sigue
  // solo, en vez de dejar que el clic entierre lo nuevo fuera de vista.
  const revealRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (campus) revealRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [campus]);

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
   * Fija el conjunto de planes de una vez. Es la única función que llama a
   * `plan.select()`, y lo hace una sola vez por elección — el borrador de
   * doble titulación nunca toca el navegador antes de llegar acá.
   *
   * El precio se dice antes de cobrarlo: es la única acción de la app que
   * destruye trabajo del usuario, y solo cuando de verdad destruye algo.
   * `planSelection` (misma regla que usa `PlanApi.select` por dentro) dice
   * si este conjunto es 'wipe' (hay que confirmar — ya había un plan
   * elegido, y es OTRO), 'filter' (elegir el primer plan de todos: no hay
   * nada que confirmar, aunque haya materias guardadas de antes — ver
   * `applySelect`) o 'keep' (volver al tablero de siempre).
   */
  async function commit(nextPlans: Selection[]) {
    const outcome = planSelection(plan.plans, nextPlans);
    if (!outcome) return; // el picker ya impide que esto pase (D3, MAX_PLANS)

    if (outcome === 'wipe' && plan.items.length > 0) {
      const n = plan.items.length;
      const double = nextPlans.length > 1;
      const ok = await ask({
        title: double ? 'Elegir dos planes' : 'Cambiar de plan',
        danger: true,
        confirmLabel: double ? 'Elegir estos dos planes' : `Cambiar a ${nextPlans[0].program}`,
        body: (
          <>
            <p>
              {double ? (
                <>
                  Elegir <b>{planNames(nextPlans)}</b> reinicia el tablero.
                </>
              ) : (
                <>
                  Pasar a <b>{abbreviateEngineering(nextPlans[0].programName)}</b> reinicia el tablero.
                </>
              )}
            </p>
            <p>
              Se va a borrar {n === 1 ? 'la materia guardada' : `las ${n} materias guardadas`} en Mi
              semestre, porque {n === 1 ? 'es' : 'son'}{' '}
              {plan.plans.length > 1 ? (
                <>
                  de los planes <b>{planNames(plan.plans)}</b>
                </>
              ) : (
                <>
                  del plan <b>{planNames(plan.plans)}</b>
                </>
              )}{' '}
              y sus grupos no son los mismos aquí.
            </p>
          </>
        ),
      });
      if (!ok) return;
    }

    const ok = plan.select(nextPlans);
    if (!ok) return;
    navigate({ name: 'program', selection: nextPlans[0] }, { replace: true });
  }

  async function choose(p: ProgramRef) {
    const next: Selection = {
      level,
      campus,
      campusName: p.campus_name,
      faculty: p.faculty_code,
      facultyName: p.faculty_name,
      program: p.code,
      programName: p.name,
    };

    // Con la casilla marcada, el primer clic no navega: lo deja en el
    // borrador y espera al segundo.
    if (double && draft.length === 0) {
      setDraft([next]);
      return;
    }

    await commit(double ? [draft[0], next] : [next]);
  }

  const first = !current; // primera vez: no hay nada que perder ni a dónde volver

  return (
    <Layout>
      {confirmDialog}
      <header className="setup__head">
        <p className="eyebrow rise">{first ? 'catálogo de asignaturas · sia unal' : 'ajustes'}</p>

        {/* La primera vez esto es una portada, no un formulario: la pregunta
            grande en serif y la palabra que importa en cursiva. Volviendo a
            cambiar de plan ya no hay nada que presentar, así que el título se
            achica y dice lo que hace. */}
        <h1 className="setup__title rise" style={{ animationDelay: '60ms' }}>
          {first ? (
            <>
              ¿Dónde
              <br />
              <em>estudias?</em>
            </>
          ) : (
            'Cambiar de plan'
          )}
        </h1>

        <p className="setup__lead rise" style={{ animationDelay: '120ms' }}>
          {first ? (
            <>
              Todo lo demás cuelga de aquí. El mismo código de plan existe en varias sedes,
              así que preguntar sin decir dónde no significa nada.
            </>
          ) : plan.plans.length > 1 ? (
            <>
              Tus planes son <b>{planNames(plan.plans)}</b> en {current.campusName.replace(/^SEDE\s+/i, '')}.
            </>
          ) : (
            <>
              Tu plan es <b>{abbreviateEngineering(current.programName)}</b> en{' '}
              {current.campusName.replace(/^SEDE\s+/i, '')}.
            </>
          )}
        </p>

        {!first && plan.items.length > 0 && (
          <p className="setup__warn">
            <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />
            Elegir otro plan borra{' '}
            {plan.items.length === 1 ? 'la materia' : `las ${plan.items.length} materias`} de Mi
            semestre: sus grupos y su tipología son de {plan.plans.length > 1 ? 'estos planes' : 'este plan'}.
          </p>
        )}

        {!first && (
          <button
            className="btn setup__back"
            onClick={() => navigate({ name: 'program', selection: current })}
          >
            <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
            seguir con {planCodes(plan.plans)}
          </button>
        )}
      </header>

      {/* Nada de la cascada se muestra hasta tener los niveles: son la base
          de todo lo demás (sede depende de nivel), y mostrar Sede/Doble
          titulación/Plan vacíos mientras tanto es mostrar una elección que
          todavía no existe. */}
      {levels.error ? (
        <Fault error={levels.error} onRetry={() => levels.reload()} />
      ) : !levels.data ? (
        <Loading elapsed={levels.elapsed} attempt={levels.attempt} what="Trayendo los niveles" />
      ) : (
        <>
      {/* ── 1. Nivel ─────────────────────────────────────────────────
          No está hardcodeado a los tres de siempre: sale de /v1/levels,
          igual que en el back. Si la UNAL agrega uno, aparece acá solo. */}
      <section className="step rise" style={{ animationDelay: '150ms' }}>
        <h2 className="step__label">
          <GraduationCap size={16} strokeWidth={1.75} aria-hidden="true" />
          Nivel
        </h2>
        <div className="chips">
          {levels.data.levels.map((l) => (
            <button
              key={l.slug}
              className={`chip ${l.slug === level ? 'is-on' : ''}`}
              onClick={() => setLevel(l.slug)}
              aria-pressed={l.slug === level}
              disabled={locked}
            >
              {l.slug === level && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
              {l.name}
            </button>
          ))}
        </div>
        {locked && <p className="step__hint">La doble titulación es dentro de una sede y un nivel.</p>}
      </section>

      {/* ── 2. Sede ───────────────────────────────────────────────── */}
      <section className="step rise" style={{ animationDelay: '200ms' }}>
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
                disabled={locked}
              >
                {c.code === campus && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
                {c.name.replace(/^SEDE\s+/i, '')}
                <span className="chip__code tnum">{c.code}</span>
              </button>
            ))}
          </div>
        )}
        {locked && <p className="step__hint">La doble titulación es dentro de una sede y un nivel.</p>}
      </section>

      {/* Paso a paso: sin sede no hay qué doble-titular ni qué plan listar,
          así que ninguna de las dos secciones existe todavía — no es un
          hint pidiendo sede, es que la pregunta no aplica aún. En cuanto
          `campus` tiene valor, las dos entran de una con `.rise` (el mismo
          fundido de toda la pantalla: nada nuevo que enseñar). */}
      {campus && (
        <div ref={revealRef}>
          {/* La puerta de la minoría, y la única forma de que se enteren de
              que existe. Chips sí/no en vez de checkbox: mismo componente
              que nivel y sede, mutuamente excluyentes — nunca los dos
              prendidos ni los dos apagados. "No" es el default, así la
              pantalla sin tocar es la de hoy. */}
          <section className="step rise" style={{ animationDelay: '50ms' }}>
            <h2 className="step__label">
              <Combine size={16} strokeWidth={1.75} aria-hidden="true" />
              ¿Doble titulación?
            </h2>
            <div className="chips">
              <button
                className={`chip ${!double ? 'is-on' : ''}`}
                onClick={() => {
                  setDouble(false);
                  setDraft([]);
                }}
                aria-pressed={!double}
              >
                {!double && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
                No
              </button>
              <button
                className={`chip ${double ? 'is-on' : ''}`}
                onClick={() => {
                  setDouble(true);
                  setDraft([]);
                }}
                aria-pressed={double}
              >
                {double && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
                Sí
              </button>
            </div>
            {/* El progreso del borrador vive DENTRO de esta sección, como
                una variante del hint de siempre — no una segunda caja
                aparte con su propio chip de tamaño completo. Ese pill del
                tamaño de "Sí"/"No" al lado de una frase suelta se leía como
                un elemento roto, no como el segundo paso de la misma
                pregunta. */}
            {double && draft.length > 0 ? (
              <p className="step__hint dt-draft">
                <span className="chip chip--sm is-on">
                  <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                  {draft[0].program}
                  <button
                    type="button"
                    className="dt-draft__x"
                    onClick={() => setDraft([])}
                    aria-label={`Quitar ${draft[0].program} del borrador`}
                  >
                    <X size={11} strokeWidth={2} aria-hidden="true" />
                  </button>
                </span>{' '}
                elegido — falta el segundo, más abajo.
              </p>
            ) : (
              <p className="step__hint">
                {double ? 'Elige tu primer plan más abajo.' : 'Elige tus dos planes; el horario los junta.'}
              </p>
            )}
          </section>

          {/* ── Plan ─────────────────────────────────────────────────── */}
          <section className="step rise" style={{ animationDelay: '100ms' }}>
            <h2 className="step__label">
              <Layers size={16} strokeWidth={1.75} aria-hidden="true" />
              Plan de estudios
              {total > 0 && (
                <span className="step__count tnum">
                  {shown === total ? total : `${shown}/${total}`}
                </span>
              )}
            </h2>

            <SearchInput
              value={q}
              onChange={setQ}
              placeholder={`Buscar entre los planes de ${campusName}…`}
              label="Buscar plan"
            />

            {programs.loading && !programs.data && (
              <Loading
                elapsed={programs.elapsed}
                attempt={programs.attempt}
                what="Trayendo los planes"
              />
            )}
            {programs.error && <Fault error={programs.error} onRetry={() => programs.reload()} />}

            {programs.data &&
              (groups.length === 0 ? (
                <Empty title="Ningún plan coincide" note="Prueba con menos letras." />
              ) : (
                groups.map(([code, g]) => (
                  <section key={code} className="faculty">
                    <h3 className="faculty__name">
                      {sentence(g.name)}
                      <span className="faculty__code tnum">{code}</span>
                    </h3>
                    <ul className="plans">
                      {g.items.map((p) => {
                        const identity = { level, campus, program: p.code };
                        // "Ya es mío" (committed, plan.owns) y "está en el
                        // borrador" (draft, doble titulación a medio elegir)
                        // se marcan igual, pero solo el segundo se deshabilita:
                        // volver a tocar tu propio plan sigue siendo el mismo
                        // gesto de siempre (refresca sus nombres).
                        const already = plan.owns(identity);
                        const inDraft = draft.some((d) => selectionId(d) === selectionId(identity));
                        const marked = already || inDraft;
                        return (
                          <li key={`${p.faculty_code}-${p.code}`}>
                            <button
                              className={`plan ${marked ? 'is-mine' : ''}`}
                              onClick={() => choose(p)}
                              disabled={inDraft}
                            >
                              <span className="plan__code tnum">{p.code}</span>
                              <span className="plan__name">{sentence(p.name)}</span>
                              {p.catalog_fetched_at && (
                                // Sin tooltip a propósito: el punto ya vive
                                // adentro de un `<button>`, y anidarle un
                                // trigger propio metería un segundo parón de
                                // tabulación dentro del mismo control. El
                                // dato queda igual disponible para lectores
                                // de pantalla, tejido en el nombre accesible.
                                <span className="plan__cached" aria-hidden="true" />
                              )}
                              {p.catalog_fetched_at && (
                                <span className="sr-only"> — catálogo ya cacheado</span>
                              )}
                              {marked && (
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
          </section>
        </div>
      )}
        </>
      )}
    </Layout>
  );
}
