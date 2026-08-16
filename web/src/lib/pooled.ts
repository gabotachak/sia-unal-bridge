/**
 * Ejecuta `fn` sobre cada elemento, con como mucho `limit` en vuelo a la vez.
 *
 * El límite no es capricho: del otro lado hay un pool de 4 sesiones ADF y cada
 * una es estrictamente secuencial. Disparar 10 peticiones juntas no las hace
 * más rápidas —se encolan igual— pero sí deja la API sin conexiones libres
 * para cualquier otra pestaña abierta. Cuatro a la vez es exactamente lo que
 * el back puede atender en paralelo.
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
