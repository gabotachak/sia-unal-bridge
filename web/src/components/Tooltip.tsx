import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import './Tooltip.css';

type Placement = 'top' | 'bottom';

/** Mismo retraso que el globito de `IconButton` (ver IconButton.css): entra
 *  tarde porque un mouse de PASO por la fila no pide explicación de nada,
 *  pero sale ya — quedarse colgado cuando el mouse ya se fue se lee como un
 *  bug. Con teclado no hay "de paso": el foco entra ya decidido, así que ahí
 *  no hay retraso. */
const HOVER_DELAY = 400;

type Props = {
  /** Lo que va adentro del panel. Texto suelto sirve, pero `.tt-title` /
   *  `.tt-body` / `.tt-rows` (ver Tooltip.css) arman algo con jerarquía en
   *  vez de una frase corrida. */
  content: React.ReactNode;
  placement?: Placement;
  /**
   * Solo para texto que se recorta con `text-overflow: ellipsis`: el
   * tooltip se queda callado si el texto YA entra completo — repetir en un
   * globito lo que ya se lee en la fila no informa nada, solo estorba. Mide
   * `scrollWidth` contra `clientWidth` del propio trigger con un
   * `ResizeObserver`, así que sigue siendo cierto aunque la columna cambie
   * de ancho (el panel de Mi horario se redimensiona a mano).
   */
  onlyIfTruncated?: boolean;
  children: ReactElement<Record<string, unknown>>;
};

/**
 * El único tooltip de la app — nunca `title=` nativo.
 *
 * Dos razones, no una:
 *   1. `title` tarda medio segundo largo en aparecer, no se puede maquetar
 *      (una sola línea, tipografía del sistema) y desaparece si el mouse
 *      tiembla. No hay forma de mostrar ahí un desglose por tipología.
 *   2. Vive en un portal a `document.body`, posicionado con coordenadas
 *      medidas (`getBoundingClientRect`), no con `position: absolute`
 *      adentro del propio elemento. Eso es lo que le permite salir de una
 *      fila de tabla con `overflow: hidden` sin que lo recorten — un panel
 *      `absolute` anclado ADENTRO de esa fila no puede.
 *
 * No envuelve al hijo en una caja nueva salvo que el hijo esté
 * `disabled`: un botón deshabilitado no dispara `mouseenter`/`focus` en
 * todos los navegadores (Firefox, notablemente), así que ahí sí hace falta
 * un `span` alrededor que reciba el hover en su lugar. Si no está
 * deshabilitado, le clona los props (ref, foco, `aria-describedby`) directo
 * encima — así una celda con `flex` y `text-overflow: ellipsis` no gana una
 * caja de más que le arruine el cálculo de ancho.
 */
export function Tooltip({ content, placement = 'top', onlyIfTruncated = false, children }: Props) {
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });
  // Sin gating: siempre "cortado" — el show normal decide todo lo demás.
  const [truncated, setTruncated] = useState(!onlyIfTruncated);

  function reposition() {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const t = trigger.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const gap = 8;
    const margin = 8;

    let top = placement === 'top' ? t.top - p.height - gap : t.bottom + gap;
    // Sin espacio en el sentido preferido: se voltea, nunca se corta.
    if (placement === 'top' && top < margin) top = t.bottom + gap;
    if (placement === 'bottom' && top + p.height > window.innerHeight - margin) {
      top = t.top - p.height - gap;
    }

    let left = t.left + t.width / 2 - p.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - p.width - margin));

    setPos({ top, left });
    setVisible(true);
  }

  useLayoutEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    reposition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, content, placement]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-mide cada vez que el propio trigger cambia de tamaño — no solo la
  // ventana: el panel de Mi horario se arrastra a mano (`usePanelWidth`), y
  // eso angosta o ensancha la columna sin que la ventana se mueva un píxel.
  useLayoutEffect(() => {
    if (!onlyIfTruncated) return;
    const el = triggerRef.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onlyIfTruncated, content]);

  useEffect(() => () => cancelHover(), []);

  function cancelHover() {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }
  function showOnHover() {
    if (!truncated) return;
    cancelHover();
    hoverTimer.current = window.setTimeout(() => setOpen(true), HOVER_DELAY);
  }
  function showOnFocus() {
    if (!truncated) return;
    setOpen(true);
  }
  function hide() {
    cancelHover();
    setOpen(false);
  }
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') hide();
  }

  const disabled = !!children.props.disabled;

  const trigger = disabled ? (
    <span
      ref={triggerRef as React.Ref<HTMLSpanElement>}
      className="tt-disabled-wrap"
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={showOnHover}
      onMouseLeave={hide}
      onFocus={showOnFocus}
      onBlur={hide}
      onKeyDown={onKeyDown}
    >
      {children}
    </span>
  ) : (
    cloneElement(children, {
      ref: triggerRef,
      // Sin truncar y con gating puesto, nunca va a haber nada que mostrar:
      // meterlo igual en el orden de tabulación sería un parón mudo, así que
      // se queda con el tabIndex que ya traía (casi siempre ninguno).
      tabIndex: truncated ? ((children.props.tabIndex as number | undefined) ?? 0) : children.props.tabIndex,
      'aria-describedby': truncated ? id : undefined,
      onMouseEnter: (e: React.MouseEvent) => {
        (children.props.onMouseEnter as ((e: React.MouseEvent) => void) | undefined)?.(e);
        showOnHover();
      },
      onMouseLeave: (e: React.MouseEvent) => {
        (children.props.onMouseLeave as ((e: React.MouseEvent) => void) | undefined)?.(e);
        hide();
      },
      onFocus: (e: React.FocusEvent) => {
        (children.props.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
        showOnFocus();
      },
      onBlur: (e: React.FocusEvent) => {
        (children.props.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
        hide();
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        (children.props.onKeyDown as ((e: React.KeyboardEvent) => void) | undefined)?.(e);
        onKeyDown(e);
      },
    })
  );

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="tooltip"
            className="tt-panel"
            style={{ top: pos.top, left: pos.left, opacity: visible ? 1 : 0 }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
