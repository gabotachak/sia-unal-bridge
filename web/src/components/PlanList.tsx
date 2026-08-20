import { useMemo } from 'react';
import { CourseCard } from './CourseCard';
import { MeasureProgress } from './MeasureProgress';
import { TableHead } from './TableHead';
import { usePlan } from '../hooks/usePlan';
import { usePlanView } from '../hooks/usePlanView';
import { useScheduleSelection } from '../hooks/useScheduleSelection';
import type { Row } from '../hooks/useCourseDetails';
import { candidateConflictKeys, type Block } from '../lib/conflicts';
import { courseSortKey, sortBy } from '../lib/sort';
import { itemId } from '../lib/storage';

/**
 * La lista de materias del plan: la barra de progreso de la medición y la
 * tabla de tarjetas con sus grupos.
 *
 * Existe porque estaba escrita dos veces, palabra por palabra, en Mi
 * semestre y en el panel de Mi horario — la MISMA cabecera, las MISMAS
 * tarjetas, el MISMO `useMemo` de orden. Lo único que las distinguía era el
 * `linkFrom` de la tarjeta.
 *
 * Lo que NO hace, y es la parte que importa: no llama a `useCourseDetails`.
 * Recibe `rows` ya medidos. Mi horario los necesita también para el
 * calendario (`useScheduleConflicts` → `chosen` → bloques), así que si el
 * fetch viviera acá adentro habría dos máquinas de medición sobre los
 * mismos `plan.items`, cada una con su cooldown y su progreso.
 *
 * Lo que sí saca por su cuenta es lo que ya es estado global —el plan, cómo
 * se está mirando, qué grupo está elegido—, porque no es del padre: son
 * Contexts, y pasarlos como props sería reenviarlos por gusto.
 *
 * La barra de chips (`PlanToolbar`) se queda fuera a propósito. En Mi
 * semestre va suelta bajo el encabezado y en Mi horario va dentro de
 * `.sched__list-head`, al lado del botón de ocultar el panel. Es el mismo
 * componente en dos envoltorios distintos, no el mismo bloque.
 */
export function PlanList({
  rows,
  running,
  done,
  total,
  chosenBlocks,
  linkFrom,
}: {
  /** En el orden de `plan.items` — el de agregado. Ordenar es cosa de acá. */
  rows: Row[];
  running: boolean;
  done: number;
  total: number;
  /** Los bloques YA elegidos, de `useScheduleConflicts` en el padre, que ya
   *  los armó para lo suyo (el calendario, en Mi horario). Con esto cada
   *  tarjeta calcula qué filas propias —elegidas o no— chocan contra un
   *  grupo elegido de OTRA materia. */
  chosenBlocks: Block[];
  linkFrom: 'semester' | 'schedule';
}) {
  const plan = usePlan();
  const { selection, pick } = useScheduleSelection();

  /**
   * El orden es SOLO de pantalla: `rows` llega en el orden de `plan.items`,
   * que es el que manda a la hora de medir y de guardar. Reordenar la fuente
   * haría que pulsar una cabecera cambiara el orden de las peticiones al
   * SIA, que no tiene nada que ver con lo que se pidió.
   *
   * `null` = el orden en que se fueron agregando, que es el de partida.
   *
   * Filtro y orden salen del Context (`usePlanView`) y no de un `useState`:
   * las dos pantallas pintan esta misma tabla y tiene que encontrarse como
   * se dejó en la otra.
   */
  const { onlyOpen, sort, onSort } = usePlanView();
  const shownRows = useMemo(
    () => (sort ? sortBy(rows, (r) => courseSortKey(r, sort.col), sort.dir) : rows),
    [rows, sort],
  );

  return (
    <>
      <MeasureProgress running={running} done={done} total={total} />

      <div className="table table--list">
        <TableHead sort={sort} onSort={onSort} />
        <ul className="table__cards">
          {shownRows.map((r) => {
            const id = itemId(r.item);
            // Por grupo, no por materia: si el elegido no choca, la fila
            // elegida queda tranquila aunque una alternativa suya sí
            // chocaría — ver el comentario de `candidateConflictKeys`.
            const conflictKeys = r.detail
              ? candidateConflictKeys(id, r.detail.sections, chosenBlocks)
              : new Set<string>();
            return (
              <CourseCard
                key={id}
                row={r}
                onlyOpen={onlyOpen}
                onRemove={() => plan.remove(id)}
                linkFrom={linkFrom}
                selection={{
                  pickedKey: selection[id] ?? null,
                  onPick: (key) => pick(id, key),
                  conflictKeys,
                }}
              />
            );
          })}
        </ul>
      </div>
    </>
  );
}
