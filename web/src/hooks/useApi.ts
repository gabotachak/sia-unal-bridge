// useApi: pedir datos sin repetir el mismo baile en cada pantalla.
//
// Un "hook" es solo una función que empieza con `use` y que usa otros hooks.
// No hay magia: acá adentro están useState (recordar) y useEffect (hacer algo
// después de pintar). Se escriben bien UNA vez y las vistas no vuelven a verlos.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, type Freshness } from '../api/client';

export type State<T> = {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  freshness: Freshness | null;
  /** Segundos transcurridos en la petición en curso. Para el cronómetro. */
  elapsed: number;
  /** Vuelve a pedir. Opcionalmente a otra ruta (ej: la misma con ?max_age=0). */
  reload: (overridePath?: string) => void;
};

/**
 * Pide `path` cuando el componente aparece, y cada vez que `path` cambia.
 *
 * `path` es la dependencia del efecto: es una cadena, así que React la compara
 * por valor y el efecto se dispara exactamente cuando la ruta cambia de verdad.
 * (Si fuera un objeto se dispararía en cada repintado — el clásico bucle
 * infinito de useEffect.)
 */
export function useApi<T>(path: string | null): State<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [nonce, setNonce] = useState(0);

  // useRef guarda un valor SIN provocar repintados. Acá sirve para saber si
  // la respuesta que llegó sigue siendo la que interesa: si el usuario navegó
  // mientras el SIA tardaba 8 s, la respuesta vieja debe descartarse.
  const override = useRef<string | null>(null);

  const reload = useCallback((overridePath?: string) => {
    override.current = overridePath ?? null;
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!path) return;
    const target = override.current ?? path;
    override.current = null;

    let cancelled = false;
    const startedAt = Date.now();

    setLoading(true);
    setError(null);
    setElapsed(0);

    // Cronómetro: un miss frío contra el SIA tarda segundos y la interfaz lo
    // muestra en vez de fingir que es instantáneo.
    const ticker = window.setInterval(() => {
      if (!cancelled) setElapsed((Date.now() - startedAt) / 1000);
    }, 100);

    get<T>(target)
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setFreshness(res.freshness);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err : new ApiError(0, 'internal', String(err)));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    // Lo que devuelve useEffect se ejecuta al desmontar o antes de repetirse.
    // Es la forma de no dejar temporizadores sueltos ni pintar respuestas de
    // una pantalla que el usuario ya abandonó.
    return () => {
      cancelled = true;
      window.clearInterval(ticker);
    };
  }, [path, nonce]);

  return { data, error, loading, freshness, elapsed, reload };
}
