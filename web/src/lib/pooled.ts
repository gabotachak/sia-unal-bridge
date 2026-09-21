/**
 * Ejecuta `fn` sobre cada elemento, con como mucho `limit` en vuelo a la vez.
 *
 * El límite no es capricho: del otro lado hay un pool de `SIA_POOL_SIZE`
 * sesiones ADF y cada una es estrictamente secuencial. Disparar de más no las
 * hace más rápidas —se encolan igual— pero sí deja la API sin conexiones
 * libres para cualquier otra pestaña abierta. El límite que pasa `CONCURRENCY`
 * es exactamente lo que el back puede atender en paralelo.
 *
 * Cada resultado se entrega apenas llega, no al final: así la pantalla puede
 * ir mostrando materia por materia en vez de quedarse muda 10 segundos.
 */
export async function pooled<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Como `pooled`, pero abierta: se le puede seguir agregando trabajo mientras
 * corre, y soltar lo que todavía no empezó.
 *
 * Es lo que necesita la medición del catálogo, que no conoce sus objetivos de
 * entrada —son las filas que van ENTRANDO a la pantalla—, y que al salir de la
 * pantalla tiene que dejar de pedir: `clear()` vacía la cola sin tocar lo que
 * ya está en vuelo, que llega y se aprovecha igual.
 */
export function createQueue<T>(limit: number, run: (item: T) => Promise<void>) {
  const waiting: T[] = [];
  let inFlight = 0;

  function pump() {
    while (inFlight < limit && waiting.length > 0) {
      const item = waiting.shift() as T;
      inFlight++;
      void run(item)
        .catch(() => {})
        .finally(() => {
          inFlight--;
          pump();
        });
    }
  }

  return {
    push(item: T) {
      waiting.push(item);
      pump();
    },
    clear() {
      waiting.length = 0;
    },
  };
}

/**
 * De las filas que acaban de entrar a la pantalla, cuáles hay que medir: las
 * que siguen en duda y no se intentaron todavía. Las marca como intentadas
 * —una vez por visita, salga bien o mal— y las devuelve en el orden en que
 * se vieron.
 *
 * Aparte del IntersectionObserver a propósito: el observer no se puede probar
 * sin un DOM, y la decisión sí.
 */
export function pickToMeasure<T>(
  visibleIds: readonly string[],
  unknown: ReadonlyMap<string, T>,
  attempted: Set<string>,
): T[] {
  const picked: T[] = [];
  for (const id of visibleIds) {
    const item = unknown.get(id);
    if (item === undefined || attempted.has(id)) continue;
    attempted.add(id);
    picked.push(item);
  }
  return picked;
}
