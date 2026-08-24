import { test, expect } from 'vitest';

function createHookRunner() {
  let states: any[] = [];
  let effects: any[] = [];
  let stateIndex = 0;
  let effectIndex = 0;
  let queuedEffects: any[] = [];

  return {
    reset() { stateIndex = 0; effectIndex = 0; },
    flush() {
      const e = [...queuedEffects];
      queuedEffects = [];
      e.forEach(fn => fn());
    },
    useState(init: any) {
      const idx = stateIndex++;
      if (states.length <= idx) states.push(typeof init === 'function' ? init() : init);
      const setter = (v: any) => {
        states[idx] = typeof v === 'function' ? v(states[idx]) : v;
      };
      return [states[idx], setter];
    },
    useRef(init: any) {
      const idx = stateIndex++;
      if (states.length <= idx) states.push({ current: init });
      return states[idx];
    },
    useEffect(cb: any, deps: any[]) {
      const idx = effectIndex++;
      if (effects.length <= idx) {
        effects.push({ deps });
        queuedEffects.push(cb);
      } else {
        const old = effects[idx].deps;
        if (!old || !deps || old.some((d: any, i: number) => d !== deps[i])) {
          effects[idx].deps = deps;
          queuedEffects.push(cb);
        }
      }
    },
    useCallback(fn: any) {
      const idx = stateIndex++;
      if (states.length <= idx) states.push(fn);
      return states[idx];
    }
  };
}

test('useApi con path null queda cargando infinitamente si se llama reload()', () => {
  const runner = createHookRunner();
  let loading = false;
  let nonce = 0;

  // simulacion de useApi para path=null
  function render(path: string | null) {
    runner.reset();
    
    // internals de useApi
    const [l, setL] = runner.useState(false);
    const [n, setN] = runner.useState(0);
    loading = l;
    nonce = n;
    
    const reload = runner.useCallback(() => {
      setL(true);
      setN((x: number) => x + 1);
    });

    runner.useEffect(() => {
      if (!path) return;
      // fetch sim...
      setL(false);
    }, [path, n]);

    return { reload };
  }

  // Montaje
  let hook = render(null);
  runner.flush();
  
  expect(loading).toBe(false); // Inicia sin cargar
  
  // Bug: Llamamos reload pero path es null
  hook.reload();
  hook = render(null); // re-render por cambio de estado
  runner.flush();
  
  // Como !path, retorna temprano y nunca hace setL(false)
  expect(loading).toBe(true);
  expect(nonce).toBe(1);
});
