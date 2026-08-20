import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { loadScheduleListWidth, saveScheduleListWidth } from '../lib/storage';

/**
 * El ancho de arranque: el que el panel de materias tenía fijo antes de este
 * resizer (`git log` — `flex: 0 0 22rem`, sin encoger). Ya no es el tope —ver
 * `maxRem`— pero sigue siendo el default y el valor que NO se persiste.
 */
const DEFAULT_REM = 22;

/** El piso. Por debajo el nombre y los cupos de la tabla dejan de leerse
 *  (`styles/table.css`, el nivel más apretado de columnas) — arrastrar
 *  hasta ahí y no más lejos es a propósito, no falta de rango. */
const MIN_REM = 16;

/** Antes de que el ResizeObserver mida por primera vez no hay tope que
 *  aplicar. Alto a propósito: la primera medida lo baja, y bajarlo una vez
 *  es correcto; empezar apretado y soltar se vería como un salto. */
const UNMEASURED_MAX_REM = Number.POSITIVE_INFINITY;

const STEP_REM = 1;

function rootFontPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize);
}

/**
 * El ancho del panel de materias en Mi horario, arrastrable con el mouse
 * o el teclado (`role="separator"`, flechas izq/der).
 *
 * Se guarda en localStorage con el mismo criterio que `saveSort` o
 * `saveScheduleSelection`: dejado en DEFAULT_REM —el original— no se guarda
 * nada, así que quien nunca toca el resizer no arrastra una clave vacía
 * entre sesiones.
 *
 * El tope ya no es un número fijo: es la MITAD de la fila, para que el panel
 * pueda llegar a medir exactamente lo mismo que el calendario. "Mitad" es
 * `(ancho del contenedor - gap) / 2` y no `50%` a secas: entre los dos hay
 * un `--gap-lg` de aire (el resizer vive dentro de ese gap con márgenes
 * negativos, así que no suma ancho propio), y repartir el ancho crudo le
 * daría al panel media pastilla de más.
 *
 * Se mide con ResizeObserver sobre `.sched__body` —hay que colgarle
 * `containerRef`— y no con `window.innerWidth`: la fila vive dentro de
 * `.content`, que tiene `max-width: var(--measure)` y padding con `clamp`,
 * así que el ancho de la ventana no dice nada del ancho disponible acá.
 */
export function usePanelWidth() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [maxRem, setMaxRem] = useState(UNMEASURED_MAX_REM);
  const [widthRem, setWidthRem] = useState<number>(
    () => loadScheduleListWidth() ?? DEFAULT_REM,
  );
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const clamp = useCallback(
    (rem: number) => Math.min(maxRem, Math.max(MIN_REM, rem)),
    [maxRem],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      // `columnGap` leído del elemento y no `--gap-lg` hardcodeado: si el
      // gap cambia por media query, el tope cambia con él.
      const gapPx = parseFloat(getComputedStyle(el).columnGap) || 0;
      const half = (entry.contentRect.width - gapPx) / 2;
      setMaxRem(Math.max(MIN_REM, half / rootFontPx()));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // El tope bajó (ventana más angosta) y el ancho guardado ya no cabe.
  useEffect(() => {
    setWidthRem((w) => Math.min(w, maxRem));
  }, [maxRem]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = widthRem;
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [widthRem],
  );

  useEffect(() => {
    if (!dragging) return;
    const rootPx = rootFontPx();
    function onMove(e: globalThis.PointerEvent) {
      const deltaRem = (e.clientX - startXRef.current) / rootPx;
      setWidthRem(clamp(startWidthRef.current + deltaRem));
    }
    function onUp() {
      setDragging(false);
    }
    // Sin esto, arrastrar rápido selecciona el texto de las tarjetas de
    // abajo — el cursor se mueve más rápido que el ancho del panel.
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, clamp]);

  // Se guarda al soltar, no en cada pixel: escribir a localStorage en
  // cada `pointermove` es tirar cientos de escrituras por un arrastre de
  // medio segundo.
  useEffect(() => {
    if (dragging) return;
    saveScheduleListWidth(widthRem === DEFAULT_REM ? null : widthRem);
  }, [widthRem, dragging]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowLeft') {
        setWidthRem((w) => clamp(w - STEP_REM));
        e.preventDefault();
      } else if (e.key === 'ArrowRight') {
        setWidthRem((w) => clamp(w + STEP_REM));
        e.preventDefault();
      }
    },
    [clamp],
  );

  return {
    containerRef,
    widthRem,
    dragging,
    onPointerDown,
    onKeyDown,
    min: MIN_REM,
    max: Number.isFinite(maxRem) ? maxRem : DEFAULT_REM,
  };
}
