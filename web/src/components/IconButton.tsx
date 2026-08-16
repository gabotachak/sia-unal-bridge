import { NavLink } from 'react-router';
import './IconButton.css';

type Common = {
  /** Lo que hace. Es la etiqueta accesible Y el texto del globito. */
  label: string;
  children: React.ReactNode;
  /** Un número arriba a la derecha. Se oculta solo si es 0. */
  badge?: number;
  /** De qué lado sale el globito. Los del borde derecho apuntan a la izquierda. */
  tip?: 'bottom' | 'left';
  className?: string;
};

type AsButton = Common & {
  onClick: () => void;
  to?: never;
  disabled?: boolean;
  pressed?: boolean;
};

type AsLink = Common & {
  to: string;
  onClick?: never;
  end?: boolean;
};

/**
 * Un icono que se puede tocar.
 *
 * Es la unidad de la barra superior: donde antes había una palabra ahora hay
 * una forma, y el nombre vive en el globito y en el lector de pantalla. Un
 * icono sin `label` no existe en este archivo — sería un botón mudo para
 * quien navega con teclado.
 *
 * El globito es CSS puro, con retraso a la entrada y salida instantánea: no
 * puede aparecer al rozar la barra de paso, pero tampoco quedarse colgado
 * cuando ya te fuiste.
 */
export function IconButton(props: AsButton | AsLink) {
  const { label, children, badge, tip = 'bottom', className = '' } = props;
  const cls = `iconbtn ${className}`;

  const inner = (
    <>
      <span className="iconbtn__glyph" aria-hidden="true">
        {children}
      </span>
      {badge !== undefined && badge > 0 && (
        <span className="iconbtn__badge tnum" aria-hidden="true">
          {badge}
        </span>
      )}
    </>
  );

  if ('to' in props && props.to !== undefined) {
    return (
      <NavLink
        to={props.to}
        end={props.end}
        className={({ isActive }) => `${cls} ${isActive ? 'is-on' : ''}`}
        aria-label={label}
        data-tip={label}
        data-tip-side={tip}
      >
        {inner}
      </NavLink>
    );
  }

  return (
    <button
      type="button"
      className={`${cls} ${props.pressed ? 'is-on' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={label}
      aria-pressed={props.pressed}
      data-tip={label}
      data-tip-side={tip}
    >
      {inner}
    </button>
  );
}
