/**
 * El ancho donde la app deja de ser un escritorio y se vuelve un teléfono.
 *
 * Debajo de esto pasan dos cosas que son la misma decisión:
 *
 *  - La navegación baja. Los tres destinos —catálogo, Mi semestre, Mi
 *    horario— salen de la barra de arriba y se van a una barra fija abajo
 *    (`TabBar.tsx`), al alcance del pulgar, como en cualquier app de
 *    teléfono. Arriba queda solo lo que no es un destino: la marca, el chip
 *    del plan y el tema.
 *  - Mi horario se queda SOLO con el calendario. La lista de materias que
 *    lo acompaña en escritorio (`.sched__list`) era Mi semestre otra vez
 *    —las mismas tarjetas, los mismos radios, el mismo estado— y en el
 *    teléfono, con la barra de abajo, Mi semestre está a un toque. Un panel
 *    que duplica a la pantalla vecina no se gana media pantalla de las
 *    pocas que hay.
 */
export const STACK_BREAKPOINT_PX = 860;

/**
 * Cuánto le resta `useViewportFit` al alto disponible, debajo de
 * `STACK_BREAKPOINT_PX`, para que el calendario de Mi horario no termine su
 * alto calculado detrás de `.tabbar` (TabBar.css) — la barra de navegación
 * fija abajo en mobile. Cubre su alto (~3.6rem) más
 * `env(safe-area-inset-bottom)` en los teléfonos con home indicator.
 */
export const MOBILE_NAV_CLEARANCE_PX = 92;
