import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { useNav, type Screen } from '../state/nav';

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: Screen;
  replace?: boolean;
  children?: ReactNode;
};

/**
 * El reemplazo de <Link>. No hay URL a la que apuntar —todas las pantallas
 * viven en "/"—, así que esto es un <a> que en vez de navegar de verdad
 * cambia de pantalla en memoria. El `href="/"` es decoración: mantiene la
 * semántica de enlace para lectores de pantalla, pero el clic nunca llega a
 * recargar nada porque el `onClick` lo intercepta primero.
 *
 * `forwardRef`: `Tooltip` (ver Tooltip.tsx) necesita el nodo real para medir
 * su posición con `getBoundingClientRect`. Sin esto sería un componente de
 * función pelado y el ref se perdería en el aire — React ni siquiera avisa
 * en silencio, solo el tooltip nunca aparecería.
 */
export const AppLink = forwardRef<HTMLAnchorElement, Props>(function AppLink(
  { to, replace, onClick, ...rest },
  ref,
) {
  const { navigate } = useNav();
  return (
    <a
      ref={ref}
      href="/"
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        navigate(to, { replace });
      }}
    />
  );
});
