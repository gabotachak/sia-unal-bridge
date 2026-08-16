import { useParams, useSearchParams } from 'react-router';
import { routes } from '../api/client';
import type { ClassSession, CourseDetail, Section } from '../api/types';
import { useApi } from '../hooks/useApi';
import { Layout } from '../components/Layout';
import { AddButton } from '../components/AddButton';
import { Empty, Fault, Loading } from '../components/States';
import { Seats } from '../components/Seats';
import './Course.css';

const DAYS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export function Course() {
  const { campus = '', program = '', code = '', level = 'pregrado' } = useParams();
  const [params] = useSearchParams();
  const faculty = params.get('f') ?? '';

  const scope = { level, campus, faculty };
  const path = routes.course(scope, program, code);
  const { data, error, loading, freshness, elapsed, reload } = useApi<CourseDetail>(path);

  /**
   * Medir los cupos = volver a pedir la asignatura con max_age=0.
   *
   * UN botón para toda la materia, no uno por grupo: el POST del detalle trae
   * TODOS los grupos con sus cupos en la misma respuesta. Un botón por grupo
   * daría a entender que se puede medir uno solo más barato, y además dos
   * clics costarían dos consultas idénticas al SIA para el mismo dato.
   */
  const measuring = loading && !!data;
  function measureAll() {
    reload(routes.course(scope, program, code, 0));
  }

  return (
    <Layout
      crumbs={[
        { label: level, to: `/nivel/${level}` },
        { label: campus, to: `/nivel/${level}/sede/${campus}` },
        {
          label: program,
          to: `/nivel/${level}/sede/${campus}/plan/${program}${faculty ? `?f=${faculty}` : ''}`,
        },
        { label: code },
      ]}
      freshness={freshness}
    >
      {loading && !data && <Loading elapsed={elapsed} what="Trayendo la asignatura y sus grupos" />}
      {error && <Fault error={error} onRetry={() => reload()} />}

      {data && (
        <>
          <header className="course">
            <p className="eyebrow">
              {data.code}
              <span className="course__sep">·</span>
              {data.credits} créditos
              <span className="course__sep">·</span>
              {data.typology}
            </p>
            <h1 className="course__title">{data.name}</h1>

            <div className="course__actions">
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
            </div>

            {data.description && <p className="course__desc">{data.description}</p>}
          </header>

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
                <button className="btn" onClick={measureAll} disabled={measuring}>
                  {measuring ? 'midiendo…' : 'medir cupos'}
                </button>
              </div>
              <p className="groups__note">
                Una sola consulta trae los cupos de todos los grupos: el SIA los devuelve
                juntos en la misma respuesta.
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
        <span className="group__key">{section.key}</span>
        <span className="group__label">{section.label ?? `Grupo ${section.number}`}</span>
        {section.site && <span className="group__site">{section.site}</span>}
      </div>

      <div className="group__body">
        <p className="group__teacher">{section.instructor || 'sin profesor asignado'}</p>

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
  return (
    <li className="sched__row">
      <span className="sched__day">{DAYS[c.weekday] ?? '—'}</span>
      <span className="sched__time">
        {c.start_time}–{c.end_time}
      </span>
      <span className="sched__where">
        {[c.room, c.building].filter(Boolean).join(' · ') || 'aula no informada'}
      </span>
    </li>
  );
}
