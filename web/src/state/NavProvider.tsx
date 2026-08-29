import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePlan } from '../hooks/usePlan';
import { NavContext, type Screen } from './nav';

/**
 * El "router" de la app: no hay ninguno de verdad.
 *
 * Navegar con la URL no tiene sentido acá — no hay nada que un enlace pegado
 * en un chat pudiera reabrir, porque el catálogo es de UN plan elegido en el
 * navegador, no un recurso público con dirección propia. Así que la barra de
 * direcciones se queda fija en "/" siempre.
 *
 * Lo que sí se conserva es el botón de atrás/adelante: cada cambio de
 * pantalla empuja una entrada al historial con `pushState(estado, '', '/')`
 * — mismo path, estado distinto — y `popstate` es quien avisa cuando el
 * usuario usa el botón del navegador en vez de un enlace de la app.
 */
export function NavProvider({ children }: { children: React.ReactNode }) {
  const { selection } = usePlan();

  // Con un plan ya elegido, la pantalla inicial ES su catálogo. Sin plan, la
  // única que tiene sentido es la de elegirlo. Se calcula una sola vez, al
  // arrancar: si el plan cambia después es porque alguien navegó, y ese
  // cambio ya pasa por `navigate`, no por acá.
  const [initial] = useState<Screen>(() =>
    selection ? { name: 'program', selection } : { name: 'plan-picker' },
  );

  // El `screen` guardado en `history.state` SOBREVIVE a la recarga: recargar
  // no borra el estado de la entrada del historial. "Empezar de nuevo" vacía
  // el localStorage y recarga, así que sin este filtro la app vuelve a pintar
  // la pantalla vieja —el catálogo de un plan que ya no existe— en vez del
  // onboarding. Sin plan elegido, la ÚNICA pantalla válida es `initial`.
  const restore = useCallback(
    (saved: Screen | undefined): Screen => (selection && saved ? saved : initial),
    [selection, initial],
  );

  const [screen, setScreen] = useState<Screen>(() =>
    restore(window.history.state?.screen as Screen | undefined),
  );

  useEffect(() => {
    // La semilla de la primera entrada del historial: sin esto, la primerísima
    // carga no tiene `state`, y un "atrás" desde la segunda pantalla saldría
    // de la app en vez de volver acá.
    if (!window.history.state) window.history.replaceState({ screen }, '', '/');
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onPopState(e: PopStateEvent) {
      setScreen(restore(e.state?.screen as Screen | undefined));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [restore]);

  const navigate = useCallback((next: Screen, opts?: { replace?: boolean }) => {
    if (opts?.replace) window.history.replaceState({ screen: next }, '', '/');
    else window.history.pushState({ screen: next }, '', '/');
    setScreen(next);
  }, []);

  const api = useMemo(() => ({ screen, navigate }), [screen, navigate]);
  return <NavContext value={api}>{children}</NavContext>;
}
