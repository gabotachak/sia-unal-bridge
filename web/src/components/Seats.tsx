import { useEffect, useState } from 'react';
import { formatAge } from '../lib/format';
import './Seats.css';

type Props = {
  available: number;
  measuredAt: string;
  ageSeconds: number;
  onRefresh?: () => void;
  busy?: boolean;
};

/** Los cupos tienen TTL de 5 min en la API. Pasado eso, el dato está vencido. */
const SEATS_TTL = 300;
const FETCH_COOLDOWN = parseInt(import.meta.env.VITE_FETCH_COOLDOWN || '60', 10);

/**
 * El contador de cupos: cifra de tablero de aeropuerto.
 *
 * El truco de la animación es la prop `key` de React. Cuando un dígito cambia,
 * su key cambia, React lo trata como un elemento NUEVO, lo monta de cero, y la
 * animación CSS de montaje se ejecuta. Los dígitos que no cambiaron conservan
 * su key y se quedan quietos — que es exactamente lo que hace un tablero real.
 */
export function Seats({ available, measuredAt, ageSeconds, onRefresh, busy }: Props) {
  // La edad avanza sola mientras mirás la pantalla. Un dato que envejece a la
  // vista es el argumento entero de esta API, así que se ve envejecer.
  const [age, setAge] = useState(ageSeconds);
  useEffect(() => setAge(ageSeconds), [ageSeconds, measuredAt]);
  useEffect(() => {
    const t = window.setInterval(() => setAge((a) => a + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const stale = age > SEATS_TTL;
  const empty = available === 0;
  const digits = String(available).padStart(2, '0').split('');
  
  const inCooldown = age < FETCH_COOLDOWN;
  const cooldownRemaining = FETCH_COOLDOWN - age;

  return (
    <div className={`seats ${empty ? 'seats--empty' : ''} ${stale ? 'seats--stale' : ''}`}>
      <div className="seats__figure" aria-hidden="true">
        {digits.map((d, i) => (
          <span key={`${i}-${d}`} className="seats__flap">
            {d}
          </span>
        ))}
      </div>

      <p className="sr-only">
        {available} cupos disponibles, medidos hace {formatAge(age)}.
      </p>

      <div className="seats__meta">
        <span className="seats__label">{empty ? 'sin cupos' : 'cupos'}</span>
        <span className="seats__age" title={new Date(measuredAt).toLocaleString('es-CO')}>
          {stale ? '⚠ ' : ''}
          hace {formatAge(age)}
        </span>
        {onRefresh && (
          <button className="btn seats__btn" onClick={onRefresh} disabled={busy || inCooldown}>
            {busy ? 'midiendo…' : inCooldown ? `esperar ${cooldownRemaining}s` : 'medir ahora'}
          </button>
        )}
      </div>

      {/* Barra que se vacía a medida que el dato se acerca a su vencimiento. */}
      <div className="seats__ttl" aria-hidden="true">
        <i style={{ transform: `scaleX(${Math.max(0, 1 - age / SEATS_TTL)})` }} />
      </div>
    </div>
  );
}
