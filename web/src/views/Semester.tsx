import { useMemo, useState } from 'react';
import { Check, Eraser, Ticket } from 'lucide-react';
import { FETCH_COOLDOWN } from '../api/client';
import { formatAge } from '../lib/format';
import { itemId } from '../lib/storage';
import { Layout } from '../components/Layout';
import { AppLink } from '../components/AppLink';
import { useConfirm } from '../components/Confirm';
import { CourseCard } from '../components/CourseCard';
import { Empty } from '../components/States';
import { MeasureChip } from '../components/MeasureChip';
import { MeasureProgress } from '../components/MeasureProgress';
import { TableHead } from '../components/TableHead';
import type { TableCol } from '../lib/table';
import { SEATS_RANK, sortBy, type SortKey } from '../lib/sort';
import { useTableSort } from '../hooks/useTableSort';
import { useCourseDetails, type Row } from '../hooks/useCourseDetails';
import { usePlan } from '../hooks/usePlan';
import { useScheduleConflicts } from '../hooks/useScheduleConflicts';
import { useScheduleSelection } from '../hooks/useScheduleSelection';
import './Semester.css';

export function Semester() {
  const plan = usePlan();
  const [ask, confirmDialog] = useConfirm();
  const [onlyOpen, setOnlyOpen] = useState(false);

  const { rows, running, done, total, ready, measure, fetchAll } = useCourseDetails(plan.items);

  // El mismo radio que Mi horario, la misma selección: elegir un grupo acá
  // se ve marcado allá sin recargar (ver state/ScheduleProvider.tsx).
  const { selection, pick } = useScheduleSelection();
  const { conflicts } = useScheduleConflicts(rows, selection);

  /**
   * Vaciar la lista sin tocar el plan.
   *
   * Antes la única forma de empezar de cero era cambiar de plan y volver, que
   * es una operación mucho más grande —y que además obligaba a pasar por el
   * selector dos veces— para conseguir esto. Son dos decisiones distintas:
   * "ya no quiero estas materias" no es "me cambié de carrera".
   *
   * Con confirmación porque borra trabajo y no hay deshacer.
   */
  async function clearAll() {
    const n = plan.items.length;
    if (n === 0) return;
    const ok = await ask({
      title: 'Vaciar Mi semestre',
      danger: true,
      confirmLabel: 'Vaciar la lista',
      body: (
        <>
          <p>Se quita {n === 1 ? 'la materia' : `las ${n} materias`} de la lista.</p>
          <p>
            Tu plan sigue siendo el mismo, así que puedes volver a agregarlas desde el catálogo.
          </p>
        </>
      ),
    });
    if (!ok) return;
    plan.clear();
  }

  /**
   * El orden es SOLO de pantalla: `rows` sigue el de `plan.items`, que es el
   * que manda a la hora de medir y de guardar. Reordenar la fuente haría que
   * pulsar una cabecera cambiara el orden de las peticiones al SIA, que no
   * tiene nada que ver con lo que se pidió.
   *
   * `null` = el orden en que se fueron agregando, que es el de partida.
   */
  const { sort, onSort } = useTableSort('semester');
  const shownRows = useMemo(
    () => (sort ? sortBy(rows, (r) => sortKeyOf(r, sort.col), sort.dir) : rows),
    [rows, sort],
  );

  const totals = summarize(rows);
  const empty = plan.items.length === 0;

  return (
    <Layout>
      {confirmDialog}
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
        <div className="toolbar">
          <MeasureChip
            measure={measure}
            running={running}
            disabled={running || ready.length === 0}
            onClick={() => void fetchAll(true, ready)}
          />

          {/* Mismo icono y mismas palabras que el chip del catálogo: es la
              misma pregunta —"¿qué puedo tomar hoy?"— hecha sobre grupos en
              vez de sobre asignaturas. Dibujarla distinto la hacía parecer
              otra cosa. */}
          <button
            className={`chip ${onlyOpen ? 'is-on' : ''}`}
            onClick={() => setOnlyOpen((v) => !v)}
            aria-pressed={onlyOpen}
            title="Deja solo los grupos que tienen cupo ahora mismo."
          >
            {onlyOpen ? (
              <Check size={14} strokeWidth={2.5} aria-hidden="true" />
            ) : (
              <Ticket size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            con cupos
          </button>

          {/* Chip como los otros dos, y no el icono pelado de `.toolbar__clear`
              del catálogo: allá ese botón es un deshacer contextual —solo
              existe si hay filtros puestos, y anula los controles de su propia
              barra—, y esto es una acción por derecho propio que está siempre.
              Mismo rol que los vecinos, misma forma. */}
          <button
            className="chip chip--danger"
            onClick={clearAll}
            title="Quita las materias de la lista. Tu plan no se toca."
          >
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            vaciar
          </button>
        </div>
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
          <MeasureProgress running={running} done={done} total={total} />

          <div className="table sem__table">
            <TableHead sort={sort} onSort={onSort} />
            <ul className="sem">
              {shownRows.map((r) => {
                const id = itemId(r.item);
                return (
                  <CourseCard
                    key={id}
                    row={r}
                    onlyOpen={onlyOpen}
                    onRemove={() => plan.remove(id)}
                    linkFrom="semester"
                    selection={{
                      pickedKey: selection[id] ?? null,
                      onPick: (key) => pick(id, key),
                      conflictKeys:
                        selection[id] && conflicts.conflictItems.has(id)
                          ? new Set([selection[id]])
                          : new Set(),
                    }}
                  />
                );
              })}
            </ul>
          </div>

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

/** Misma escala de cupos que el catálogo: los cuatro estados en una recta. */
function sortKeyOf(r: Row, col: TableCol): SortKey {
  switch (col) {
    case 'code':
      return r.item.code;
    case 'name':
      return r.item.name;
    case 'typology':
      return r.item.typology;
    case 'credits':
      return r.item.credits;
    case 'seats': {
      if (!r.detail) return SEATS_RANK.unknown;
      if (r.detail.sections.length === 0) return SEATS_RANK.noOffer;
      const n = r.detail.sections.reduce((sum, sec) => sum + (sec.seats?.available ?? 0), 0);
      return n === 0 ? SEATS_RANK.full : n;
    }
  }
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
