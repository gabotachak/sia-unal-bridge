import { Link } from 'react-router';
import { CalendarDays, ChevronsUpDown, LayoutList, Monitor, Moon, Sun } from 'lucide-react';
import type { Freshness as F } from '../api/client';
import { useTheme } from '../hooks/useTheme';
import { usePlan } from '../hooks/usePlan';
import { selectionPath } from '../lib/storage';
import { Freshness } from './Freshness';
import { IconButton } from './IconButton';
import './Topbar.css';

/** El tamaño de todos los iconos de la barra. Uno solo, o el borde inferior
 *  de los glifos no cae en la misma línea y la barra se ve descuadrada. */
const ICON = 18;
const STROKE = 1.75;

/**
 * La barra. Una sola, arriba, con todo.
 *
 * Reemplaza al raíl lateral y a las migas de pan. Las migas se fueron porque
 * mentían: con un plan elegido, subir por el camino —nivel, sede— no lleva a
 * ningún lado útil, y el catálogo del plan ya ES la raíz. Lo que queda son
 * tres destinos, y cada uno cabe en un icono.
 *
 * El chip del plan es la única pieza con palabras, porque es la única cuyo
 * contenido cambia y no hay forma de dibujarlo.
 */
export function Topbar({ freshness }: { freshness?: F | null }) {
  const plan = usePlan();
  const { theme, resolved, cycle } = useTheme();
  const sel = plan.selection;

  const themeLabel =
    theme === 'system' ? 'Tema: el del sistema' : theme === 'light' ? 'Tema: claro' : 'Tema: oscuro';

  return (
    <header className="bar">
      <div className="bar__inner">
        <Link className="brand" to="/" aria-label="SIA Bridge — inicio">
          <svg className="brand__mark" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="3" y="6" width="6" height="20" rx="2" />
            <rect className="brand__mark--ok" x="13" y="6" width="6" height="12" rx="2" />
            <rect className="brand__mark--faint" x="23" y="6" width="6" height="16" rx="2" />
          </svg>
          <span className="brand__word">SIA Bridge</span>
        </Link>

        <div className="bar__spacer" />

        {/* El plan elegido. Es contexto y es puerta: dice de qué plan es todo
            lo que hay debajo, y al tocarlo se cambia. El chevron doble es la
            convención de "acá se elige entre varios". Vive con el resto de
            controles, a la derecha. */}
        {sel && (
          <Link className="planchip" to="/plan">
            <span className="planchip__code tnum">{sel.program}</span>
            <span className="planchip__name">{sel.programName}</span>
            <span className="planchip__campus">{sel.campusName.replace(/^SEDE\s+/i, '')}</span>
            <ChevronsUpDown className="planchip__caret" size={14} strokeWidth={STROKE} aria-hidden="true" />
            <span className="sr-only">Cambiar de plan</span>
          </Link>
        )}

        <Freshness value={freshness ?? null} />

        <nav className="bar__nav" aria-label="Secciones">
          {sel && (
            <IconButton to={selectionPath(sel)} label="Catálogo del plan" end>
              <LayoutList size={ICON} strokeWidth={STROKE} />
            </IconButton>
          )}

          <IconButton to="/semestre" label="Mi semestre" badge={plan.items.length}>
            <CalendarDays size={ICON} strokeWidth={STROKE} />
          </IconButton>

          <IconButton onClick={cycle} label={themeLabel} tip="left">
            {theme === 'system' ? (
              <Monitor size={ICON} strokeWidth={STROKE} />
            ) : resolved === 'dark' ? (
              <Moon size={ICON} strokeWidth={STROKE} />
            ) : (
              <Sun size={ICON} strokeWidth={STROKE} />
            )}
          </IconButton>
        </nav>
      </div>
    </header>
  );
}
