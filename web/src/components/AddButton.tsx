import { Ban, Check, Plus, Trash2 } from 'lucide-react';
import { usePlan } from '../hooks/usePlan';
import { itemId, type PlanItem } from '../lib/storage';
import { MAX_ITEMS } from '../state/planContext';
import { Tooltip } from './Tooltip';
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

  // El semestre es de MIS planes —uno, o dos con doble titulación
  // (PLAN-DOUBLE-TITULATION.md). Una asignatura de un plan que no es mío
  // traería grupos y tipología que no son los que veo, así que el botón se
  // apaga en vez de dejar mezclar. Quitar sigue permitido: sacar nunca hace
  // daño.
  const foreign = plan.plans.length > 0 && !plan.owns(item);

  // D7: una asignatura, un plan. El guardia real vive en `PlanProvider.add()`
  // (por `code`, no por `itemId`); acá solo se anticipa el estado para no
  // ofrecer un botón que va a rebotar, y para decir DE QUÉ plan ya está.
  const dupOf = !added ? plan.items.find((i) => i.code === item.code) : undefined;

  const blocked = !added && (plan.full || foreign || !!dupOf);

  const label = added
    ? 'Quitar del semestre'
    : foreign
      ? 'Esta asignatura es de otro plan'
      : dupOf
        ? `Ya está en tu semestre desde el plan ${dupOf.program}`
        : plan.full
          ? 'El semestre está lleno'
          : 'Agregar al semestre';

  // El tooltip puede permitirse decir más que el nombre accesible: acá es
  // donde alguien se entera de POR QUÉ está apagado el botón, no solo de
  // que lo está.
  const tooltip = foreign ? (
    <>
      <p className="tt-title">{label}</p>
      <p className="tt-body">
        Sus grupos y su tipología son los que ve ese plan, no el que tienes abierto — mezclarlas
        los dejaría mal contados.
      </p>
    </>
  ) : dupOf ? (
    <>
      <p className="tt-title">{label}</p>
      <p className="tt-body">Se inscribe por un solo plan.</p>
    </>
  ) : blocked ? (
    <>
      <p className="tt-title">{label}</p>
      <p className="tt-body">Hasta {MAX_ITEMS} materias a la vez. Quita alguna para agregar esta.</p>
    </>
  ) : (
    <p className="tt-title">{label}</p>
  );

  function toggle(e: React.MouseEvent) {
    // Estas filas son enlaces: sin esto, agregar navegaría a la materia.
    e.preventDefault();
    e.stopPropagation();
    if (added) plan.remove(id);
    else plan.add(item);
  }

  return (
    <Tooltip content={tooltip}>
      <button
        className={`add add--${variant} ${added ? 'is-added' : ''}`}
        onClick={toggle}
        disabled={blocked}
        aria-label={label}
        aria-pressed={added}
      >
        {/* El icono dice el estado sin leer nada: la tilde es "ya está", la
            cruz es "se puede", el prohibido es "acá no". Ya está + hover es
            la misma caneca que borra en Mi semestre —mismo gesto, misma
            señal— superpuesta a la tilde y alternada por CSS, no por
            estado: es una pista visual, no un cambio de qué botón es. */}
        {added ? (
          <span className="add__icon">
            <Check className="add__icon--idle" size={16} strokeWidth={2.5} aria-hidden="true" />
            <Trash2 className="add__icon--hover" size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
        ) : blocked ? (
          <Ban size={16} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
        )}
        {variant === 'full' && (
          <span className="add__text">{added ? 'en mi semestre' : 'agregar al semestre'}</span>
        )}
      </button>
    </Tooltip>
  );
}
