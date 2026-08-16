import { Link, useParams } from 'react-router';
import { Inbox, RotateCw, TriangleAlert } from 'lucide-react';
import type { ApiError } from '../api/client';
import { MAX_RETRIES } from '../lib/retry';
import './States.css';

/**
 * Carga honesta.
 *
 * Un miss frío contra el SIA tarda entre 3 y 8 segundos: son hasta 15 POSTs
 * encadenados contra una app con estado de sesión. Un spinner mudo durante 8 s
 * se lee como "está roto". Acá se muestra el cronómetro y se explica por qué.
 */
export function Loading({
  elapsed,
  what,
  attempt = 0,
}: {
  elapsed: number;
  what: string;
  /** En qué reintento va. 0 = todavía es el primer intento. */
  attempt?: number;
}) {
  const slow = elapsed > 1.2;

  return (
    <section className="state">
      <div className="state__bars" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${i * 90}ms` }} />
        ))}
      </div>
      <p className="state__title">{what}</p>

      {/* Se dice que se está reintentando, pero no se pide nada: el error que
          lo causó se arregla solo casi siempre, y no hay decisión que tomar
          hasta que se acaben los intentos. */}
      {attempt > 0 && (
        <p className="state__retry">
          El SIA cortó la sesión. Reintentando ({attempt}/{MAX_RETRIES})…
        </p>
      )}

      {slow && (
        <p className="state__note">
          No está cacheado, así que se está consultando al SIA en vivo. Son varias
          peticiones encadenadas contra una app con estado de sesión — por eso tarda.
          <br />
          La próxima vez esta misma pantalla abre desde Postgres, en milisegundos.
        </p>
      )}
      <p className="state__clock tnum">
        {elapsed.toFixed(1)}
        <small>s</small>
      </p>
    </section>
  );
}

export function Fault({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  // El nivel de la ruta actual. Hace falta para armar los enlaces de un 300:
  // sin él no se puede señalar a un catálogo concreto. En pantallas que no
  // llevan nivel en la URL —el selector de plan— cae al de siempre.
  const { level = 'pregrado' } = useParams();

  // El 300 no es un fallo: es la API diciendo "ese código no identifica solo".
  // Se responde con los candidatos como enlaces, que es lo que resuelve el caso.
  if (error.candidates?.length) {
    return (
      <section className="state">
        <p className="eyebrow">hay más de un plan con ese código</p>
        <h2 className="state__head">¿Cuál de estos?</h2>
        <p className="state__note">
          El mismo código existe en varias sedes o facultades — PEAMA reexpone el mismo
          plan. Elige uno:
        </p>
        <ul className="state__options">
          {error.candidates.map((c) => (
            <li key={`${c.campus_code}-${c.faculty_code}-${c.program}`}>
              <Link
                to={`/nivel/${level}/sede/${c.campus_code}/plan/${c.program}?f=${c.faculty_code}`}
              >
                <strong>{c.name}</strong>
                <span>
                  {c.campus_name} · {c.faculty_name}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className="state state--fault">
      <TriangleAlert className="state__icon" size={24} strokeWidth={1.5} aria-hidden="true" />
      <h2 className="state__head">No se pudo</h2>
      <p className="state__note">{error.humane}</p>
      {error.hint && <p className="state__hint">{error.hint}</p>}
      <p className="eyebrow state__code">{error.code}</p>
      {onRetry && (
        <button className="btn" onClick={() => onRetry()}>
          <RotateCw size={15} strokeWidth={1.75} aria-hidden="true" />
          reintentar
        </button>
      )}
    </section>
  );
}

export function Empty({ title, note }: { title: string; note?: string }) {
  return (
    <section className="state">
      <Inbox className="state__icon state__icon--quiet" size={24} strokeWidth={1.5} aria-hidden="true" />
      <h2 className="state__head">{title}</h2>
      {note && <p className="state__note">{note}</p>}
    </section>
  );
}
