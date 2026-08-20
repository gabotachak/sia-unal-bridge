import { FETCH_COOLDOWN } from '../api/client';
import { formatAge } from '../lib/format';
import { Layout } from '../components/Layout';
import { AppLink } from '../components/AppLink';
import { Empty } from '../components/States';
import { PlanList } from '../components/PlanList';
import { PlanToolbar } from '../components/PlanToolbar';
import { useCourseDetails, type Row } from '../hooks/useCourseDetails';
import { usePlan } from '../hooks/usePlan';
import { useScheduleConflicts } from '../hooks/useScheduleConflicts';
import { useScheduleSelection } from '../hooks/useScheduleSelection';
import './Semester.css';

export function Semester() {
  const plan = usePlan();

  const { rows, running, done, total, ready, measure, fetchAll } = useCourseDetails(plan.items);

  // El mismo radio que Mi horario, la misma selección: elegir un grupo acá
  // se ve marcado allá sin recargar (ver state/ScheduleProvider.tsx).
  //
  // Se calcula acá y no dentro de `PlanList` porque Mi horario ya lo tiene
  // que calcular para el calendario: teniéndolo el padre, el componente
  // compartido recibe el resultado en vez de rehacerlo en cada pantalla.
  const { selection } = useScheduleSelection();
  const { conflicts } = useScheduleConflicts(rows, selection);

  const totals = summarize(rows);
  const empty = plan.items.length === 0;

  return (
    <Layout>
      {/* Mismo reparto que el catálogo: el título a la izquierda y el conteo
          a la derecha, a la altura del título. Los controles NO viven acá —
          bajan a la barra de chips, que es donde el catálogo los tiene. */}
      <header className="head">
        <div>
          <p className="eyebrow">planificador</p>
          <h1 className="head__title">Mi semestre</h1>
        </div>

        <p className="head__meta tnum">
          {plan.items.length} de 10 materias
          {totals.sections > 0 && (
            <>
              <span className="head__dot">·</span>
              {totals.open} de {totals.sections} grupos con cupo
            </>
          )}
        </p>
      </header>

      {!empty && (
        <PlanToolbar
          measure={measure}
          running={running}
          ready={ready}
          onMeasure={() => void fetchAll(true, ready)}
        />
      )}

      {empty ? (
        <>
          <Empty
            title="Todavía no agregaste materias"
            note="Toca el + en las asignaturas que estés considerando. Aquí podrás ver los cupos de todos sus grupos con un solo botón."
          />
          {plan.selection && (
            <p className="sem__back">
              <AppLink
                className="btn btn--primary"
                to={{ name: 'program', selection: plan.selection }}
              >
                ir al catálogo
              </AppLink>
            </p>
          )}
        </>
      ) : (
        <>
          <PlanList
            rows={rows}
            running={running}
            done={done}
            total={total}
            conflictItems={conflicts.conflictItems}
            linkFrom="semester"
          />

          {/* Dice dos cosas y las dos cambian lo que alguien hace con la
              pantalla: que el número tiene fecha, y por qué el botón a veces
              no toca una materia. Cómo repartimos las peticiones entre las
              conexiones del pool no cambia nada de eso: es asunto nuestro. */}
          <p className="sem__note">
            Cada cupo lleva su hora de medición. El botón solo vuelve a preguntar por materias
            con más de {formatAge(FETCH_COOLDOWN)} sin medir.
          </p>
        </>
      )}
    </Layout>
  );
}

function summarize(rows: Row[]) {
  let sections = 0;
  let open = 0;
  for (const r of rows) {
    for (const s of r.detail?.sections ?? []) {
      sections++;
      if ((s.seats?.available ?? 0) > 0) open++;
    }
  }
  return { sections, open };
}
