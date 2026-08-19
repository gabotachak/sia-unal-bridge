import './MeasureProgress.css';

/** La barra que avanza mientras `useCourseDetails().fetchAll` mide.
 *  Compartida por Mi semestre y Horario: los dos miden la misma lista. */
export function MeasureProgress({
  running,
  done,
  total,
}: {
  running: boolean;
  done: number;
  total: number;
}) {
  return (
    <div className={`measure-progress ${running ? 'is-on' : ''}`} aria-hidden="true">
      <i style={{ transform: `scaleX(${running && total > 0 ? done / total : 0})` }} />
    </div>
  );
}
