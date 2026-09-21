import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Clock, MapPin, RefreshCw, TriangleAlert, User } from 'lucide-react';
import { FETCH_COOLDOWN, routes, STALE_SEATS_SECONDS } from '../api/client';
import type { ClassSession, CourseDetail, Section } from '../api/types';
import { useApi } from '../hooks/useApi';
import { useCourseDetails } from '../hooks/useCourseDetails';
import { putDetail } from '../lib/detailCache';
import { usePlan } from '../hooks/usePlan';
import { useScheduleConflicts } from '../hooks/useScheduleConflicts';
import { useScheduleSelection } from '../hooks/useScheduleSelection';
import { Layout } from '../components/Layout';
import { AppLink } from '../components/AppLink';
import { AddButton } from '../components/AddButton';
import { CopyCode } from '../components/CopyCode';
import { PlanAttributionRow } from '../components/PlanAttributionRow';
import { Empty, Fault, Loading } from '../components/States';
import { Seats } from '../components/Seats';
import { Tooltip } from '../components/Tooltip';
import { candidateConflictKeys } from '../lib/conflicts';
import { WEEKDAYS_LONG, formatClockTime, formatCountdown, sentence, titleCase } from '../lib/format';
import { itemId } from '../lib/storage';
import type { Screen } from '../state/nav';
import './Course.css';

