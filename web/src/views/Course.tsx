import { useEffect, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Clock, MapPin, RefreshCw, User } from 'lucide-react';
import { FETCH_COOLDOWN, routes } from '../api/client';
import type { ClassSession, CourseDetail, Section } from '../api/types';
import { useApi } from '../hooks/useApi';
import { Layout } from '../components/Layout';
import { AddButton } from '../components/AddButton';
import { Empty, Fault, Loading } from '../components/States';
import { Seats } from '../components/Seats';
import { formatCountdown, sentence, titleCase } from '../lib/format';
import './Course.css';

const DAYS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export function Course() {
  const { campus = '', program = '', code = '', level = 'pregrado' } = useParams();
  const [params] = useSearchParams();
  const faculty = params.get('f') ?? '';

  const scope = { level, campus, faculty };
  const path = routes.course(scope, program, code);
  const { data, error, loading, elapsed, attempt, reload } = useApi<CourseDetail>(path);

  /**
   * A dónde vuelve la flecha.
   *
   * Estaba fija al catálogo, y desde Mi semestre eso mandaba a una pantalla en
   * la que nunca se había estado. No es un atajo roto: es una salida que
   * miente sobre el camino recorrido.
   *
   * Quién lo dice es el enlace de origen, con el `state` de react-router. Se
   * eligió eso y no un `?from=` en la URL porque de dónde vienes no es parte
   * de la identidad de la asignatura: dos URLs distintas para la misma ficha
   * ensuciarían el historial y lo que se copie y pegue.
   *
   * Tampoco `navigate(-1)`: con la URL pegada a pelo, "atrás" saca de la app.
   *
   * El `state` de react-router vive en el history del navegador, así que
   * sobrevive a recargar la página. Lo que no sobrevive es entrar por un
   * enlace pegado en una pestaña nueva — y ahí el catálogo del plan es
   * justamente la respuesta correcta, porque no hay camino que recordar.
   */
  const from = (useLocation().state as { from?: string } | null)?.from;

  const back =
    from === 'semester'
      ? { to: '/semestre', label: 'mi semestre' }
      : {
          to: `/nivel/${level}/sede/${campus}/plan/${program}${faculty ? `?f=${faculty}` : ''}`,
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
  const fetchedAt = data?.fetched_at;
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
  const fault = error && !rateLimited ? error : null;

  return (
    <Layout>
      {/* Sin migas de pan, hace falta una salida explícita. Una sola, y al
          sitio del que se vino: el catálogo de este plan. */}
      <Link className="back" to={back.to}>
        <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
        {back.label}
      </Link>

      {loading && !data && (
        <Loading elapsed={elapsed} attempt={attempt} what="Trayendo la asignatura" />
      )}
      {fault && <Fault error={fault} onRetry={() => reload()} />}
      {rateLimited && <p className="course__cooldown">{rateLimited.humane}</p>}

      {data && (
        <>
          {/* Mismo `.head` que el catálogo y Mi semestre: identidad a la
              izquierda, lo que la pantalla ofrece a la derecha. En las listas
              eso de la derecha es un conteo; acá es la acción, porque una
              ficha no tiene nada que contar a nivel de página. */}
          <header className="head">
            <div>
              <p className="eyebrow tnum">
                {data.code}
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

          {data.description && <p className="course__desc">{data.description}</p>}

          {data.sections.length === 0 ? (
            <Empty
              title="Sin grupos este semestre"
              note="La asignatura existe en el plan, pero no tiene oferta programada. No es un error: el SIA la devuelve así."
            />
          ) : (
            <section>
              {/* La barra va acá y no pegada al header como en las listas: en
                  ellas lo que sigue al header es la tabla, y la barra la
                  gobierna. Acá en medio hay una descripción, que es
                  continuación del título y no algo sobre lo que este botón
                  actúe. Partirla con un control dejaba el botón mandando sobre
                  un texto con el que no tiene nada que ver. */}
              <div className="toolbar">
                {/* El mismo chip de Mi semestre, con la cuenta atrás metida en
                    el `.chip__code` que el catálogo usa para el número de
                    filtros puestos. Acá la cuenta atrás SÍ se muestra —a
                    diferencia de Mi semestre— porque es una sola asignatura y
                    el número se refresca de verdad cada segundo. */}
                <button
                  className="chip"
                  onClick={measureAll}
                  disabled={measuring || cooldownLeft > 0}
                  title={
                    measuring
                      ? 'Preguntándole al SIA por los cupos.'
                      : cooldownLeft > 0
                        ? 'Se midió hace un momento. El dato que ves es el mismo que traería preguntar otra vez.'
                        : 'Mide los cupos de todos los grupos a la vez.'
                  }
                >
                  <RefreshCw
                    size={14}
                    strokeWidth={1.75}
                    className={measuring ? 'spin' : undefined}
                    aria-hidden="true"
                  />
                  {measuring ? 'midiendo' : 'medir cupos'}
                  {cooldownLeft > 0 && !measuring && (
                    <span className="chip__code tnum">{formatCountdown(cooldownLeft)}</span>
                  )}
                </button>

                <p className="toolbar__note">Mide los cupos de todos los grupos a la vez.</p>
              </div>

              {/* El equivalente de la fila de cabeceras de columna de las dos
                  listas: versalitas micro sobre un filete. Lo que separa la
                  tabla de lo que hay encima. */}
              <div className="groups__bar">
                <h2 className="groups__head">
                  {data.sections.length} {data.sections.length === 1 ? 'grupo' : 'grupos'}
                </h2>
              </div>

              <ul className={`groups ${measuring ? 'is-measuring' : ''}`}>
                {data.sections.map((s) => (
                  <SectionRow key={s.key} section={s} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Layout>
  );
}

function SectionRow({ section }: { section: Section }) {
  return (
    <li className="group">
      <div className="group__id">
        {/* La clave, no el número: cinco grupos pueden llamarse "Grupo 1" y
            lo único que los distingue es este token. */}
        <span className="group__key tnum">{section.key}</span>
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
      <span className="sched__day">{DAYS[c.weekday] ?? '—'}</span>
      <span className="sched__time tnum">
        {c.start_time}–{c.end_time}
      </span>
      <span className="sched__where">
        <MapPin size={13} strokeWidth={1.75} aria-hidden="true" />
        {where || 'aula no informada'}
      </span>
    </li>
  );
}
