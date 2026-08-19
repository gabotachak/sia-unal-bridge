import { CalendarDays, LayoutList, ListChecks } from 'lucide-react';
import { AppLink } from './AppLink';
import { usePlan } from '../hooks/usePlan';
import { useNav, type Screen } from '../state/nav';
import './TabBar.css';

const ICON = 20;
const STROKE = 1.75;

/**
 * La navegación en el teléfono: una barra fija abajo con los tres destinos.
 *
 * Es la misma navegación de `Topbar` —los mismos tres iconos, en el mismo
 * orden— mudada al borde de abajo por debajo de `STACK_BREAKPOINT_PX`, donde
 * el pulgar llega y la esquina superior derecha no. Arriba se esconden
 * (`.iconbtn--dest`, Topbar.css) para que no estén los mismos tres botones
 * dos veces.
 *
 * Acá los iconos SÍ llevan palabra debajo, al revés que en la barra de
 * arriba: allá el nombre vive en un globito que sale al pasar el mouse, y en
 * una pantalla táctil ese globito no tiene a quién mostrarse (ver el
 * `@media (hover: none)` de IconButton.css). Sin hover, el rótulo tiene que
 * estar escrito.
 *
 * Sin plan elegido no se dibuja nada: la única pantalla que existe entonces
 * es el selector de plan, y una barra con tres destinos apagados es ruido en
 * la primera pantalla que alguien ve.
 */
export function TabBar() {
  const plan = usePlan();
  const { screen } = useNav();
  const sel = plan.selection;

  if (!sel) return null;

  /**
   * Qué pestaña se enciende. La ficha de una asignatura no es un destino de
   * la barra pero se llega a ella desde los tres, así que hereda la de
   * origen —el mismo `from` con el que su flecha de volver sabe a dónde
   * apunta (ver `Screen` en state/nav.ts)—. Sin esto, entrar a una materia
   * desde Mi semestre apagaba la barra entera y la pantalla quedaba
   * huérfana.
   */
  const active: Screen['name'] =
    screen.name === 'course' ? (screen.from ?? 'program') : screen.name;

  return (
    <nav className="tabbar" aria-label="Secciones">
      <Tab to={{ name: 'program', selection: sel }} active={active === 'program'} label="catálogo">
        <LayoutList size={ICON} strokeWidth={STROKE} aria-hidden="true" />
      </Tab>

      <Tab
        to={{ name: 'semester' }}
        active={active === 'semester'}
        label="mi semestre"
        badge={plan.items.length}
      >
        <ListChecks size={ICON} strokeWidth={STROKE} aria-hidden="true" />
      </Tab>

      <Tab to={{ name: 'schedule' }} active={active === 'schedule'} label="mi horario">
        <CalendarDays size={ICON} strokeWidth={STROKE} aria-hidden="true" />
      </Tab>
    </nav>
  );
}

function Tab({
  to,
  active,
  label,
  badge,
  children,
}: {
  to: Screen;
  active: boolean;
  label: string;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <AppLink
      to={to}
      className={`tabbar__tab ${active ? 'is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="tabbar__glyph">
        {children}
        {badge !== undefined && badge > 0 && (
          <span className="tabbar__badge tnum" aria-hidden="true">
            {badge}
          </span>
        )}
      </span>
      {label}
    </AppLink>
  );
}
