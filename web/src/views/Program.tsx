import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Check,
  CornerUpLeft,
  HelpCircle,
  SlidersHorizontal,
  Ticket,
  TriangleAlert,
  X,
} from 'lucide-react';
import { get, routes } from '../api/client';
import type { CourseDetail, CoursesResponse, CourseSummary, Section } from '../api/types';
import { useApi } from '../hooks/useApi';
import { useCatalogFilters } from '../hooks/useCatalogFilters';
import { useCourseDetails } from '../hooks/useCourseDetails';
import { usePlan } from '../hooks/usePlan';
import { useScheduleConflicts } from '../hooks/useScheduleConflicts';
import { useScheduleSelection } from '../hooks/useScheduleSelection';
import { Layout } from '../components/Layout';
import { AppLink } from '../components/AppLink';
import { AvailabilityFields } from '../components/AvailabilityPicker';
import { useConfirm } from '../components/Confirm';
import { AddButton } from '../components/AddButton';
import { Empty, Fault, Loading } from '../components/States';
import { SearchInput } from '../components/SearchInput';
import { SeatsFigure } from '../components/Seats';
import { TableHead } from '../components/TableHead';
import { Tooltip } from '../components/Tooltip';
import type { TableCol } from '../lib/table';
import { SEATS_RANK, sortBy, type SortKey } from '../lib/sort';
import { useTableSort } from '../hooks/useTableSort';
import { fold, formatAge, sentence } from '../lib/format';
import { courseConflictsWithChosen } from '../lib/conflicts';
import { DEFAULT_AVAILABILITY, courseFitsAvailability, isAvailabilityActive } from '../lib/availability';
import { pooled } from '../lib/pooled';
import { itemId, selectionId } from '../lib/storage';
import type { Screen } from '../state/nav';
import './Program.css';

/**
 * El catálogo de un plan. Hasta ~700 asignaturas (Medellín: 694).
 *
 * Los filtros son en memoria a propósito: el catálogo completo ya vino en la
 * misma respuesta, así que filtrar en el servidor costaría otra consulta al
 * SIA para mostrar menos de lo que ya tenemos.
 */
