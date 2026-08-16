// El tema: claro, oscuro, o lo que diga el sistema.
//
// Son TRES estados, no dos. "Seguir al sistema" no es un default oculto: es
// una opción elegible, y la única que se adapta sola cuando el teléfono pasa
// a modo noche a las 7 de la tarde.
//
// La convención con el CSS: `data-theme` en <html> SOLO existe cuando hay una
// elección explícita. Sin atributo manda `prefers-color-scheme`, que es
// exactamente lo que significa "sistema".

export type Theme = 'light' | 'dark' | 'system';

export const THEME_KEY = 'tablero.tema.v1';

export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  } catch {
    return 'system';
  }
}

/** Escribe la elección en el documento y en localStorage. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Modo privado o cuota llena: el tema aplicado igual vale para esta sesión.
  }
}

/** Qué se está viendo de verdad ahora mismo, resolviendo 'system'. */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** El siguiente en el ciclo del botón: sistema → claro → oscuro → sistema. */
export function nextTheme(theme: Theme): Theme {
  return theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
}
