// useApi: pedir datos sin repetir el mismo baile en cada pantalla.
//
// Un "hook" es solo una función que empieza con `use` y que usa otros hooks.
// No hay magia: acá adentro están useState (recordar) y useEffect (hacer algo
// después de pintar). Se escriben bien UNA vez y las vistas no vuelven a verlos.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, type Freshness } from '../api/client';
import { MAX_RETRIES, backoffMs, isTransient, sleep } from '../lib/retry';

export type State<T> = {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  freshness: Freshness | null;
  /** Segundos transcurridos en la petición en curso. Para el cronómetro. */
  elapsed: number;
  /** En qué reintento va, 0 mientras sea el primer intento. */
  attempt: number;
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
 *
 * Los fallos transitorios del SIA se reintentan solos antes de que nadie los
 * vea. Un `sia_noop` es una sesión ADF que caducó del lado de ellos: la
 * petición idéntica, repetida, funciona. Mostrar ese error y un botón de
 * "reintentar" era hacerle apretar a una persona el botón que la máquina podía
 * apretar sola. El botón sigue existiendo, pero para lo que de verdad falló.
 */
export function useApi<T>(path: string | null): State<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [nonce, setNonce] = useState(0);

  // useRef guarda un valor SIN provocar repintados. Acá sirve para saber si
  // la respuesta que llegó sigue siendo la que interesa: si el usuario navegó
  // mientras el SIA tardaba 8 s, la respuesta vieja debe descartarse.
  const override = useRef<string | null>(null);

  const reload = useCallback((overridePath?: string) => {
    override.current = overridePath ?? null;
    setNonce((n) => n + 1);
  }, []);

  // Volver a la pestaña vuelve a pedir. Sin esto, una pestaña abierta una hora
  // muestra el estado de hace una hora: el efecto de abajo solo se dispara al
  // montar o al cambiar `path`, y nada de eso pasa mientras la pestaña vive
  // en segundo plano.
  //
  // Es una petición normal, SIN `max_age=0`: el read-through responde desde
  // Postgres mientras el dato esté fresco (catálogo 7 d, detalle 24 h), así
  // que volver a la pestaña no le cuesta nada al SIA.
  useEffect(() => {
    if (!path) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [path, reload]);

  useEffect(() => {
    if (!path) return;
    const target = override.current ?? path;
    override.current = null;

    let cancelled = false;
    const startedAt = Date.now();

    setLoading(true);
    setError(null);
    setElapsed(0);
    setAttempt(0);

    // Cronómetro: un miss frío contra el SIA tarda segundos y la interfaz lo
    // muestra en vez de fingir que es instantáneo. Sigue corriendo entre
    // reintentos a propósito — lo que se está midiendo es la espera de quien
    // mira, no la de cada intento por separado.
    const ticker = window.setInterval(() => {
      if (!cancelled) setElapsed((Date.now() - startedAt) / 1000);
    }, 100);

    (async () => {
      for (let i = 0; i <= MAX_RETRIES; i++) {
        try {
          const res = await get<T>(target);
          if (cancelled) return;
          setData(res.data);
          setFreshness(res.freshness);
          setError(null);
          return;
        } catch (e) {
          if (cancelled) return;

          // Un error que no se arregla repitiendo —un plan que no existe, un
          // 429 de cooldown— se muestra de una: insistir sería hacer esperar
          // por nada y castigar al SIA con peticiones que ya sabemos cómo
          // terminan.
          if (!isTransient(e) || i === MAX_RETRIES) {
            setError(e instanceof ApiError ? e : new ApiError(0, 'internal', String(e)));
            return;
          }

          setAttempt(i + 1);
          await sleep(backoffMs(i));
          if (cancelled) return;
        }
      }
    })().finally(() => {
      if (!cancelled) setLoading(false);
    });

    // Lo que devuelve useEffect se ejecuta al desmontar o antes de repetirse.
    // Es la forma de no dejar temporizadores sueltos ni pintar respuestas de
    // una pantalla que el usuario ya abandonó.
    return () => {
      cancelled = true;
      window.clearInterval(ticker);
    };
  }, [path, nonce]);

  return { data, error, loading, freshness, elapsed, attempt, reload };
}