export function Course({ screen }: { screen: Extract<Screen, { name: 'course' }> }) {
  const { selection: sel, code, from, alsoIn } = screen;
  const { level, campus, faculty, program } = sel;

  const scope = { level, campus, faculty };
  // max_age=STALE_SEATS_SECONDS, no el default del servidor: es lo que el
  // tooltip de cupos ya promete ("Ábrela para volver a preguntar"). El
  // read-through decide si eso significa cache o SIA — no hay un segundo
  // useEffect peleando con el cooldown por su cuenta (docs/PLAN-SIACHANGES.md A3).
  const path = routes.course(scope, program, code, STALE_SEATS_SECONDS);
  const { data, freshness, error, loading, elapsed, attempt, reload } = useApi<CourseDetail>(path);

  /**
   * A dónde vuelve la flecha.
   *
   * Estaba fija al catálogo, y desde Mi semestre eso mandaba a una pantalla en
   * la que nunca se había estado. No es un atajo roto: es una salida que
   * miente sobre el camino recorrido.
   *
   * Quién lo dice es quien navegó hasta acá: Mi semestre y Horario ponen
   * `from: 'semester' | 'schedule'` en la pantalla misma al construirla (ver
   * CourseCard.tsx). Antes esto vivía en el `state` de react-router; ahora es
   * un campo más del objeto pantalla, porque la pantalla ES el estado.
   */
  const back =
    from === 'semester'
      ? { to: { name: 'semester' as const }, label: 'mi semestre' }
      : from === 'schedule'
        ? { to: { name: 'schedule' as const }, label: 'mi horario' }
        : {
            to: { name: 'program' as const, selection: sel },
            label: `catálogo del plan ${program}`,
          };

  /**
   * Medir los cupos = volver a pedir la asignatura con max_age=0.
   *
   * UN botón para toda la materia, no uno por grupo: el POST del detalle trae
   * TODOS los grupos con sus cupos en la misma respuesta. Un botón por grupo
   * daría a entender que se puede medir uno solo más barato, y además dos
   * clics costarían dos consultas idénticas al SIA para el mismo dato.
   */
  const measuring = loading && !!data;

  /**
   * El cooldown del botón, en epoch ms. La API rechaza con 429 dos `max_age=0`
   * seguidos sobre la misma asignatura, así que el botón se apaga solo en vez
   * de ofrecer algo que va a rebotar.
   *
   * Se arranca de tres sitios, y ninguno sobra:
   *  - al medir, optimista, para que el botón se apague en el clic;
   *  - de la edad del dato que llegó, porque otro cliente pudo medir hace 5 s
   *    y este todavía no lo sabe;
   *  - del `retry_after_seconds` de un 429, que es la única fuente exacta y
   *    corrige a las otras dos si el FETCH_COOLDOWN horneado quedó desfasado.
   */
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // El intervalo solo corre mientras hay cuenta atrás que mostrar, y se para
  // solo al llegar a cero: con un cooldown de minutos, un tick por segundo
  // permanente serían cientos de renders para no cambiar nada en pantalla.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = window.setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      if (tick >= cooldownUntil) window.clearInterval(t);
    }, 1000);
    return () => window.clearInterval(t);
  }, [cooldownUntil]);

  // Cuándo se habló con el SIA por esta asignatura. Sale de `fetched_at` y no
  // de la edad de los cupos porque es lo mismo que mira el backend
  // (`course_program.detail_fetched_at`, ver internal/httpapi/cooldown.go) — y
  // porque una asignatura sin grupos no tiene cupos de los que sacar una edad,
  // así que por ahí el botón se quedaba encendido y rebotaba con un 429.
  const fetchedAt = data?.detail_fetched_at ?? data?.fetched_at;
  useEffect(() => {
    const at = fetchedAt ? Date.parse(fetchedAt) : NaN;
    if (!Number.isFinite(at)) return;
    const until = at + FETCH_COOLDOWN * 1000;
    if (until > Date.now()) setCooldownUntil((prev) => Math.max(prev, until));
  }, [fetchedAt]);

  useEffect(() => {
    if (error?.status === 429 && error.retryAfter) {
      setCooldownUntil(Date.now() + error.retryAfter * 1000);
    }
  }, [error]);

  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  function measureAll() {
    setCooldownUntil(Date.now() + FETCH_COOLDOWN * 1000);
    reload(routes.course(scope, program, code, 0));
  }

  /**
   * Un 429 del cooldown no es un fallo: la asignatura sigue en pantalla y el
   * dato que se ve es correcto, sólo que es reciente. Sacarlo del banner de
   * error evita gritar "algo salió mal" cuando lo que pasó es que el botón se
   * pulsó dos veces seguidas.
   */
  const rateLimited = error?.status === 429 ? error : null;
  const isNoopWithData = error?.code === 'sia_noop' && data != null;
  const fault = error && !rateLimited && !isNoopWithData ? error : null;

  /**
   * Mismo choque de horario que el catálogo y Mi semestre/horario (issue
   * #28), acá en la ficha: cada grupo contra lo YA elegido en OTRA materia.
   *
   * A diferencia de Program.tsx, acá NO hace falta el detalle de las diez
   * materias del plan: solo importan las que ya tienen grupo elegido —son
   * las únicas que aportan un bloque a `chosenBlocks`—, así que se le pide
   * detalle solo a esas. Una materia del plan sin grupo elegido no cambia
   * nada de lo que se marca en esta ficha, y pedirle el detalle igual sería
   * una consulta de más que esta pantalla no necesita para nada.
   */
  const plan = usePlan();
  const { selection: scheduleSelection } = useScheduleSelection();
  const chosenPlanItems = useMemo(
    () => plan.items.filter((it) => scheduleSelection[itemId(it)]),
    [plan.items, scheduleSelection],
  );
  const { rows: planRows } = useCourseDetails(chosenPlanItems);
  const { blocks: chosenBlocks } = useScheduleConflicts(planRows, scheduleSelection);
  const thisCourseId = itemId({ level, campus, program, code });

  // Lo que se acaba de traer para pintar ESTA ficha le sirve al catálogo para
  // marcar la fila de esta materia sin volver a pedir nada: mirar Turco I y
  // volver atrás deja el catálogo sabiendo sus horarios (lib/detailCache.ts).
  useEffect(() => {
    if (data) putDetail(thisCourseId, data);
  }, [data, thisCourseId]);

  const pickedKey = scheduleSelection[thisCourseId];
  const conflictKeys = data ? candidateConflictKeys(thisCourseId, data.sections, chosenBlocks) : new Set<string>();

  return (
    <Layout>
      {/* Sin migas de pan, hace falta una salida explícita. Una sola, y al
          sitio del que se vino: el catálogo de este plan. */}
      <AppLink className="back" to={back.to}>
        <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
        {back.label}
      </AppLink>

      {loading && !data && (
        <Loading elapsed={elapsed} attempt={attempt} what="Trayendo la asignatura" />
      )}
      {fault && <Fault error={fault} level={level} onRetry={() => reload()} />}
      {rateLimited && <p className="course__cooldown">{rateLimited.humane}</p>}
      {/* X-Cache: stale — el SIA no respondió y la API sirvió lo que ya tenía.
          El dato está a la vista con su edad; esto dice POR QUÉ es viejo. */}
      {freshness?.cache === 'stale' && !error && (
        <p className="course__warning">
          <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            El SIA no respondió ahora mismo. Estos son los últimos datos guardados; mira de cuándo
            es cada cupo.
          </span>
        </p>
      )}
      {isNoopWithData && (
        <p className="course__warning">
          <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
          <span>{error.humane}</span>
        </p>
      )}

      {data && (
        <>
          {/* `.head--stack`, no el `.head` de lado a lado del catálogo y Mi
              semestre: ahí lo de la derecha es un número corto que siempre
              cabe en la misma línea. Acá es un botón junto a un título que
              puede ser una frase entera, y con flex-wrap ese botón saltaba de
              "al lado" a "abajo a la izquierda" según cupiera o no — dos
              lugares distintos para lo mismo. Con columna fija queda siempre
              debajo, en el mismo sitio sin importar el largo del nombre. */}
          <header className="head head--stack">
            <div>
              <p className="eyebrow tnum">
                <CopyCode code={data.code} className="" />
                <span className="head__dot">·</span>
                {data.credits} créditos
                <span className="head__dot">·</span>
                {data.typology}
              </p>
              <h1 className="head__title">{sentence(data.name)}</h1>
            </div>

            <AddButton
              variant="full"
              item={{
                level,
                campus,
                program,
                faculty,
                code: data.code,
                name: data.name,
                credits: data.credits,
                typology: data.typology,
              }}
            />
          </header>

          {/* A qué plan se atribuye esta materia — solo con doble
              titulación, y solo cuando ESTE plan es uno de los míos (D6,
              interfaz §7). `alsoIn` solo se sabe si se llegó desde el
              catálogo unido: desde Mi semestre u Horario la fila de abajo no
              aparece — no se pide el otro catálogo por una línea.
              `PlanAttributionRow` (components/): el mismo diseño que el
              catálogo y Mi semestre/Mi horario, no un tercero. */}
          {plan.plans.length > 1 && plan.owns(sel) && (
            <div className="course__plan-note">
              <PlanAttributionRow
                attr={{ plan: sel, typology: data.typology }}
                plans={plan.plans}
                mine
              />
              {alsoIn && (
                <PlanAttributionRow
                  attr={{ plan: alsoIn.plan, typology: alsoIn.typology }}
                  plans={plan.plans}
                />
              )}
            </div>
          )}

          {data.description && <CourseDescription text={data.description} />}

          <section>
            {/* La barra va acá y no pegada al header como en las listas: en
                ellas lo que sigue al header es la tabla, y la barra la
                gobierna. Acá en medio hay una descripción, que es
                continuación del título y no algo sobre lo que este botón
                actúe. Partirla con un control dejaba el botón mandando sobre
                un texto con el que no tiene nada que ver.

                Vive fuera del `if` de abajo a propósito: una asignatura sin
                grupos también necesita poder pedirle al SIA que vuelva a
                mirar, porque la oferta puede aparecer entre una consulta y
                otra y sin este botón la única forma de enterarse era esperar
                a que venciera el cache solo (issue #10). */}
            <div className="toolbar">
              {/* El mismo chip de Mi semestre, con la cuenta atrás metida en
                  el `.chip__code` que el catálogo usa para el número de
                  filtros puestos. Acá la cuenta atrás SÍ se muestra —a
                  diferencia de Mi semestre— porque es una sola asignatura y
                  el número se refresca de verdad cada segundo. */}
              <Tooltip
                content={
                  <p className="tt-body">
                    {measuring
                      ? 'Preguntándole al SIA por los grupos.'
                      : cooldownLeft > 0
                        ? 'Se midió hace un momento. El dato que ves es el mismo que traería preguntar otra vez.'
                        : 'Vuelve a preguntarle al SIA por los grupos y sus cupos.'}
                  </p>
                }
              >
                <button className="chip" onClick={measureAll} disabled={measuring || cooldownLeft > 0}>
                  <RefreshCw
                    size={14}
                    strokeWidth={1.75}
                    className={measuring ? 'spin' : undefined}
                    aria-hidden="true"
                  />
                  {measuring ? 'actualizando' : 'actualizar grupos'}
                  {cooldownLeft > 0 && !measuring && (
                    <span className="chip__code tnum">{formatCountdown(cooldownLeft)}</span>
                  )}
                </button>
              </Tooltip>
            </div>

            {data.sections.length === 0 ? (
              <Empty
                title="Sin grupos este semestre"
                note="La asignatura existe en el plan, pero no tiene oferta programada. No es un error: el SIA la devuelve así."
              />
            ) : (
              <>
                {/* El equivalente de la fila de cabeceras de columna de las
                    dos listas: versalitas micro sobre un filete. Lo que
                    separa la tabla de lo que hay encima. */}
                <div className="groups__bar">
                  <h2 className="groups__head">
                    {data.sections.length} {data.sections.length === 1 ? 'grupo' : 'grupos'}
                  </h2>
                </div>

                <ul className={`groups ${measuring ? 'is-measuring' : ''}`}>
                  {data.sections.map((s) => (
                    <SectionRow
                      key={s.key}
                      section={s}
                      isActiveConflict={conflictKeys.has(s.key) && pickedKey === s.key}
                      isPotentialConflict={conflictKeys.has(s.key) && pickedKey !== s.key}
                    />
                  ))}
                </ul>
              </>
            )}
          </section>
        </>
      )}
    </Layout>
  );
}

