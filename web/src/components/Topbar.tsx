import { Link } from 'react-router';
import { CalendarDays, LayoutList, Monitor, Moon, Sun, Trash2 } from 'lucide-react';
import { useConfirm } from './Confirm';
import { useTheme } from '../hooks/useTheme';
import { usePlan } from '../hooks/usePlan';
import { sentence } from '../lib/format';
import { clearStored, selectionPath } from '../lib/storage';
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
export function Topbar() {
  const plan = usePlan();
  const { theme, resolved, cycle } = useTheme();
  const [ask, confirmDialog] = useConfirm();
  const sel = plan.selection;

  /** Empezar de nuevo. Borra el plan y el semestre —todo lo guardado menos el
   *  tema— y deja el onboarding tal como se ve la primera vez.
   *
   *  Confirma siempre: es la única acción de la app que destruye datos y no
   *  tiene deshacer. */
  async function startOver() {
    const n = plan.items.length;
    const ok = await ask({
      title: 'Empezar de nuevo',
      danger: true,
      confirmLabel: 'Empezar de nuevo',
      body:
        n > 0 ? (
          <>
            <p>
              Se borran el plan <b>{sel?.programName}</b> y{' '}
              {n === 1 ? 'la materia guardada' : `las ${n} materias guardadas`} en Mi semestre.
            </p>
            <p>No se puede deshacer.</p>
          </>
        ) : (
          <p>Se borra el plan elegido y todo vuelve al comienzo.</p>
        ),
    });
    if (!ok) return;

    // Borrar y RECARGAR, no borrar y navegar.
    //
    // Navegando quedaba el plan a medio morir: `navigate` de React Router va
    // en transición —diferido— mientras que limpiar el estado es urgente, así
    // que React pintaba un cuadro con `selection` en null y la ruta todavía en
    // /nivel/…/plan/2A74. En ese cuadro se despierta el efecto de Program que
    // adopta el plan de la URL (existe para las URLs pegadas), y el plan volvía
    // justo antes de que la navegación llegara.
    //
    // Una recarga no tiene ese hueco: el estado en memoria no sobrevive, y lo
    // que se lee al arrancar es el localStorage que se acaba de vaciar.
    clearStored();
    window.location.assign('/plan');
  }

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

        {/* El plan elegido. Es contexto y es botón: dice de qué plan es todo lo
            que hay debajo, y al tocarlo se empieza de cero. No es un selector
            —cambiar de plan sin más dejaba un semestre a medio borrar— así que
            no lleva el chevron de "elegí entre varios" sino una caneca, que es
            lo que de verdad pasa al tocarlo. */}
        {sel && (
          <button type="button" className="planchip" onClick={startOver}>
            <span className="planchip__code tnum">{sel.program}</span>
            <span className="planchip__name">{sentence(sel.programName)}</span>
            <span className="planchip__campus">{sel.campusName.replace(/^SEDE\s+/i, '')}</span>
            <Trash2 className="planchip__caret" size={14} strokeWidth={STROKE} aria-hidden="true" />
            <span className="sr-only">Empezar de nuevo</span>
          </button>
        )}

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

      {/* Va acá por comodidad, no por sitio: un <dialog> modal se pinta en la
          capa superior del documento, así que dónde esté escrito no cambia
          nada de dónde aparece. */}
      {confirmDialog}
    </header>
  );
}
