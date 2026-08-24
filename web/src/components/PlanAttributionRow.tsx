import { planColorVar } from '../lib/courseColors';
import { abbreviateEngineering } from '../lib/format';
import type { Selection } from '../lib/storage';
import { typologyLetter, typologySlug } from '../lib/typology';
import './PlanAttributionRow.css';

/** A qué plan se atribuye algo, y con qué tipología — lo que pinta
 *  `PlanAttributionRow` (catálogo, Course.tsx, CourseCard.tsx). Solo el
 *  código y el nombre del plan, no la `Selection` entera: así un llamador
 *  que no tiene sede/facultad a mano (CourseCard, que solo guarda códigos)
 *  no tiene que inventarlos. */
export type PlanAttribution = {
  plan: Pick<Selection, 'program' | 'programName'>;
  typology: string;
};

/**
 * Código, nombre y tipología de UN plan — mismo lenguaje visual en el
 * hover de tipología del catálogo (`PlanTypologyInfo`, Program.tsx), la
 * ficha (Course.tsx) y Mi semestre/Mi horario (CourseCard.tsx): un solo
 * diseño para "a qué plan se atribuye esto", no una frase con `<code>`
 * suelto reescrita tres veces con tres pintas distintas.
 */
export function PlanAttributionRow({
  attr,
  plans,
  mine,
}: {
  attr: PlanAttribution;
  plans: readonly Selection[];
  mine?: boolean;
}) {
  return (
    <p className={`plan-attr-row ${mine ? 'plan-attr-row--mine' : ''}`}>
      <span
        className="chip__code tnum row__plan-tag"
        style={{ color: planColorVar(attr.plan.program, plans) }}
      >
        {attr.plan.program}
      </span>
      {mine ? (
        <b>{abbreviateEngineering(attr.plan.programName)}</b>
      ) : (
        abbreviateEngineering(attr.plan.programName)
      )}
      <span className={`tag tag--${typologySlug(attr.typology)}`}>{typologyLetter(attr.typology)}</span>
    </p>
  );
}