export function Program({ screen }: { screen: Extract<Screen, { name: 'program' }> }) {
  const sel = screen.selection;
  const { level, campus, faculty, program } = sel;

  const path = routes.courses({ level, campus, faculty }, program);
  const { data, error, loading, elapsed, attempt, reload } =
    useApi<CoursesResponse>(path);

  /**
   * Los filtros.
   *
   * Tipología y créditos son conjuntos, no un valor: "3 o 4 créditos" y
   * "obligatorias y optativas" son preguntas normales, y con un desplegable de
   * una sola opción había que elegir dos veces y comparar de memoria. Los
   * valores son pocos y fijos —siete tipologías, una decena de créditos— así
   * que caben todos a la vista, con cuántas asignaturas hay en cada uno.
   *
   * Viven en `useCatalogFilters` (Context), no en `useState` local: ir a la
   * ficha de una asignatura desmonta esta pantalla, y sin Context los
   * filtros —y el scroll— se perdían en el viaje de ida y vuelta.
   */
  const {
    q,
    setQ,
    typols,
    setTypols,
    creds,
    setCreds,
    onlyOpen,
    setOnlyOpen,
    hideConflicts,
    setHideConflicts,
    availability,
    setAvailability,
    showFacets,
    setShowFacets,
    scrollY,
    setScrollY,
  } = useCatalogFilters();

  /**
   * El plan elegido, para saber qué materias tienen grupo elegido en Mi
   * horario (issue #28).
   *
   * Se trae acá arriba —y no más abajo, donde ya se usaba para "estás
   * mirando otro plan"— porque hace falta antes: da los `plan.items` con los
   * que se mide el choque de horario.
   */
  const plan = usePlan();

  const courseId = useCallback(
    (c: CourseSummary) => itemId({ level, campus, program, code: c.code }),
    [level, campus, program],
  );

  /**
   * Qué materias del catálogo chocan en horario con un grupo YA elegido en
   * Mi horario (issue #28: "Filtro por horario").
   *
   * Los grupos con su horario solo existen para las materias de Mi
   * semestre —el catálogo en sí trae cupos agregados, no horario por
   * grupo (`CourseSummary` vs. `CourseDetail`, ver api/types.ts)— así que
   * el choque solo se puede saber para esas, como mucho diez
   * (`MAX_ITEMS`). Es el MISMO `useCourseDetails` que usan Mi semestre y Mi
   * horario, con el mismo pool y el mismo cooldown: entrar al catálogo no
   * dispara nada que esas pantallas no disparen ya solas.
   *
   * `courseConflictsWithChosen` mira TODOS los grupos de la materia, no
   * solo el elegido: acá puede no haber ninguno elegido todavía, y el punto
   * es avisar ANTES de elegir que ninguno —o casi ninguno— va a encajar.
   */
  const { rows: planRows } = useCourseDetails(plan.items);
  const { selection: scheduleSelection } = useScheduleSelection();
  const { blocks: chosenBlocks } = useScheduleConflicts(planRows, scheduleSelection);

  /**
   * El choque de horario también para materias que NI SIQUIERA están en el
   * plan, con tal de que su detalle ya esté cacheado de una consulta
   * anterior (`c.seats` puesto: alguien ya midió sus cupos, así que el
   * back tiene sus grupos guardados en Postgres).
   *
   * Sin `c.seats` no se pide: eso es "nadie preguntó todavía" (el `?` de la
   * columna CUPOS), y pedirlo dispararía un POST de verdad contra el SIA —
   * hasta 40 a la vez si alguien limpia todos los filtros, un pool de 4
   * conexiones no da abasto. CON `c.seats` puesto, en cambio, el pedido es
   * un acierto de cache casi seguro: Postgres contesta, no el SIA.
   *
   * Nunca "activo" (rojo): estas materias no están en el plan, así que
   * nunca tienen un grupo ELEGIDO — como mucho "potencial" (ocre), igual
   * que una materia del plan todavía sin grupo.
   */
  const requestedExtra = useRef(new Set<string>());
  const [extraSections, setExtraSections] = useState<Record<string, Section[]>>({});
  useEffect(() => {
    const CAP = 40;
    const inPlan = new Set(plan.items.map((it) => itemId(it)));
    const candidates = (data?.courses ?? [])
      .filter((c) => c.seats && !inPlan.has(courseId(c)) && !requestedExtra.current.has(courseId(c)))
      .slice(0, CAP);
    if (candidates.length === 0) return;
    for (const c of candidates) requestedExtra.current.add(courseId(c));

    let cancelled = false;
    void pooled(candidates, 4, async (c) => {
      try {
        const res = await get<CourseDetail>(routes.course({ level, campus, faculty }, program, c.code));
        if (!cancelled) {
          setExtraSections((prev) => ({ ...prev, [courseId(c)]: res.data.sections }));
        }
      } catch {
        // Silencioso a propósito: esto es un aviso de más sobre una materia
        // que nadie pidió ver en detalle todavía. Que falle no puede tumbar
        // el catálogo — la fila se queda sin marcar, como si no se hubiera
        // intentado.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [data, plan.items, courseId, level, campus, faculty, program]);

  /**
   * Dos niveles, no uno — issue #28 ampliado: rojo si el grupo YA elegido
   * choca (un bloqueo real, ya armado); ocre si la materia no tiene grupo
   * elegido todavía pero alguno de sus grupos chocaría (un aviso, antes de
   * comprometerse). Con un grupo ya elegido, el único que cuenta para "choca
   * de verdad" es ESE — una alternativa suya que chocaría no vuelve a la
   * materia un problema, porque nadie la eligió.
   */
  const conflictCourseIds = useMemo(() => {
    const active = new Set<string>();
    const potential = new Set<string>();
    for (const row of planRows) {
      if (!row.detail) continue;
      const id = itemId(row.item);
      const pickedKey = scheduleSelection[id];
      if (pickedKey) {
        const chosenSection = row.detail.sections.filter((s) => s.key === pickedKey);
        if (courseConflictsWithChosen(id, chosenSection, chosenBlocks)) active.add(id);
      } else if (courseConflictsWithChosen(id, row.detail.sections, chosenBlocks)) {
        potential.add(id);
      }
    }
    for (const [id, sections] of Object.entries(extraSections)) {
      if (active.has(id) || potential.has(id)) continue; // ya cubierta como materia del plan
      if (courseConflictsWithChosen(id, sections, chosenBlocks)) potential.add(id);
    }
    return { active, potential };
  }, [planRows, chosenBlocks, scheduleSelection, extraSections]);

  /**
   * Todo el detalle que hay a mano, plan + cacheado, por id de materia — la
   * misma fuente que arma `conflictCourseIds`, reusada acá para el filtro
   * de disponibilidad (issue "cuándo puedo tomar clase"). Sin esto cada
   * materia visible recalcularía su propio detalle con un `.find` sobre
   * `planRows` en medio del filtro de las ~700 filas.
   */
  const sectionsByCourseId = useMemo(() => {
    const map: Record<string, Section[]> = { ...extraSections };
    for (const row of planRows) {
      if (row.detail) map[itemId(row.item)] = row.detail.sections;
    }
    return map;
  }, [planRows, extraSections]);

  /**
   * Restaura el scroll UNA vez, apenas hay filas que pintar — antes de eso
   * la página mide menos alto que el que tenía cuando se guardó, y
   * `scrollTo` cae corto.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !data || data.courses.length === 0) return;
    restored.current = true;
    if (scrollY > 0) window.scrollTo(0, scrollY);
  }, [data, scrollY]);

  /**
   * Guarda el scroll EN CADA scroll, no al desmontar.
   *
   * Se probó al desmontar primero y no servía: el cleanup de un efecto
   * corre después de que React ya pintó la pantalla siguiente, y para
   * cuando por fin se ejecutaba, el navegador ya había reflowado con la
   * página nueva —más corta— y `window.scrollY` ya no era el de acá, sino
   * el que el navegador recortó solo. Escuchando el scroll en vivo, el
   * valor guardado siempre es el último real de ESTA pantalla, tomado
   * mientras todavía existía.
   */
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrollY(window.scrollY);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [setScrollY]);

  // Los valores que EXISTEN en este plan, con su cuenta. Nada de listas fijas:
  // Medellín llega a 12 créditos y Bogotá no pasa de 6.
  const facets = useMemo(() => {
    const byTypology = new Map<string, number>();
    const byCredits = new Map<number, number>();
    for (const c of data?.courses ?? []) {
      if (c.typology) byTypology.set(c.typology, (byTypology.get(c.typology) ?? 0) + 1);
      byCredits.set(c.credits, (byCredits.get(c.credits) ?? 0) + 1);
    }
    return {
      typologies: [...byTypology.keys()].sort((a, b) => a.localeCompare(b, 'es')),
      credits: [...byCredits.keys()].sort((a, b) => a - b),
      byTypology,
      byCredits,
    };
  }, [data]);

  /** Se recuerda entre visitas. `null` = como lo mandó el SIA, ya alfabético. */
  const { sort, onSort } = useTableSort('catalog');

  const shown = useMemo(() => {
    const needle = fold(q);
    const kept = (data?.courses ?? []).filter((c) => {
      if (needle && !fold(c.name).includes(needle) && !fold(c.code).includes(needle)) return false;
      if (typols.size && !typols.has(c.typology)) return false;
      if (creds.size && !creds.has(c.credits)) return false;
      if (onlyOpen && !hasRoom(c)) return false;
      if (hideConflicts) {
        const id = courseId(c);
        if (conflictCourseIds.active.has(id) || conflictCourseIds.potential.has(id)) return false;
      }
      if (isAvailabilityActive(availability)) {
        // Sin detalle a mano no se puede saber si encaja — se cae del
        // filtro en vez de mostrarse sin marcar, porque acá el punto ES
        // filtrar: enseñar una materia que podría no encajar rompería la
        // confianza en el resultado.
        const sections = sectionsByCourseId[courseId(c)];
        if (!sections || !courseFitsAvailability(sections, availability)) return false;
      }
      return true;
    });
    return sort ? sortBy(kept, (c) => sortKeyOf(c, sort.col), sort.dir) : kept;
  }, [
    data,
    q,
    typols,
    creds,
    onlyOpen,
    hideConflicts,
    conflictCourseIds,
    availability,
    sectionsByCourseId,
    courseId,
    sort,
  ]);

  const total = data?.courses.length ?? 0;
  const facetCount = typols.size + creds.size + (isAvailabilityActive(availability) ? 1 : 0);
  const filtering = !!q || facetCount > 0 || onlyOpen || hideConflicts;

  /**
   * Libre elección aparte del resto, con un atajo al lado.
   *
   * Es la tipología más numerosa con diferencia (215 de 694 en este plan) y
   * la que casi nadie busca junto con las demás: se arma el semestre con las
   * obligatorias y optativas del plan, y las libres se miran aparte —o se
   * excluyen de un toque, que es lo que da el chip sintético. No es una
   * tipología real del SIA: es `nonLibreTypologies` completo, así que
   * alternarlo compone con el resto de chips igual que cualquier selección
   * manual.
   */
  const libreTypology = facets.typologies.find((t) => t.startsWith('LIBRE'));
  const nonLibreTypologies = facets.typologies.filter((t) => !t.startsWith('LIBRE'));
  const notLibreActive =
    nonLibreTypologies.length > 0 &&
    typols.size === nonLibreTypologies.length &&
    nonLibreTypologies.every((t) => typols.has(t));
  const notLibreCount = nonLibreTypologies.reduce((n, t) => n + (facets.byTypology.get(t) ?? 0), 0);
  function toggleNotLibre() {
    pickTypology(notLibreActive ? new Set() : new Set(nonLibreTypologies));
  }

  /**
   * Marcar TODAS las tipologías filtra exactamente igual que no marcar
   * ninguna —`typols.has(c.typology)` no excluye a nadie de cualquiera de
   * las dos formas— así que dejarlas todas en verde mentía: parecía un
   * filtro fuerte ("filtros 7") cuando en la lista de abajo no faltaba
   * nada. Elegir la última que cierra el conjunto completo lo vacía en vez
   * de completarlo — vuelve al estado real: sin filtro.
   */
  function pickTypology(next: ReadonlySet<string> | ((prev: ReadonlySet<string>) => ReadonlySet<string>)) {
    setTypols((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      return resolved.size === facets.typologies.length && facets.typologies.length > 0
        ? new Set()
        : resolved;
    });
  }

  function clearAll() {
    setQ('');
    setTypols(new Set());
    setCreds(new Set());
    setOnlyOpen(false);
    setHideConflicts(false);
    setAvailability(DEFAULT_AVAILABILITY);
  }

  /**
   * El plan de esta pantalla contra el plan elegido.
   *
   * Casi siempre son el mismo. La excepción es llegar acá desde un candidato
   * de un 300 ambiguo (ver Fault en States.tsx) sin haber confirmado el
   * cambio: ahí `sel` es el plan que se está MIRANDO, y `plan.selection` sigue
   * siendo el de siempre. No se toca nada por las malas — se avisa y se deja
   * decidir, porque cambiar de verdad borra el semestre.
   *
   * `plan` en sí ya se trajo arriba, para el choque de horario.
   */
  const [ask, confirmDialog] = useConfirm();
  const { selection, select } = plan;
  const foreign = selection && selectionId(selection) !== selectionId(sel);

  async function adoptThis() {
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
              semestre, porque {n === 1 ? 'es' : 'son'} del plan <b>{selection?.programName}</b>.
            </p>
            <p>Sus grupos y su tipología son de ese plan, no de este.</p>
          </>
        ),
      });
      if (!ok) return;
    }
    select(sel);
  }

  return (
    <Layout>
      {confirmDialog}
      {foreign && selection && (
        <div className="stray" role="status">
          <p className="stray__text">
            Estás mirando el plan <b>{program}</b>, y el tuyo es <b>{selection.programName}</b>.
            Puedes mirar todo lo que quieras, pero para agregar materias al semestre tienes que
            estar en tu plan.
          </p>
          <div className="stray__actions">
            <AppLink className="btn" to={{ name: 'program', selection }}>
              <CornerUpLeft size={15} strokeWidth={1.75} aria-hidden="true" />
              volver al mío
            </AppLink>
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
        <Loading elapsed={elapsed} attempt={attempt} what="Trayendo el catálogo" />
      )}
      {error && <Fault error={error} level={level} onRetry={() => reload()} />}

      {data && (
        <>
          <div className="toolbar">
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Buscar por nombre o código…"
              label="Buscar asignatura"
              className="search--flex"
            />

            {/* El filtro que más se usa va arriba y solo: es una pregunta de
                sí o no —"¿puedo meterme hoy?"— y no compite con las otras. */}
            <Tooltip
              content={
                <p className="tt-body">
                  Deja solo las que tienen cupo. Las que nunca se han consultado también se
                  quedan: es mejor que sobre una a que se pierda una con cupos.
                </p>
              }
            >
              <button
                className={`chip ${onlyOpen ? 'is-on' : ''}`}
                onClick={() => setOnlyOpen((v) => !v)}
                aria-pressed={onlyOpen}
              >
                {onlyOpen ? (
                  <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  <Ticket size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
                con cupos
              </button>
            </Tooltip>

            {/* Al lado de "con cupos": la misma pregunta de sí o no, pero de
                horario en vez de cupo. Destacar el choque (ver `.row.is-conflict`
                más abajo) queda siempre puesto; este chip es solo para quien
                además quiere que desaparezcan de la lista (issue #28). */}
            <Tooltip
              content={
                <p className="tt-body">
                  Oculta las que chocan en horario con un grupo que ya elegiste en Mi horario.
                  Las que chocan igual se destacan en la lista mientras este chip está apagado.
                </p>
              }
            >
              <button
                className={`chip ${hideConflicts ? 'is-on' : ''}`}
                onClick={() => setHideConflicts((v) => !v)}
                aria-pressed={hideConflicts}
              >
                {hideConflicts ? (
                  <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
                sin choques
              </button>
            </Tooltip>

            {/* Solo se ve en el teléfono (CSS). El número es lo que evita que
                plegar esconda información: dice cuántas facetas hay puestas
                sin tener que abrir a mirar. */}
            <button
              className={`chip filters__toggle ${facetCount ? 'is-on' : ''}`}
              onClick={() => setShowFacets((v) => !v)}
              aria-expanded={showFacets}
              aria-controls="facetas"
            >
              <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
              filtros
              {facetCount > 0 && <span className="chip__code tnum">{facetCount}</span>}
            </button>

            {filtering && (
              <Tooltip content={<p className="tt-title">Quitar los filtros</p>}>
                <button className="toolbar__clear" onClick={clearAll} aria-label="Quitar los filtros">
                  <X size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
          </div>

          <div className={`filters ${showFacets ? 'is-open' : ''}`} id="facetas">
            <div className="filters__row">
              <span className="filters__label">tipología</span>
              <div className="chips">
                {nonLibreTypologies.map((t) => (
                  <Tooltip
                    key={t}
                    content={
                      <>
                        <p className="tt-eyebrow">Tipología</p>
                        <p className="tt-title">{t}</p>
                      </>
                    }
                  >
                    <button
                      className={`chip chip--sm ${typols.has(t) ? 'is-on' : ''}`}
                      onClick={() => pickTypology((s) => toggle(s, t))}
                      aria-pressed={typols.has(t)}
                    >
                      {sentence(t.replace(/\s*\([^)]*\)\s*$/, ''))}
                      <span className="chip__code tnum">{facets.byTypology.get(t)}</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>

            {/* Aparte del resto: no es una tipología más entre siete, es la
                pregunta "¿libres sí o no?", binaria. */}
            <div className="filters__row">
              <span className="filters__label">electivas</span>
              <div className="chips">
                {libreTypology && (
                  <Tooltip
                    content={
                      <>
                        <p className="tt-eyebrow">Tipología</p>
                        <p className="tt-title">{libreTypology}</p>
                      </>
                    }
                  >
                    <button
                      className={`chip chip--sm ${typols.has(libreTypology) ? 'is-on' : ''}`}
                      onClick={() => pickTypology((s) => toggle(s, libreTypology))}
                      aria-pressed={typols.has(libreTypology)}
                    >
                      {sentence(libreTypology.replace(/\s*\([^)]*\)\s*$/, ''))}
                      <span className="chip__code tnum">{facets.byTypology.get(libreTypology)}</span>
                    </button>
                  </Tooltip>
                )}
                {nonLibreTypologies.length > 0 && (
                  <Tooltip
                    content={
                      <p className="tt-body">Todas las tipologías del plan menos libre elección.</p>
                    }
                  >
                    <button
                      className={`chip chip--sm ${notLibreActive ? 'is-on' : ''}`}
                      onClick={toggleNotLibre}
                      aria-pressed={notLibreActive}
                    >
                      Todas menos libre elección
                      <span className="chip__code tnum">{notLibreCount}</span>
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>

            <div className="filters__row">
              <span className="filters__label">créditos</span>
              <div className="chips">
                {facets.credits.map((n) => (
                  <Tooltip
                    key={n}
                    content={<p className="tt-title">{n} {n === 1 ? 'crédito' : 'créditos'}</p>}
                  >
                    <button
                      className={`chip chip--sm ${creds.has(n) ? 'is-on' : ''}`}
                      onClick={() => setCreds((s) => toggle(s, n))}
                      aria-pressed={creds.has(n)}
                    >
                      <span className="tnum">{n}</span>
                      <span className="chip__code tnum">{facets.byCredits.get(n)}</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>

            {/* "Cuándo puedo": la misma pregunta que tipología o créditos
                —"¿qué se queda en la lista?"— aplicada al horario que se
                está armando, no una caja aparte. */}
            <div className="filters__row">
              <span className="filters__label">horario</span>
              <AvailabilityFields value={availability} onChange={setAvailability} />
            </div>
          </div>

          {shown.length === 0 ? (
            <Empty
              title="Ninguna asignatura coincide"
              note="Quita algún filtro. Ojo: la tipología depende del plan, no de la asignatura."
            />
          ) : (
            <div className="table">
              {/* La cabecera comparte la MISMA rejilla que las filas: es lo que
                  hace que las columnas queden alineadas sin usar <table>, que
                  no sabe truncar celdas sin romper el ancho. */}
              <TableHead sort={sort} onSort={onSort} />

              <ul className="rows">
                {shown.map((c) => {
                  const id = courseId(c);
                  // Rojo: el grupo YA elegido choca — un bloqueo real. Ocre:
                  // todavía no elegiste grupo, pero alguno de los que hay
                  // chocaría — un aviso, antes de comprometerte.
                  const isActiveConflict = conflictCourseIds.active.has(id);
                  const isPotentialConflict = conflictCourseIds.potential.has(id);
                  const inConflict = isActiveConflict || isPotentialConflict;
                  return (
                  <li key={c.code}>
                    <AppLink
                      className={`row table__row ${isActiveConflict ? 'is-conflict' : ''} ${isPotentialConflict ? 'is-conflict-potential' : ''}`}
                      to={{ name: 'course', selection: sel, code: c.code }}
                    >
                      <span className="row__code tnum col-code">{c.code}</span>
                      <span className="row__name">
                        {inConflict && (
                          <Tooltip
                            content={
                              <p className="tt-body">
                                {isActiveConflict
                                  ? 'El grupo elegido choca con tu horario actual.'
                                  : 'Los horarios de esta materia chocan con tu horario actual.'}
                              </p>
                            }
                          >
                            <span
                              className="row__conflict-icon"
                              role="img"
                              aria-label={
                                isActiveConflict
                                  ? 'El grupo elegido choca con tu horario actual'
                                  : 'Los horarios de esta materia chocan con tu horario actual'
                              }
                            >
                              <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
                            </span>
                          </Tooltip>
                        )}
                        <Tooltip content={<p className="tt-title">{sentence(c.name)}</p>} onlyIfTruncated>
                          <span className="row__name-text">{sentence(c.name)}</span>
                        </Tooltip>
                      </span>
                      <Tooltip
                        content={
                          <>
                            <p className="tt-eyebrow">Tipología</p>
                            <p className="tt-title">{c.typology}</p>
                          </>
                        }
                      >
                        <span className={`tag tag--${slugTypology(c.typology)} col-typ`}>
                          {shortTypology(c.typology)}
                        </span>
                      </Tooltip>
                      <span className="row__credits tnum col-cr">{c.credits}</span>
                      <SeatsCell seats={c.seats} askedAt={c.detail_fetched_at} />
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
                    </AppLink>
                  </li>
                  );
                })}
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
 * Tres estados, y la diferencia entre dos de ellos es la que importa:
 *
 *   sin preguntar   → un signo de pregunta. Nadie pidió el detalle todavía.
 *   sin grupos      → 0. Se preguntó y el SIA contestó que no hay oferta.
 *   con grupos      → el número, verde si queda algo y óxido si es cero.
 *
 * Los dos primeros se veían igual —un guion— y eso era mentir por omisión:
 * "no sé" y "no hay" son respuestas distintas. Lo que los separa es
 * `detail_fetched_at`, el sello de la última vez que este plan pidió el
 * detalle.
 *
 * Sin botón de recargar a propósito: acá se muestra lo que la base YA tiene.
 * Un botón por fila invitaría a disparar una consulta al SIA por cada una de
 * las 313 asignaturas. El signo de pregunta no es un botón aparte —la fila
 * entera ya es un enlace— sino la señal de que ahí adentro hay algo que
 * averiguar: entrar a la asignatura mide todos sus grupos de un POST.
 */
function SeatsCell({
  seats,
  askedAt,
}: {
  seats?: CourseSummary['seats'];
  askedAt?: string | null;
}) {
  if (!seats) {
    if (!askedAt) {
      return (
        <Tooltip
          content={<p className="tt-body">Nunca se le preguntó al SIA por esta asignatura. Ábrela para medir sus cupos.</p>}
        >
          <span className="row__seats is-unknown col-seats">
            <HelpCircle size={15} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Cupos sin consultar</span>
          </span>
        </Tooltip>
      );
    }
    // "Sin grupos" tampoco es para siempre: la UNAL puede programar oferta
    // mañana. Así que lleva su edad igual que todo lo demás — la del sello del
    // detalle, calculada acá porque el reloj del servidor solo sella los cupos.
    const age = formatAge((Date.now() - Date.parse(askedAt)) / 1000);
    return (
      <Tooltip
        content={
          <>
            <p className="tt-title">Sin grupos programados</p>
            <p className="tt-body">Consultado el {new Date(askedAt).toLocaleString('es-CO')}.</p>
          </>
        }
      >
        <span className="row__seats is-none col-seats">
          <SeatsFigure available={null} announce={false} />
          <small>
            sin grupos<span className="row__age tnum"> · {age}</span>
          </small>
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip
      content={
        <ul className="tt-rows">
          <li className="tt-row">
            <span>Cupos</span>
            <b className="tnum">{seats.available}</b>
          </li>
          <li className="tt-row">
            <span>Grupos</span>
            <b className="tnum">{seats.sections}</b>
          </li>
          <li className="tt-row">
            <span>Medido</span>
            <b>{new Date(seats.measured_at).toLocaleString('es-CO')}</b>
          </li>
        </ul>
      }
    >
      <span className={`row__seats col-seats ${seats.available === 0 ? 'is-zero' : 'is-open'}`}>
        {/* Sin animar: en el catálogo el número no cambia después de cargar, y
            313 filas aleteando en la primera pintura serían ruido y trabajo por
            nada. La forma y el color sí son los mismos que en la ficha. */}
        <SeatsFigure available={seats.available} tone={seats.available === 0 ? 'empty' : 'ok'} />
        <small className="tnum">{formatAge(seats.age_seconds)}</small>
      </span>
    </Tooltip>
  );
}

/**
 * Por qué se ordena cada columna. Cupos es la única con matiz: los cuatro
 * estados de la celda caen en una sola recta según SEATS_RANK.
 */
function sortKeyOf(c: CourseSummary, col: TableCol): SortKey {
  switch (col) {
    case 'code':
      return c.code;
    case 'name':
      return c.name;
    case 'typology':
      return c.typology;
    case 'credits':
      return c.credits;
    case 'seats':
      if (!c.seats) {
        // El sello del detalle es lo único que separa 'no hay grupos' de
        // 'nadie preguntó': sin cupos y sin sello, no se midió nunca.
        return c.detail_fetched_at ? SEATS_RANK.noOffer : SEATS_RANK.unknown;
      }
      return c.seats.available === 0 ? SEATS_RANK.full : c.seats.available;
  }
}

/** Añade o quita, sin mutar: React solo repinta si el objeto es otro. */
function toggle<T>(set: ReadonlySet<T>, v: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(v)) next.add(v);
  return next;
}

/**
 * ¿Se puede entrar hoy?
 *
 * Las nunca consultadas cuentan como que SÍ, y es a propósito: de esas no se
 * sabe nada, y esconderlas por no saber sería tomar la decisión por quien
 * busca. Que sobre una asignatura con un `?` es barato; que se pierda una con
 * cupos porque nadie la había abierto todavía, no.
 *
 * Las que sí se consultaron y no tienen grupos, o los tienen llenos, se van:
 * de esas la respuesta ya se sabe.
 */
function hasRoom(c: CourseSummary): boolean {
  if (c.seats) return c.seats.available > 0;
  return !c.detail_fetched_at;
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
