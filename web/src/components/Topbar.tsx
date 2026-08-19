import { CalendarDays, LayoutList, ListChecks, Monitor, Moon, Sun, Trash2 } from 'lucide-react';
import { AppLink } from './AppLink';
import { useConfirm } from './Confirm';
import { useTheme } from '../hooks/useTheme';
import { usePlan } from '../hooks/usePlan';
import { sentence } from '../lib/format';
import { clearStored } from '../lib/storage';
import { useNav } from '../state/nav';
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
  const { screen } = useNav();
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
    // La pantalla que se está viendo (Program o Course) sigue llevando la
    // Selection vieja en su propio objeto —eso no lo borra `clearStored`,
    // vive en memoria— así que navegar sin recargar dejaría la vista
    // repintándose con datos de un plan que el localStorage ya olvidó.
    //
    // Una recarga no tiene ese problema: nada en memoria sobrevive, y la
    // pantalla inicial que arma NavProvider sale del localStorage que se
    // acaba de vaciar — que es plan-picker, porque ya no hay selección.
    clearStored();
    window.location.assign('/');
  }

  const themeLabel =
    theme === 'system' ? 'Tema: el del sistema' : theme === 'light' ? 'Tema: claro' : 'Tema: oscuro';

  return (
    <header className="bar">
      <div className="bar__inner">
        <AppLink
          className="brand"
          to={sel ? { name: 'program', selection: sel } : { name: 'plan-picker' }}
          aria-label="SIA Bridge — inicio"
        >
          {/* El Puente de Boyacá, el mismo trazo del favicon: un arco
              semicircular y dos tableros que se juntan en ángulo. La forma
              rara es lo que lo hace ESE puente y no un puente cualquiera. */}
          <svg className="brand__mark" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M2 18 16 11l14 7" />
            <path d="M8 24a8 8 0 0 1 16 0" />
            <path d="M2 18v6M30 18v6" />
          </svg>
          <span className="brand__word">SIA Bridge</span>
        </AppLink>

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
            <IconButton
              to={{ name: 'program', selection: sel }}
              active={screen.name === 'program'}
              label="Catálogo del plan"
            >
              <LayoutList size={ICON} strokeWidth={STROKE} />
            </IconButton>
          )}

          <IconButton
            to={{ name: 'semester' }}
            active={screen.name === 'semester'}
            label="Mi semestre"
            badge={plan.items.length}
          >
            <ListChecks size={ICON} strokeWidth={STROKE} />
          </IconButton>

          <IconButton
            to={{ name: 'schedule' }}
            active={screen.name === 'schedule'}
            label="Mi horario"
          >
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
