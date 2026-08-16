import { Database, Zap } from 'lucide-react';
import type { Freshness as F } from '../api/client';
import { formatAge } from '../lib/format';
import './Freshness.css';

/**
 * La insignia de frescura: de dónde salió este dato y hace cuánto.
 *
 * Va visible siempre, no en un tooltip. La API se esfuerza en no servir nada
 * sin decir de cuándo es; esconderlo en la interfaz tiraría ese trabajo.
 *
 * Dos iconos, dos orígenes: el rayo es una consulta en vivo al SIA (costó
 * segundos), el cilindro es Postgres (costó milisegundos). Ver cuál de los dos
 * aparece explica la diferencia de velocidad sin una sola palabra.
 */
export function Freshness({ value }: { value: F | null }) {
  if (!value) return null;

  const live = value.cache === 'miss';
  // Qué tan lejos está el dato de vencer, de 0 a 1. Tiñe el punto: verde
  // recién medido, gris a punto de vencer.
  const ratio = value.maxAge > 0 ? Math.min(1, value.age / value.maxAge) : 0;

  return (
    <span className={`fresh ${live ? 'fresh--live' : ''}`} title={detail(value)}>
      {live ? (
        <Zap size={13} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Database size={13} strokeWidth={1.75} aria-hidden="true" style={{ opacity: 1 - ratio * 0.5 }} />
      )}
      <span className="fresh__text">
        {live ? 'del SIA' : `hace ${formatAge(value.age)}`}
      </span>
      {live && value.siaMs > 0 && (
        <span className="fresh__ms tnum">{(value.siaMs / 1000).toFixed(1)}s</span>
      )}
    </span>
  );
}

function detail(v: F): string {
  const src = v.cache === 'miss' ? 'consultado al SIA' : 'servido desde Postgres';
  return `${src} · edad ${v.age}s · se considera fresco ${v.maxAge}s`;
}
