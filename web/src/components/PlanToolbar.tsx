import { Check, Eraser, Ticket } from 'lucide-react';
import type { Measure } from '../hooks/useCourseDetails';
import type { PlanItem } from '../lib/storage';
import { usePlan } from '../hooks/usePlan';
import { usePlanView } from '../hooks/usePlanView';
import { useConfirm } from './Confirm';
import { MeasureChip } from './MeasureChip';

/**
 * Los tres controles de la lista del semestre: medir cupos, dejar solo los
 * grupos con cupo, y vaciar.
 *
 * Vive acá y no en Mi semestre porque Mi horario pinta la MISMA tabla sobre la
 * MISMA lista, y las tres acciones son sobre la lista, no sobre la pantalla.
 * Teniéndolo dos veces, el próximo control que se agregue en una se olvidaría
 * en la otra — misma razón por la que existe `TableHead`.
 *
 * Trae su propio diálogo de confirmación: quien la usa no tiene que acordarse
 * de pintarlo.
 */
export function PlanToolbar({
  measure,
  running,
  ready,
  onMeasure,
  className = 'toolbar',
}: {
  measure: Measure;
  running: boolean;
  /** Las materias que el enfriamiento deja volver a medir. */
  ready: PlanItem[];
  onMeasure: () => void;
  /** Mi horario la mete en la cabecera de su panel, que tiene su propio
   *  reparto: ahí no es la barra de la pantalla. */
  className?: string;
}) {
  const plan = usePlan();
  const { onlyOpen, toggleOnlyOpen } = usePlanView();
  const [ask, confirmDialog] = useConfirm();

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
      title: 'Vaciar la lista',
      danger: true,
      confirmLabel: 'Vaciar la lista',
      body: (
        <>
          <p>Se quita {n === 1 ? 'la materia' : `las ${n} materias`} de Mi semestre.</p>
          <p>
            Tu plan sigue siendo el mismo, así que puedes volver a agregarlas desde el catálogo.
          </p>
        </>
      ),
    });
    if (!ok) return;
    plan.clear();
  }

  return (
    <div className={className}>
      {confirmDialog}

      <MeasureChip
        measure={measure}
        running={running}
        disabled={running || ready.length === 0}
        onClick={onMeasure}
      />

      {/* Mismo icono y mismas palabras que el chip del catálogo: es la
          misma pregunta —"¿qué puedo tomar hoy?"— hecha sobre grupos en
          vez de sobre asignaturas. Dibujarla distinto la hacía parecer
          otra cosa. */}
      <button
        className={`chip ${onlyOpen ? 'is-on' : ''}`}
        onClick={toggleOnlyOpen}
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
  );
}
