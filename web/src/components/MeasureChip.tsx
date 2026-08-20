import { RefreshCw } from 'lucide-react';
import type { Measure } from '../hooks/useCourseDetails';
import { Tooltip } from './Tooltip';

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
    <Tooltip content={<p className="tt-body">{measure.title}</p>}>
      <button className="chip" onClick={onClick} disabled={disabled}>
        <RefreshCw
          size={14}
          strokeWidth={1.75}
          className={running ? 'spin' : undefined}
          aria-hidden="true"
        />
        {measure.text}
        {measure.code && <span className="chip__code tnum">{measure.code}</span>}
      </button>
    </Tooltip>
  );
}
