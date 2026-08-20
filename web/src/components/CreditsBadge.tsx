import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import {
  creditsLevel,
  MIN_CREDITS_TO_CLOSE,
  MIN_CREDITS_TO_REGISTER,
  sumCredits,
  type CreditsLevel,
} from '../lib/credits';
import type { PlanItem } from '../lib/storage';
import './CreditsBadge.css';

const ICON: Record<CreditsLevel, typeof TriangleAlert> = {
  danger: TriangleAlert,
  warning: CircleAlert,
  ok: CircleCheck,
};

const NOTE: Record<CreditsLevel, string> = {
  danger: `no alcanza para inscribir (mínimo ${MIN_CREDITS_TO_REGISTER})`,
  warning: `no cierra el semestre (mínimo ${MIN_CREDITS_TO_CLOSE})`,
  ok: 'alcanza para inscribir y cerrar el semestre',
};

/**
 * La suma de créditos del plan, con el semáforo de los estatutos.
 *
 * Solo informa — no deshabilita agregar ni quitar materias, ni bloquea nada
 * de la pantalla. Por eso es un párrafo y no un botón: no hay acción que
 * tomar acá, y `role="status"` + `aria-live` avisan el cambio sin que haga
 * falta ir a mirarlo cada vez que se agrega o se quita una materia.
 *
 * Mismos tonos que `SeatsFigure` (ok/bad/warn de styles/tokens.css) y misma
 * forma de píldora que `.chip`: es el mismo lenguaje visual que ya usa el
 * resto de Mi semestre, no uno nuevo.
 */
export function CreditsBadge({ items }: { items: PlanItem[] }) {
  const total = sumCredits(items);
  const level = creditsLevel(total);
  const Icon = ICON[level];

  return (
    <p
      className={`credits-badge credits-badge--${level}`}
      role="status"
      aria-live="polite"
      title={`Estatutos: mínimo ${MIN_CREDITS_TO_REGISTER} créditos para inscribir, mínimo ${MIN_CREDITS_TO_CLOSE} al cerrar adiciones y cancelaciones. Solo informativo — no bloquea nada.`}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="tnum">{total} créditos</span>
      <span className="credits-badge__note">{NOTE[level]}</span>
    </p>
  );
}
