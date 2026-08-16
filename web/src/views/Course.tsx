import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Clock, MapPin, RefreshCw, User } from 'lucide-react';
import { FETCH_COOLDOWN, routes } from '../api/client';
import type { ClassSession, CourseDetail, Section } from '../api/types';
import { useApi } from '../hooks/useApi';
import { Layout } from '../components/Layout';
import { AddButton } from '../components/AddButton';
import { IconButton } from '../components/IconButton';
import { Empty, Fault, Loading } from '../components/States';
import { Seats } from '../components/Seats';
import { sentence, titleCase } from '../lib/format';
import './Course.css';

const DAYS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export function Course() {
  const { campus = '', program = '', code = '', level = 'pregrado' } = useParams();
  const [params] = useSearchParams();
  const faculty = params.get('f') ?? '';

  const scope = { level, campus, faculty };
  const path = routes.course(scope, program, code);
  const { data, error, loading, elapsed, attempt, reload } = useApi<CourseDetail>(path);

  const backToCatalog = `/nivel/${level}/sede/${campus}/plan/${program}${faculty ? `?f=${faculty}` : ''}`;

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
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // La medición más reciente de la asignatura: el POST del SIA las sella todas
  // a la vez, así que la más nueva marca cuándo se habló con el SIA.
  const freshestSeats = data?.sections?.reduce<number | null>(
    (min, s) =>
      s.seats ? (min === null ? s.seats.age_seconds : Math.min(min, s.seats.age_seconds)) : min,
    null,
  );
  useEffect(() => {
    if (freshestSeats === null || freshestSeats === undefined) return;
    const left = FETCH_COOLDOWN - freshestSeats;
    if (left > 0) setCooldownUntil((prev) => Math.max(prev, Date.now() + left * 1000));
  }, [freshestSeats]);

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
      <Link className="back" to={backToCatalog}>
        <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
        catálogo del plan {program}
      </Link>

      {loading && !data && (
        <Loading elapsed={elapsed} attempt={attempt} what="Trayendo la asignatura" />
      )}
      {fault && <Fault error={fault} onRetry={() => reload()} />}
      {rateLimited && <p className="course__cooldown">{rateLimited.humane}</p>}

      {data && (
        <>
          <header className="course">
            <div className="course__id">
              <p className="eyebrow tnum">
                {data.code}
                <span className="head__dot">·</span>
                {data.credits} créditos
                <span className="head__dot">·</span>
                {data.typology}
              </p>
              <h1 className="course__title">{sentence(data.name)}</h1>
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
              <div className="groups__bar">
                <h2 className="groups__head">
                  {data.sections.length} {data.sections.length === 1 ? 'grupo' : 'grupos'}
                </h2>

                <div className="head__actions">
                  {cooldownLeft > 0 && !measuring && (
                    <span className="groups__wait tnum">{cooldownLeft} s</span>
                  )}
                  <IconButton
                    onClick={measureAll}
                    disabled={measuring || cooldownLeft > 0}
                    tip="left"
                    className={measuring ? 'is-spinning' : ''}
                    label={
                      measuring
                        ? 'Midiendo…'
                        : cooldownLeft > 0
                          ? `Recién medido: esperar ${cooldownLeft} s`
                          : 'Medir los cupos de todos los grupos'
                    }
                  >
                    <RefreshCw size={18} strokeWidth={1.75} />
                  </IconButton>
                </div>
              </div>

              <p className="groups__note">
                El botón mide los cupos de todos los grupos a la vez.
              </p>

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
