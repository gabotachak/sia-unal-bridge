import { usePlan } from '../hooks/usePlan';
import { itemId, selectionId, type PlanItem } from '../lib/storage';
import './AddButton.css';

type Props = {
  item: Omit<PlanItem, 'addedAt'>;
  /** 'plus' para las filas del catálogo, 'full' para la ficha de la materia. */
  variant?: 'plus' | 'full';
};

/** El botón de agregar al semestre. Alterna: si ya está, lo quita. */
export function AddButton({ item, variant = 'plus' }: Props) {
  const plan = usePlan();
  const id = itemId(item);
  const added = plan.has(id);

  // El semestre es de UN plan. Una asignatura de otro plan traería grupos y
  // tipología que no son los que este plan ve, así que el botón se apaga en
  // vez de dejar mezclar. Quitar sigue permitido: sacar nunca hace daño.
  const foreign =
    !!plan.selection && selectionId(plan.selection) !== selectionId(item);

  const blocked = !added && (plan.full || foreign);

  const label = added
    ? 'Quitar del semestre'
    : foreign
      ? 'Esta asignatura es de otro plan'
      : plan.full
        ? 'El semestre está lleno'
        : 'Agregar al semestre';

  function toggle(e: React.MouseEvent) {
    // Estas filas son enlaces: sin esto, agregar navegaría a la materia.
    e.preventDefault();
    e.stopPropagation();
    if (added) plan.remove(id);
    else plan.add(item);
  }

  return (
    <button
      className={`add add--${variant} ${added ? 'is-added' : ''}`}
      onClick={toggle}
      disabled={blocked}
      title={label}
      aria-label={label}
      aria-pressed={added}
    >
      <span className="add__glyph" aria-hidden="true">
        {added ? '✓' : '+'}
      </span>
      {variant === 'full' && (
        <span className="add__text">{added ? 'en el semestre' : 'agregar al semestre'}</span>
      )}
    </button>
  );
}
