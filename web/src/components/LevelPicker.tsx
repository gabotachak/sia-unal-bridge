import { NavLink } from 'react-router';
import { routes } from '../api/client';
import type { LevelsResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import './LevelPicker.css';

/**
 * El primer escalón de la cascada.
 *
 * No está hardcodeado a los tres de siempre: se pide a /v1/levels, igual que
 * hace el back —que tampoco los tiene fijos en el código—. Si la UNAL agrega
 * un nivel, aparece acá solo.
 *
 * El slug es el ID público y es estable: el back lo asigna una vez y no lo
 * reescribe aunque el SIA reordene su dropdown. Por eso se puede poner en la
 * URL sin miedo.
 */
export function LevelPicker({ current }: { current: string }) {
  const { data } = useApi<LevelsResponse>(routes.levels());
  const levels = data?.levels ?? [];

  return (
    <nav className="levels" aria-label="Nivel de estudio">
      {levels.map((l) => (
        <NavLink
          key={l.slug}
          to={`/nivel/${l.slug}`}
          className={l.slug === current ? 'levels__item is-on' : 'levels__item'}
        >
          {l.name}
        </NavLink>
      ))}
    </nav>
  );
}
