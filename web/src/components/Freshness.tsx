import type { Freshness as F } from '../api/client';
import { formatAge } from '../lib/format';
import './Freshness.css';

/**
 * La insignia de frescura: de dónde salió este dato y hace cuánto.
 *
 * Va visible siempre, no en un tooltip. La API se esfuerza en no servir nada
 * sin decir de cuándo es; esconderlo en la interfaz tiraría ese trabajo.
 */
export function Freshness({ value }: { value: F | null }) {
  if (!value) return null;

  const live = value.cache === 'miss';
  const ratio = value.maxAge > 0 ? Math.min(1, value.age / value.maxAge) : 0;

  return (
    <span className={`fresh ${live ? 'fresh--live' : ''}`} title={detail(value)}>
      <i className="fresh__dot" style={{ opacity: 1 - ratio * 0.75 }} />
      <span className="fresh__text">
        {live ? 'recién medido' : `hace ${formatAge(value.age)}`}
      </span>
      {live && value.siaMs > 0 && <span className="fresh__ms">{(value.siaMs / 1000).toFixed(1)}s</span>}
    </span>
  );
}

function detail(v: F): string {
  const src = v.cache === 'miss' ? 'consultado al SIA' : 'servido desde Postgres';
  return `${src} · edad ${v.age}s · se considera fresco ${v.maxAge}s`;
}
