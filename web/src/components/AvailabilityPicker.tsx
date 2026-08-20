import { ChevronDown, Clock } from 'lucide-react';
import {
  AVAIL_DAYS,
  AVAIL_END_MIN,
  AVAIL_START_MIN,
  availabilityTimeOptions,
  type AvailabilityFilter,
} from '../lib/availability';
import { WEEKDAYS_LONG, WEEKDAYS_SHORT } from '../lib/format';
import './AvailabilityPicker.css';

const TIME_OPTIONS = availabilityTimeOptions();

/**
 * Días + un rango horario compartido — "cuándo puedo tomar clase". Vive
 * como una fila más del panel de filtros (junto a tipología y créditos),
 * no en un modal aparte: las tres son la misma pregunta —"¿qué se queda en
 * la lista?"— y separarla en su propia caja se leía como un sistema
 * distinto en vez de un filtro más.
 *
 * Días y rango van en la MISMA fila —no apilados— por la misma razón:
 * tipología y créditos son un `.chips` cada uno, una sola línea al lado de
 * su rótulo. Apilar "desde"/"hasta" debajo de los días, con su propia
 * versalita, competía con el rótulo "horario" de al lado y se leía como
 * dos filtros pegados en vez de uno.
 *
 * Días + rango, no una grilla pintable celda por celda: esto es la
 * preferencia de UNA persona ("lunes y miércoles después de las 12"), no
 * la disponibilidad cruzada de varias como un when2meet — pintar celdas de
 * precisión para decir eso era la herramienta equivocada (probado y
 * descartado: se veía mal y era incómodo, sobre todo en el teléfono).
 */
export function AvailabilityFields({
  value,
  onChange,
}: {
  value: AvailabilityFilter;
  onChange: (next: AvailabilityFilter) => void;
}) {
  function toggleDay(d: number) {
    const days = new Set(value.days);
    if (!days.delete(d)) days.add(d);
    onChange({ ...value, days });
  }

  // Mismo criterio que `isAvailabilityActive`, pero solo la mitad del
  // rango: la píldora se enciende en cuanto se tocó desde/hasta, aunque
  // ningún día esté marcado — es su propio filtro, no depende del otro.
  const rangeIsOn = value.fromMin !== AVAIL_START_MIN || value.toMin !== AVAIL_END_MIN;

  return (
    <div className="avail-inline">
      <div className="chips">
        {AVAIL_DAYS.map((d) => {
          const on = value.days.has(d);
          return (
            <button
              key={d}
              type="button"
              className={`chip chip--sm ${on ? 'is-on' : ''}`}
              aria-pressed={on}
              aria-label={WEEKDAYS_LONG[d]}
              onClick={() => toggleDay(d)}
            >
              {WEEKDAYS_SHORT[d]}
            </button>
          );
        })}
      </div>

      {/* Una píldora, no dos campos con caption: "desde"/"hasta" ya lo dice
          el orden —la primera hora siempre es el inicio— así que escribirlo
          además en letras era ruido. `aria-label` lo deja igual de claro
          para quien usa lector de pantalla. */}
      <div className={`chip chip--sm avail__range ${rangeIsOn ? 'is-on' : ''}`}>
        <Clock size={13} strokeWidth={1.75} aria-hidden="true" />
        <select
          aria-label="Desde qué hora"
          value={value.fromMin}
          onChange={(e) => onChange({ ...value, fromMin: Number(e.target.value) })}
        >
          {TIME_OPTIONS.filter((t) => t.min < value.toMin).map((t) => (
            <option key={t.min} value={t.min}>
              {t.label}
            </option>
          ))}
        </select>
        <ChevronDown className="avail__chevron" size={11} strokeWidth={2} aria-hidden="true" />
        <span className="avail__range-sep" aria-hidden="true">
          –
        </span>
        <select
          aria-label="Hasta qué hora"
          value={value.toMin}
          onChange={(e) => onChange({ ...value, toMin: Number(e.target.value) })}
        >
          {TIME_OPTIONS.filter((t) => t.min > value.fromMin).map((t) => (
            <option key={t.min} value={t.min}>
              {t.label}
            </option>
          ))}
        </select>
        <ChevronDown className="avail__chevron" size={11} strokeWidth={2} aria-hidden="true" />
      </div>
    </div>
  );
}