/**
 * La descripción, recortada.
 *
 * El SIA la devuelve como un solo párrafo que mete objetivos, contenido y
 * prerrequisitos sin separación — puede pasar de 1000 caracteres. Sin
 * recorte, empuja la lista de grupos varias pantallas hacia abajo antes de
 * que se vea una sola oferta.
 *
 * El recorte es visual (`-webkit-line-clamp`), no un `slice` del texto: así
 * "ver más" muestra exactamente lo que el SIA escribió, sin puntos
 * suspensivos a mitad de una palabra. El botón solo aparece si el clamp de
 * verdad cortó algo — se mide una vez, comparando el alto real contra el alto
 * recortado, y no se vuelve a medir al expandir/contraer.
 */
function CourseDescription({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text]);

  return (
    <div className="course__desc-wrap">
      <p
        ref={ref}
        className={`course__desc ${!expanded ? 'course__desc--clamped' : ''}`}
      >
        {text}
      </p>
      {clamped && (
        <button
          type="button"
          className="course__desc-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'ver menos' : 'ver más'}
        </button>
      )}
    </div>
  );
}

function SectionRow({
  section,
  isActiveConflict,
  isPotentialConflict,
}: {
  section: Section;
  /** El grupo elegido de verdad y choca — un bloqueo real. */
  isActiveConflict: boolean;
  /** Nadie lo eligió, pero chocaría si se elige — un aviso. */
  isPotentialConflict: boolean;
}) {
  const inConflict = isActiveConflict || isPotentialConflict;
  return (
    <li className={`group ${isActiveConflict ? 'is-conflict' : ''} ${isPotentialConflict ? 'is-conflict-potential' : ''}`}>
      <div className="group__id">
        {/* La clave, no el número: cinco grupos pueden llamarse "Grupo 1" y
            lo único que los distingue es este token. */}
        <span className="group__key tnum">
          {section.key}
          {inConflict && (
            <Tooltip
              content={
                <p className="tt-body">
                  {isActiveConflict
                    ? 'Este horario choca con tu horario actual.'
                    : 'Si eliges este grupo, va a chocar con tu horario actual.'}
                </p>
              }
            >
              <span
                className="group__conflict-icon"
                role="img"
                aria-label={
                  isActiveConflict
                    ? 'Este horario choca con tu horario actual'
                    : 'Si eliges este grupo, va a chocar con tu horario actual'
                }
              >
                <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
              </span>
            </Tooltip>
          )}
        </span>
        <span className="group__label">{section.label ?? `Grupo ${section.number}`}</span>
        {section.site && <span className="group__site">{section.site}</span>}
      </div>

      <div className="group__body">
        <p className="group__teacher">
          <User size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{section.instructor ? titleCase(section.instructor) : 'sin profesor asignado'}</span>
        </p>

        <ul className="sched">
          {section.schedule.length === 0 ? (
            <li className="sched__none">horario no informado</li>
          ) : (
            section.schedule.map((c, i) => <ScheduleRow key={i} c={c} />)
          )}
        </ul>

        <p className="group__tags">
          {section.shift && <span>{section.shift.toLowerCase()}</span>}
          {section.duration && <span>{section.duration.toLowerCase()}</span>}
          {section.site_campus && <span>{section.site_campus.toLowerCase()}</span>}
        </p>
      </div>

      <div className="group__seats">
        {section.seats ? (
          <Seats
            available={section.seats.available}
            measuredAt={section.seats.measured_at}
            ageSeconds={section.seats.age_seconds}
          />
        ) : (
          <p className="group__noseats">sin dato de cupos</p>
        )}
      </div>
    </li>
  );
}

function ScheduleRow({ c }: { c: ClassSession }) {
  const where = [c.room, c.building].filter(Boolean).join(' · ');
  return (
    <li className="sched__row">
      <Clock size={13} strokeWidth={1.75} aria-hidden="true" />
      <span className="sched__day">{WEEKDAYS_LONG[c.weekday] ?? '—'}</span>
      <span className="sched__time tnum">
        {formatClockTime(c.start_time)}–{formatClockTime(c.end_time)}
      </span>
      <span className="sched__where">
        <MapPin size={13} strokeWidth={1.75} aria-hidden="true" />
        {where || 'aula no informada'}
      </span>
    </li>
  );
}
