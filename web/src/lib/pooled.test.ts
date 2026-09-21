import { describe, expect, it } from 'vitest';
import { createQueue } from './pooled';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createQueue', () => {
  it('nunca pasa del tope en vuelo, y toma lo que se agrega mientras corre', async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    const release: (() => void)[] = [];
    const q = createQueue<number>(2, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise<void>((r) => release.push(r));
      inFlight--;
      done.push(n);
    });

    [1, 2, 3].forEach((n) => q.push(n));
    await tick();
    expect(inFlight).toBe(2);

    q.push(4); // llega con la cola andando
    while (release.length) {
      release.shift()!();
      await tick();
    }
    expect(done).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('clear suelta lo que no empezó; lo que está en vuelo termina', async () => {
    const started: number[] = [];
    const release: (() => void)[] = [];
    const q = createQueue<number>(1, async (n) => {
      started.push(n);
      await new Promise<void>((r) => release.push(r));
    });
    q.push(1);
    q.push(2);
    q.clear();
    release.shift()!();
    await tick();
    expect(started).toEqual([1]);
  });

  it('un trabajo que falla no tranca la cola', async () => {
    const ran: number[] = [];
    const q = createQueue<number>(1, async (n) => {
      ran.push(n);
      if (n === 1) throw new Error('boom');
    });
    q.push(1);
    q.push(2);
    await tick();
    await tick();
    expect(ran).toEqual([1, 2]);
  });
});
