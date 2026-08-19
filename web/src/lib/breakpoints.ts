/**
 * Debajo de esto, Mi horario apila la lista y el calendario en vez de
 * ponerlos lado a lado (ver `.sched__body` en Schedule.css). Los dos
 * paneles dejan de necesitar su propio scroll interno en ese punto —una
 * pantalla angosta ya solo tiene una columna, así que el scroll de la
 * página alcanza— así que `useViewportFit` también lo usa para saber
 * cuándo dejar de topear su alto. Un solo número para las dos cosas: que
 * nunca puedan desalinearse.
 */
export const STACK_BREAKPOINT_PX = 860;
