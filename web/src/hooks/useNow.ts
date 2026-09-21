import { useEffect, useState } from 'react';

/**
 * La hora, refrescada cada `everyMs`. Para pintar edades ("hace 3 min") sin
 * llamar a Date.now() durante el render —que no es puro y además se queda
 * congelado en un componente memoizado— y sin un temporizador por fila.
 */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}
