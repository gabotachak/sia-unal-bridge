import { useEffect, useState } from 'react';
import { formatAge } from '../lib/format';
import './Seats.css';

type Props = {
  available: number;
  measuredAt: string;
  ageSeconds: number;
};

/** Los cupos tienen TTL de 5 min en la API. Pasado eso, el dato está vencido. */
const SEATS_TTL = 300;

/** ok = hay lugar · empty = cero medido · stale = el dato venció. */
export type SeatsTone = 'ok' | 'empty' | 'stale';

/**
 * La cifra de cupos, sola.
 *
 * Vive aparte del componente completo porque la cifra es lo único que se puede
 * permitir estar en las tres pantallas. El resto de `Seats` —el reloj que
 * envejece el dato, la barra de vencimiento, el rótulo— cuesta un
 * `setInterval` por instancia, y en un catálogo de 313 filas eso son 313
 * temporizadores disparando otros tantos `setState` por segundo, cada uno en
 * un milisegundo distinto y por tanto casi sin agruparse en un solo commit.
 *
 * `animate` no es un capricho de gusto: el tablero de aeropuerto trata sobre
 * el CAMBIO, y solo se gana el sitio donde un número cambia mientras lo miras
 * —la ficha y Mi semestre al pulsar "medir"—. En el catálogo no cambia nada
 * después de cargar, así que ahí monta quieto: misma forma y mismo color, sin
 * 700 aletas girando en la primera pintura.
 */
export function SeatsFigure({
  available,
  tone = 'ok',
  size = 'sm',
  animate = false,
  announce = true,
}: {
  /** `null` = no hay dato que mostrar. Sale una raya, no un cero. */
  available: number | null;
  tone?: SeatsTone;
  size?: 'sm' | 'lg';
  animate?: boolean;
  /**
   * Si dice el número en voz alta.
   *
   * Los dígitos van `aria-hidden` porque para un lector de pantalla son
   * caracteres sueltos —'cuatro, cero' en vez de 'cuarenta'—, así que hace
   * falta un texto aparte. Se apaga solo donde ya hay uno alrededor, como en
   * `Seats`, para no decirlo dos veces.
   */
  announce?: boolean;
}) {
  const spoken =
    available === null ? 'Sin dato de cupos' : `${available} cupos disponibles`;

  // padStart(2) no es decoración: en una columna, '05' y '40' ocupan lo mismo
  // y los dígitos caen en la misma vertical fila tras fila.
  const digits = available === null ? null : String(available).padStart(2, '0').split('');

  return (
    <>
      {announce && <span className="sr-only">{spoken}</span>}
      {digits === null ? (
        <span className={`seatfig seatfig--${size} seatfig--none`} aria-hidden="true">
          —
        </span>
      ) : (
        <span
          className={`seatfig seatfig--${size} seatfig--${tone} ${animate ? 'is-live' : ''} tnum`}
          aria-hidden="true"
        >
          {digits.map((d, i) => (
            // La `key` es el truco entero: cuando un dígito cambia, su key
            // cambia, React lo monta de cero y la animación CSS de montaje se
            // ejecuta. Los que no cambiaron conservan su key y se quedan
            // quietos — que es exactamente lo que hace un tablero real.
            <span key={`${i}-${d}`} className="seatfig__flap">
              {d}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

/**
 * El contador de cupos con todo: cifra, edad que corre y barra de vencimiento.
 *
 * Es la versión de la ficha de asignatura, donde hay uno o cuatro y el dato
 * está para mirarse. Para una fila de lista está `SeatsFigure` a secas.
 */
export function Seats({ available, measuredAt, ageSeconds }: Props) {
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
  const tone: SeatsTone = stale ? 'stale' : empty ? 'empty' : 'ok';

  return (
    <div className={`seats ${empty ? 'seats--empty' : ''} ${stale ? 'seats--stale' : ''}`}>
      {/* announce={false}: el <p className="sr-only"> de abajo ya lo dice, y
          con la edad, que es más útil que el número solo. */}
      <SeatsFigure available={available} tone={tone} size="lg" animate announce={false} />

      <p className="sr-only">
        {available} cupos disponibles, medidos hace {formatAge(age)}.
      </p>

      <div className="seats__meta">
        <span className="seats__label">{empty ? 'sin cupos' : 'cupos'}</span>
        <span className="seats__age tnum" title={new Date(measuredAt).toLocaleString('es-CO')}>
          hace {formatAge(age)}
        </span>
      </div>

      {/* Barra que se vacía a medida que el dato se acerca a su vencimiento. */}
      <div className="seats__ttl" aria-hidden="true">
        <i style={{ transform: `scaleX(${Math.max(0, 1 - age / SEATS_TTL)})` }} />
      </div>
    </div>
  );
}
