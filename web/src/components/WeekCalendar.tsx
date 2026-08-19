import { TriangleAlert } from 'lucide-react';
import type { ClassSession } from '../api/types';
import { useViewportFit } from '../hooks/useViewportFit';
import { STACK_BREAKPOINT_PX } from '../lib/breakpoints';
import { WEEKDAYS_SHORT, formatClockTime } from '../lib/format';
import './WeekCalendar.css';

export type CalendarBlock = {
  id: string; // blockId(), única por materia+grupo+sesión
  itemId: string;
  code: string;
  name: string;
  sectionKey: string;
  session: ClassSession;
  color: string; // 'var(--course-3)'
  conflict: boolean;
};

/** Franja por defecto si no hay clases que la empujen. Cubre la jornada
 *  diurna típica del SIA sin dejar el calendario absurdamente alto. */
const DEFAULT_START_MIN = 6 * 60;
const DEFAULT_END_MIN = 21 * 60;

/** Por debajo de esto el texto de un bloque de una hora ya no entra —cuatro
 *  líneas a `--t-nano`— y es mejor scrollear que seguir achicando. */
const MIN_HOUR_REM = 2.15;
/** Por encima, una jornada corta (pocas horas de clase) dejaba bloques
 *  absurdamente altos con toda esa ventana libre. */
const MAX_HOUR_REM = 4;
/** Alto de `.week__header`, para descontarlo del alto disponible. */
const HEADER_REM = 3.2;
/** Apilado (`useViewportFit` apagado, ver abajo) no hay a qué ajustarse:
 *  un rango típico a MAX_HOUR_REM son 60rem de alto, más grande que la
 *  pantalla entera. Este es el tamaño que se ve bien en un teléfono. */
const MOBILE_HOUR_REM = 2.5;

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * El alto de una hora, calculado para que la semana entera quepa sin
 * scrollear — como Google Calendar, que comprime las filas al alto
 * disponible en vez de forzar siempre el mismo tamaño. Sale de
 * `useViewportFit`, el mismo cálculo que usa el panel de materias al lado
 * (`Schedule.tsx`) — los dos arrancan a la misma altura, así que el mismo
 * hook les da a los dos el mismo disponible sin coordinarse entre sí.
 *
 * Con `MIN_HOUR_REM` como piso: si ni así entra, el contenedor scrollea en
 * vez de volverse ilegible (ver `.week` en WeekCalendar.css).
 *
 * Por debajo de `STACK_BREAKPOINT_PX` no se topea nada: Mi horario apila la
 * lista y el calendario, y ahí el scroll de la página alcanza — un scroll
 * propio adentro sería un segundo scroll dentro del primero.
 */
function useFitHourHeight(totalHours: number) {
  const [ref, maxHeightRem] = useViewportFit<HTMLDivElement>({ disableBelowPx: STACK_BREAKPOINT_PX });
  const perHour = (maxHeightRem - HEADER_REM) / totalHours;
  const hourRem = !Number.isFinite(maxHeightRem)
    ? MOBILE_HOUR_REM // apagado por STACK_BREAKPOINT_PX: tamaño fijo, no "quepa sin scrollear"
    : totalHours > 0 && Number.isFinite(perHour)
      ? Math.min(MAX_HOUR_REM, Math.max(MIN_HOUR_REM, perHour))
      : MAX_HOUR_REM;
  return { ref, hourRem, maxHeightRem };
}

/**
 * Reparte los bloques de UN día en carriles cuando se solapan, como una
 * agenda de verdad: dos clases a la misma hora quedan lado a lado, no una
 * tapando a la otra. Empaquetado voraz por orden de inicio — no es óptimo en
 * todos los casos, pero con hasta diez materias el resultado siempre se lee
 * bien, y es la misma idea que usa cualquier calendario semanal.
 */
function layoutDay(blocks: CalendarBlock[]): Array<CalendarBlock & { lane: number; lanes: number }> {
  const sorted = [...blocks].sort((a, b) => toMinutes(a.session.start_time) - toMinutes(b.session.start_time));
  const laneEnds: number[] = [];
  const placed = sorted.map((b) => {
    const start = toMinutes(b.session.start_time);
    const end = toMinutes(b.session.end_time);
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    return { block: b, lane, start, end };
  });
  const lanes = Math.max(1, laneEnds.length);
  return placed.map(({ block, lane }) => ({ ...block, lane, lanes }));
}

