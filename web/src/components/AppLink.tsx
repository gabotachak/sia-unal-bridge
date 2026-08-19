import type { AnchorHTMLAttributes, ReactNode } from 'react';
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
 */
export function AppLink({ to, replace, onClick, ...rest }: Props) {
  const { navigate } = useNav();
  return (
    <a
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
}
