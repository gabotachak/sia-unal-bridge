import { CircleCheck, TriangleAlert } from 'lucide-react';
import { usePlan } from '../hooks/usePlan';
import {
  creditsByPlan,
  creditsByTypology,
  creditsLevel,
  MIN_CREDITS_TO_CLOSE,
  MIN_CREDITS_TO_REGISTER,
  sumCredits,
  type CreditsLevel,
} from '../lib/credits';
import { abbreviateEngineering } from '../lib/format';
import type { PlanItem } from '../lib/storage';
import { Tooltip } from './Tooltip';
import './CreditsBadge.css';

const ICON: Record<CreditsLevel, typeof TriangleAlert> = {
  danger: TriangleAlert,
  warning: TriangleAlert,
  ok: CircleCheck,
};

// Solo danger y warning se ganan una nota: el color y el ícono ya dicen
// "todo bien" cuando alcanza, y una frase extra ahí sería ruido repitiendo
// lo que el verde ya dijo. Mismo criterio que SeatsFigure, que tampoco
// explica el estado sano — solo el que hay que atender.
const NOTE: Partial<Record<CreditsLevel, string>> = {
  danger: `mínimo ${MIN_CREDITS_TO_REGISTER} para inscribir`,
  warning: `mínimo ${MIN_CREDITS_TO_CLOSE} para cerrar`,
};

/**
 * La suma de créditos del plan, con el semáforo de los estatutos.
 *
 * Solo informa — no deshabilita agregar ni quitar materias, ni bloquea nada
 * de la pantalla. Nace al lado de `head__meta` (el "N materias · N con
 * cupo" de la cabecera) y comparte su tipografía a propósito: es un segundo
 * renglón del mismo resumen, no una alerta que compite por atención.
 *
 * El total solo, sin embargo, no dice de dónde sale — y eso es justo lo que
 * alguien armando un semestre necesita para completarlo bien (cuántos son
 * de libre elección, cuántos obligatorios, etc). Por eso el hover abre el
 * desglose por tipología: el mismo dato, uno más adentro.
 */
export function CreditsBadge({ items }: { items: PlanItem[] }) {
  const total = sumCredits(items);
  const level = creditsLevel(total);
  const Icon = ICON[level];
  const note = NOTE[level];
  const breakdown = creditsByTypology(items);

  // Los mínimos son por INSCRIPCIÓN completa, no por plan (D9): el total, el
  // semáforo y el desglose por tipología no cambian de lógica con dos
  // planes. Lo único que gana es este desglose por plan, informativo — sin
  // semáforo propio, porque no hay regla por plan que semaforear.
  const plans = usePlan().plans;
  const byPlan = plans.length > 1 ? creditsByPlan(items) : [];
  const planName = (program: string) =>
    abbreviateEngineering(plans.find((p) => p.program === program)?.programName ?? program);

  const content = (
    <>
      <p className="tt-body">
        Estatutos: mínimo {MIN_CREDITS_TO_REGISTER} créditos para inscribir, mínimo{' '}
        {MIN_CREDITS_TO_CLOSE} al cerrar adiciones y cancelaciones.
      </p>

      {byPlan.length > 0 && (
        <ul className="tt-rows">
          {byPlan.map((b) => (
            <li className="tt-row" key={b.program}>
              <span>{planName(b.program)}</span>
              <b className="tnum">{b.credits}</b>
            </li>
          ))}
        </ul>
      )}

      {breakdown.length > 0 && (
        <ul className="tt-rows">
          {breakdown.map((b) => (
            <li className="tt-row" key={b.typology}>
              <span>{b.typology}</span>
              <b className="tnum">{b.credits}</b>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <Tooltip content={content} placement="bottom">
      <p className={`credits-status credits-status--${level}`} role="status" aria-live="polite">
        <Icon size={13} strokeWidth={2} aria-hidden="true" />
        <span className="tnum">{total} créditos</span>
        {note && (
          <>
            <span className="head__dot" aria-hidden="true">
              ·
            </span>
            {note}
          </>
        )}
      </p>
    </Tooltip>
  );
}
