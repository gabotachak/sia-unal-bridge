import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

const DEFAULT_BOTTOM_MARGIN_PX = 32;

export type ViewportFitOptions = {
  /** Aire entre el elemento y el borde de abajo de la ventana. */
  bottomMarginPx?: number;
  /**
   * Por debajo de este ancho, usa `mobileBottomMarginPx` en vez de
   * `bottomMarginPx` — para un elemento que en mobile queda detrás de algo
   * fijo (una barra de pestañas, por ejemplo) que en escritorio no existe.
   */
  mobileBreakpointPx?: number;
  mobileBottomMarginPx?: number;
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
  const { bottomMarginPx = DEFAULT_BOTTOM_MARGIN_PX, mobileBreakpointPx, mobileBottomMarginPx } = options;
  const ref = useRef<T>(null);
  const [maxHeightRem, setMaxHeightRem] = useState(Infinity);

  useLayoutEffect(() => {
    function measure() {
      const el = ref.current;
      if (!el) return;
      const margin =
        mobileBreakpointPx !== undefined &&
        mobileBottomMarginPx !== undefined &&
        window.innerWidth < mobileBreakpointPx
          ? mobileBottomMarginPx
          : bottomMarginPx;
      const top = el.getBoundingClientRect().top;
      const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
      setMaxHeightRem((window.innerHeight - top - margin) / rootPx);
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [bottomMarginPx, mobileBreakpointPx, mobileBottomMarginPx]);

  return [ref, maxHeightRem];
}
