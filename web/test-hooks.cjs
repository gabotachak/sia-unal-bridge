const assert = require('assert');

let queuedEffects = [];
let renders = 0;

function createHookRunner() {
  let states = [];
  let effects = [];
  let stateIndex = 0;
  let effectIndex = 0;

  return {
    reset() {
      stateIndex = 0;
      effectIndex = 0;
    },
    useState(initialValue) {
      const idx = stateIndex++;
      if (states.length <= idx) {
        states.push(typeof initialValue === 'function' ? initialValue() : initialValue);
      }
      const setter = (newValue) => {
        const val = typeof newValue === 'function' ? newValue(states[idx]) : newValue;
        if (states[idx] !== val) {
          states[idx] = val;
          scheduleRender();
        }
      };
      return [states[idx], setter];
    },
    useRef(initialValue) {
      const idx = stateIndex++;
      if (states.length <= idx) {
        states.push({ current: initialValue });
      }
      return states[idx];
    },
    useEffect(callback, deps) {
      const idx = effectIndex++;
      if (effects.length <= idx) {
        effects.push({ deps, cleanup: null });
        queuedEffects.push(() => {
          effects[idx].cleanup = callback();
        });
      } else {
        const oldDeps = effects[idx].deps;
        let changed = !oldDeps || !deps || oldDeps.length !== deps.length || oldDeps.some((d, i) => d !== deps[i]);
        if (changed) {
          effects[idx].deps = deps;
          queuedEffects.push(() => {
            if (effects[idx].cleanup) effects[idx].cleanup();
            effects[idx].cleanup = callback();
          });
        }
      }
    },
    useCallback(fn, deps) {
      const idx = stateIndex++;
      if (states.length <= idx) {
        states.push({ fn, deps });
        return fn;
      }
      const oldDeps = states[idx].deps;
      let changed = !oldDeps || !deps || oldDeps.length !== deps.length || oldDeps.some((d, i) => d !== deps[i]);
      if (changed) {
        states[idx] = { fn, deps };
      }
      return states[idx].fn;
    },
    useMemo(fn, deps) {
      const idx = stateIndex++;
      if (states.length <= idx) {
        const val = fn();
        states.push({ val, deps });
        return val;
      }
      const oldDeps = states[idx].deps;
      let changed = !oldDeps || !deps || oldDeps.length !== deps.length || oldDeps.some((d, i) => d !== deps[i]);
      if (changed) {
        const val = fn();
        states[idx] = { val, deps };
      }
      return states[idx].val;
    }
  };
}

let renderScheduled = false;
let Component = null;
const runner = createHookRunner();

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  Promise.resolve().then(() => {
    renderScheduled = false;
    renders++;
    runner.reset();
    Component(runner);
    
    // Run effects
    const effectsToRun = [...queuedEffects];
    queuedEffects = [];
    effectsToRun.forEach(fn => fn());
  });
}

function mount(Comp) {
  Component = Comp;
  scheduleRender();
}

function simulateProgram(hooks) {
  const { useState, useEffect, useRef, useCallback, useMemo } = hooks;

  // Simulate useApi
  const [data, setData] = useState({ courses: [] });
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const override = useRef(null);

  const reload = useCallback(() => {
    setLoading(true);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (nonce === 0) return; // ignore initial
    setLoading(true);
    
    setTimeout(() => {
      setData({ courses: ['new-data'] });
      setLoading(false);
    }, 10);
  }, [nonce]);

  const a = { data, loading, reload };

  // Program logic
  const autoMeasured = useRef(false);
  const batchDone = useRef(false);
  const [measuringCodes, setMeasuringCodes] = useState(new Set());
  const isReloading = a.loading;

  useEffect(() => {
    if (autoMeasured.current) return;
    autoMeasured.current = true;

    const pooled = async () => {
      setMeasuringCodes(prev => { const s = new Set(prev); s.add('C1'); return s; });
      await new Promise(r => setTimeout(r, 10)); // fake fetch
    };

    pooled().then(a.reload).then(() => { batchDone.current = true; });
  }, []);

  useEffect(() => {
    if (measuringCodes.size === 0 || !batchDone.current || isReloading) return;
    setMeasuringCodes(new Set());
  }, [isReloading, measuringCodes]);

  console.log(`Render ${renders}: isReloading=${isReloading}, batchDone=${batchDone.current}, measuringSize=${measuringCodes.size}`);
}

mount(simulateProgram);

setTimeout(() => {
  console.log("Done");
}, 500);
