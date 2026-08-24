import { CalendarDays, Coffee, LayoutList, ListChecks, Monitor, Moon, Sun, Trash2 } from 'lucide-react';
import { AppLink } from './AppLink';
import { useConfirm } from './Confirm';
import { useTheme } from '../hooks/useTheme';
import { usePlan } from '../hooks/usePlan';
import { planColorVar } from '../lib/courseColors';
import { abbreviateEngineering, sentence } from '../lib/format';
import { clearStored, planCodes, planNames } from '../lib/storage';
import { useNav } from '../state/nav';
import { IconButton } from './IconButton';
import { Tooltip } from './Tooltip';
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
  const double = plan.plans.length > 1;

  /** Empezar de nuevo. Borra los planes y el semestre —todo lo guardado menos
   *  el tema— y deja el onboarding tal como se ve la primera vez.
   *
   *  Es la ÚNICA forma de declararse doble titulación tarde o de cambiar de
   *  plan (D4, PLAN-DOUBLE-TITULATION.md): no hay "agregar un segundo plan"
   *  en caliente, así que este mismo botón sirve para las dos cosas.
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
              Se borran {double ? 'los planes' : 'el plan'} <b>{planNames(plan.plans)}</b> y{' '}
              {n === 1 ? 'la materia guardada' : `las ${n} materias guardadas`} en Mi semestre.
            </p>
            <p>No se puede deshacer.</p>
          </>
        ) : (
          <p>
            Se {double ? 'borran los planes elegidos' : 'borra el plan elegido'} y todo vuelve al
            comienzo.
          </p>
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

  // El botón en sí, sin el hover: con un plan el nombre ya está escrito en
  // `.planchip__name` y repetirlo en un tooltip sería ruido en cada paso del
  // mouse. Con dos, el nombre se cayó de la barra (arriba) y el tooltip es lo
  // único que lo dice completo.
  const planChip = sel && (
    <button type="button" className="planchip" onClick={startOver}>
      <span className="planchip__code tnum">{double ? planCodes(plan.plans) : sel.program}</span>
      {!double && (
        <span className="planchip__name">{abbreviateEngineering(sentence(sel.programName))}</span>
      )}
      <span className="planchip__campus">{sel.campusName.replace(/^SEDE\s+/i, '')}</span>
      <Trash2 className="planchip__caret" size={14} strokeWidth={STROKE} aria-hidden="true" />
      <span className="sr-only">Empezar de nuevo</span>
    </button>
  );

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
            lo que de verdad pasa al tocarlo.

            Con un plan es BYTE POR BYTE el de `main` (D2, D4). Con dos, los
            códigos van juntos y el nombre se cae: no caben dos, y el nombre
            completo queda en el mismo hover que usa el resto de la app
            (Tooltip), no en un `title` nativo aparte. */}
        {double ? (
          <Tooltip
            content={
              <>
                {/* `.tt-row` es para pares label/valor con `space-between` —
                    con nombres de largo distinto entre los dos planes,
                    empujaba cada nombre a un punto distinto y desalineaba el
                    código. `.plan-attr-row` (components/PlanAttributionRow.css)
                    en vez de `PlanAttributionRow` en sí: acá no hay tipología
                    que atribuir, solo el código pegado al nombre. */}
                {plan.plans.map((p) => (
                  <p className="plan-attr-row" key={p.program}>
                    <span
                      className="chip__code tnum row__plan-tag"
                      style={{ color: planColorVar(p.program, plan.plans) }}
                    >
                      {p.program}
                    </span>
                    {abbreviateEngineering(sentence(p.programName))}
                  </p>
                ))}
              </>
            }
          >
            {planChip}
          </Tooltip>
        ) : (
          planChip
        )}

        {/* Los tres destinos llevan `iconbtn--dest`: es lo que los esconde
            por debajo de STACK_BREAKPOINT_PX, donde la navegación se muda a
            `.tabbar` (TabBar.tsx) y tenerlos acá arriba también sería
            dibujar los mismos tres botones dos veces. El tema no lleva la
            marca y se queda: no es un destino, es un ajuste — la barra de
            abajo es "a dónde voy", no "qué configuro". */}
        <nav className="bar__nav" aria-label="Secciones">
          {sel && (
            <IconButton
              to={{ name: 'program', selection: sel }}
              active={screen.name === 'program'}
              label="Catálogo del plan"
              className="iconbtn--dest"
            >
              <LayoutList size={ICON} strokeWidth={STROKE} />
            </IconButton>
          )}

          <IconButton
            to={{ name: 'semester' }}
            active={screen.name === 'semester'}
            label="Mi semestre"
            badge={plan.items.length}
            disabled={!sel}
            className="iconbtn--dest"
          >
            <ListChecks size={ICON} strokeWidth={STROKE} />
          </IconButton>

          <IconButton
            to={{ name: 'schedule' }}
            active={screen.name === 'schedule'}
            label="Mi horario"
            disabled={!sel}
            className="iconbtn--dest"
          >
            <CalendarDays size={ICON} strokeWidth={STROKE} />
          </IconButton>

          {/* La única llamada a la acción de toda la barra: por eso no lleva
              `iconbtn--dest` —se queda arriba también en el teléfono, en vez
              de mudarse a `.tabbar` con los tres destinos de verdad— y por
              eso es la única con color de fondo en reposo. Un icono gris más
              nunca iba a competir por atención con el catálogo. */}
          <AppLink
            to={{ name: 'donate' }}
            className={`donatebtn ${screen.name === 'donate' ? 'is-on' : ''}`}
            aria-label="Invítame un café"
            onClick={(e) => {
              if (screen.name === 'donate') {
                e.preventDefault();
                window.history.back();
              }
            }}
          >
            <Coffee size={ICON} strokeWidth={STROKE} aria-hidden="true" />
            <span className="donatebtn__word">Invítame un café</span>
          </AppLink>

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
