import { useCallback, useEffect, useState } from 'react';
import { applyTheme, loadTheme, nextTheme, resolveTheme, type Theme } from '../lib/theme';

/**
 * El tema elegido y cómo cambiarlo.
 *
 * `resolved` es lo que se está viendo de verdad: hace falta aparte de `theme`
 * porque con 'system' el icono del botón tiene que decir qué hay en pantalla,
 * no qué opción está guardada.
 *
 * El listener del media query solo importa en modo 'system': es lo que hace
 * que el icono se corrija solo cuando el sistema operativo cruza a modo noche
 * con la pestaña abierta.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(loadTheme()));

  useEffect(() => {
    applyTheme(theme);
    setResolved(resolveTheme(theme));

    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const cycle = useCallback(() => setTheme((t) => nextTheme(t)), []);

  return { theme, resolved, setTheme, cycle };
}
