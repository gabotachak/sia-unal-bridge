import { Link } from 'react-router';
import type { ApiError } from '../api/client';
import './States.css';

/**
 * Carga honesta.
 *
 * Un miss frío contra el SIA tarda entre 3 y 8 segundos: son hasta 15 POSTs
 * encadenados contra una app con estado de sesión. Un spinner mudo durante 8 s
 * se lee como "está roto". Acá se muestra el cronómetro y se explica por qué.
 */
export function Loading({ elapsed, what }: { elapsed: number; what: string }) {
  const slow = elapsed > 1.2;

  return (
    <section className="state rise">
      <div className="state__bars" aria-hidden="true">
        {Array.from({ length: 7 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${i * 90}ms` }} />
        ))}
      </div>
      <p className="state__title">{what}</p>
      {slow && (
        <p className="state__note">
          No está cacheado, así que se está consultando al SIA en vivo. Son varias
          peticiones encadenadas contra una app con estado de sesión — por eso tarda.
          <br />
          La próxima vez esta misma pantalla abre desde Postgres, en milisegundos.
        </p>
      )}
      <p className="state__clock">
        {elapsed.toFixed(1)}
        <small>s</small>
      </p>
    </section>
  );
}

export function Fault({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  // El 300 no es un fallo: es la API diciendo "ese código no identifica solo".
  // Se responde con los candidatos como enlaces, que es lo que resuelve el caso.
  if (error.candidates?.length) {
    return (
      <section className="state rise">
        <p className="eyebrow">hay más de un plan con ese código</p>
        <h2 className="state__head">¿Cuál de estos?</h2>
        <p className="state__note">
          El mismo código existe en varias sedes o facultades — PEAMA reexpone el mismo
          plan. Elegí uno:
        </p>
        <ul className="state__options">
          {error.candidates.map((c) => (
            <li key={`${c.campus_code}-${c.faculty_code}-${c.program}`}>
              <Link to={`/sede/${c.campus_code}/plan/${c.program}`}>
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
    <section className="state state--fault rise">
      <p className="eyebrow">{error.code}</p>
      <h2 className="state__head">No se pudo</h2>
      <p className="state__note">{error.humane}</p>
      {error.hint && <p className="state__hint">{error.hint}</p>}
      {onRetry && (
        <button className="btn" onClick={() => onRetry()}>
          Reintentar
        </button>
      )}
    </section>
  );
}

export function Empty({ title, note }: { title: string; note?: string }) {
  return (
    <section className="state rise">
      <h2 className="state__head">{title}</h2>
      {note && <p className="state__note">{note}</p>}
    </section>
  );
}