/**
 * El calendario semanal. Presentacional puro: recibe los bloques ya
 * resueltos (qué materia, qué grupo, qué sesión, si choca) y los posiciona.
 * No sabe nada de plan.items, de la API ni de localStorage — eso vive en
 * Schedule.tsx, que es quien arma esta lista.
 */
export function WeekCalendar({ blocks }: { blocks: CalendarBlock[] }) {
  const days = [1, 2, 3, 4, 5, 6, ...(blocks.some((b) => b.session.weekday === 7) ? [7] : [])];

  let startMin = DEFAULT_START_MIN;
  let endMin = DEFAULT_END_MIN;
  for (const b of blocks) {
    startMin = Math.min(startMin, Math.floor(toMinutes(b.session.start_time) / 60) * 60);
    endMin = Math.max(endMin, Math.ceil(toMinutes(b.session.end_time) / 60) * 60);
  }
  const totalHours = (endMin - startMin) / 60;
  const hours = Array.from({ length: totalHours + 1 }, (_, i) => startMin / 60 + i);

  const byDay = new Map<number, CalendarBlock[]>();
  for (const d of days) byDay.set(d, []);
  for (const b of blocks) {
    if (!byDay.has(b.session.weekday)) continue; // fuera de lunes–sábado/domingo mostrados
    byDay.get(b.session.weekday)!.push(b);
  }

  const { ref, hourRem: HOUR_REM, maxHeightRem } = useFitHourHeight(totalHours);

  return (
    <div
      className="week"
      ref={ref}
      style={Number.isFinite(maxHeightRem) ? { maxHeight: `${maxHeightRem}rem` } : undefined}
    >
      {/* Superpuesto, no una línea aparte encima del calendario: esa versión
          aparecía y desaparecía según hubiera bloques, y cada vez empujaba
          la rejilla un renglón hacia abajo. Como overlay ocupa cero alto
          propio — el calendario no se mueve nunca, con o sin nota. */}
      {blocks.length === 0 && (
        <p className="week__empty">Marca un grupo por materia en la lista para verlo aquí.</p>
      )}

      <div className="week__header">
        <div className="week__gutter" aria-hidden="true" />
        {days.map((d) => (
          <div key={d} className="week__day-label">
            {WEEKDAYS_SHORT[d]}
          </div>
        ))}
      </div>

      <div className="week__body">
        <div className="week__gutter">
          {hours.map((h) => (
            <div key={h} className="week__hour-label" style={{ height: `${HOUR_REM}rem` }}>
              {String(h).padStart(2, '0')}:00
            </div>
          ))}
        </div>

        {days.map((d) => (
          <div key={d} className="week__col" style={{ height: `${totalHours * HOUR_REM}rem` }}>
            {hours.map((h) => (
              <div key={h} className="week__gridline" style={{ top: `${(h - startMin / 60) * HOUR_REM}rem` }} />
            ))}

            {layoutDay(byDay.get(d) ?? []).map((b) => {
              const start = toMinutes(b.session.start_time);
              const end = toMinutes(b.session.end_time);
              const top = ((start - startMin) / 60) * HOUR_REM;
              const height = Math.max(((end - start) / 60) * HOUR_REM, 1.6);
              const width = 100 / b.lanes;
              const style = {
                top: `${top}rem`,
                height: `${height}rem`,
                left: `${b.lane * width}%`,
                width: `calc(${width}% - 2px)`,
                '--course-color': b.color,
              } as React.CSSProperties;
              return (
                <div
                  key={b.id}
                  className={`week__block ${b.conflict ? 'is-conflict' : ''}`}
                  style={style}
                  title={`${b.name} · grupo ${b.sectionKey} · ${b.session.start_time}–${b.session.end_time}${b.session.room ? ` · ${b.session.room}` : ''}`}
                >
                  {b.conflict && (
                    <TriangleAlert className="week__block-conflict" size={12} strokeWidth={2.25} aria-hidden="true" />
                  )}
                  <span className="week__block-name">{b.name}</span>
                  <span className="week__block-meta">
                    <span className="week__block-key tnum">{b.sectionKey}</span>
                    <span className="tnum">
                      {formatClockTime(b.session.start_time)}–{formatClockTime(b.session.end_time)}
                    </span>
                  </span>
                  {b.session.room && <span className="week__block-room">{b.session.room}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
