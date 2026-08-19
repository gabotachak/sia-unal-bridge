import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

const DEFAULT_BOTTOM_MARGIN_PX = 32;

export type ViewportFitOptions = {
  /** Aire entre el elemento y el borde de abajo de la ventana. */
  bottomMarginPx?: number;
  /**
   * Por debajo de este ancho, no topea nada: devuelve `Infinity` y el
   * elemento vuelve a su alto natural.
   *
   * Es apilado y no lado a lado (ver `STACK_BREAKPOINT_PX`): ahí abajo no
   * hay un hermano con el que compartir la página, así que topear el alto
   * solo agrega un scroll propio adentro de otro scroll — la app entera
   * pasa a tener un único scroll, el de la página, como cualquier sitio en
   * el teléfono.
   */
  disableBelowPx?: number;
};

/**
 * Cuánto alto queda libre debajo de DONDE ESTÉ el elemento, hasta el borde
 * de la ventana — no un número fijo adivinado en CSS.
 *
 * Se mide el `top` real (`getBoundingClientRect`) porque es la única forma
 * honesta de saberlo: depende de qué haya arriba en la página, y eso varía
 * entre pantallas y entre estados de la misma pantalla. Dos elementos que
 * arrancan a la misma altura —hermanos en una fila, por ejemplo— miden el
 * mismo disponible con este hook, que es justo lo que hace falta para que
 * dos paneles lado a lado terminen del mismo alto sin coordinarse entre sí.
 */
export function useViewportFit<T extends HTMLElement>(
  options: ViewportFitOptions = {},
): [RefObject<T | null>, number] {
  const { bottomMarginPx = DEFAULT_BOTTOM_MARGIN_PX, disableBelowPx } = options;
  const ref = useRef<T>(null);
  const [maxHeightRem, setMaxHeightRem] = useState(Infinity);

  useLayoutEffect(() => {
    function measure() {
      if (disableBelowPx !== undefined && window.innerWidth < disableBelowPx) {
        setMaxHeightRem(Infinity);
        return;
      }
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
      setMaxHeightRem((window.innerHeight - top - bottomMarginPx) / rootPx);
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [bottomMarginPx, disableBelowPx]);

  return [ref, maxHeightRem];
}
