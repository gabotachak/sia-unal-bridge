import { RefreshCw } from 'lucide-react';
import type { Measure } from '../hooks/useCourseDetails';

/** El botón "medir cupos". Usa las clases `.chip`/`.chip__code` globales
 *  (styles/base.css) y el rótulo que ya calcula `useCourseDetails`. */
export function MeasureChip({
  measure,
  running,
  disabled,
  onClick,
}: {
  measure: Measure;
  running: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button className="chip" onClick={onClick} disabled={disabled} title={measure.title}>
      <RefreshCw
        size={14}
        strokeWidth={1.75}
        className={running ? 'spin' : undefined}
        aria-hidden="true"
      />
      {measure.text}
      {measure.code && <span className="chip__code tnum">{measure.code}</span>}
    </button>
  );
}
