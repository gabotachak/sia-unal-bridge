import { beforeEach, describe, expect, it } from 'vitest';
import {
  addToPlan,
  applySelect,
  loadPlan,
  loadPlans,
  planSelection,
  type PlanItem,
  type Selection,
} from './storage';

// Las mismas claves que storage.ts guarda por dentro — privadas ahí, pero
// esto es exactamente lo que hay que escribir a mano para simular un
// navegador con datos de una versión anterior (PLAN-DOUBLE-TITULATION.md,
// "Compatibilidad con lo que ya hay en los navegadores").
const KEY = 'tablero.semestre.v2';
const PICK_KEY = 'tablero.plan.v1';
const PLANS_KEY = 'tablero.planes.v2';

// No hay `localStorage` en el entorno de test (vitest corre en Node, sin
// DOM): un mock mínimo en memoria alcanza, porque lo único que storage.ts le
// pide son getItem/setItem/removeItem.
function fakeLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

beforeEach(() => {
  globalThis.localStorage = fakeLocalStorage();
});

function sel(level: string, campus: string, program: string): Selection {
  return {
    level,
    campus,
    campusName: `sede ${campus}`,
    faculty: '2055',
    facultyName: 'facultad',
    program,
    programName: `plan ${program}`,
  };
}

function item(code: string, over: Partial<PlanItem> = {}): PlanItem {
  return {
    level: 'pregrado',
    campus: '1101',
    program: '2A74',
    faculty: '2055',
    code,
    name: `asignatura ${code}`,
    credits: 3,
    typology: 'LIBRE ELECCIÓN (L)',
    addedAt: 0,
    ...over,
  };
}

describe('loadPlans — migración y validación de v2', () => {
  it('v1 presente y v2 ausente: migra, conserva el plan, y deja la v1 donde estaba', () => {
    const a = sel('pregrado', '1101', '2A74');
    localStorage.setItem(PICK_KEY, JSON.stringify(a));

    expect(loadPlans()).toEqual([a]);
    // La migración escribió v2, pero la v1 sigue intacta: es el seguro de
    // rollback.
    expect(localStorage.getItem(PICK_KEY)).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(PLANS_KEY)!)).toEqual([a]);
  });

  it('v1 y v2 presentes y distintas: manda la v2, la v1 ni se lee', () => {
    const v1 = sel('pregrado', '1101', '2A74');
    const v2 = [sel('pregrado', '1101', '2B10')];
    localStorage.setItem(PICK_KEY, JSON.stringify(v1));
    localStorage.setItem(PLANS_KEY, JSON.stringify(v2));

    expect(loadPlans()).toEqual(v2);
  });

  it('v2 con tres planes guardados a mano: se recorta a MAX_PLANS', () => {
    const three = [
      sel('pregrado', '1101', '2A74'),
      sel('pregrado', '1101', '2B10'),
      sel('pregrado', '1101', '2C20'),
    ];
    localStorage.setItem(PLANS_KEY, JSON.stringify(three));

    expect(loadPlans()).toEqual(three.slice(0, 2));
  });

  it('v2 con dos planes de igual selectionId: se deduplica', () => {
    const a = sel('pregrado', '1101', '2A74');
    const aAgain = { ...sel('pregrado', '1101', '2A74'), programName: 'nombre repetido' };
    localStorage.setItem(PLANS_KEY, JSON.stringify([a, aAgain]));

    expect(loadPlans()).toEqual([a]);
  });

  it.each(['{', '[]', 'null'])('basura en la clave (%s): [] sin tirar', (raw) => {
    localStorage.setItem(PLANS_KEY, raw);
    expect(() => loadPlans()).not.toThrow();
    expect(loadPlans()).toEqual([]);
  });
});

describe('planSelection — D3 y D4', () => {
  const a = sel('pregrado', '1101', '2A74');
  const b = sel('pregrado', '1101', '2B10');

  it('el MISMO conjunto no borra nada', () => {
    expect(planSelection([a, b], [a, b])).toBe('keep');
    // Ni el orden importa para "es el mismo conjunto".
    expect(planSelection([a, b], [b, a])).toBe('keep');
  });

  it('un conjunto DISTINTO, habiendo ya un plan, borra el semestre entero', () => {
    expect(planSelection([a], [b])).toBe('wipe');
    expect(planSelection([a], [a, b])).toBe('wipe');
  });

  it('elegir el PRIMER plan (no había ninguno) filtra en vez de borrar todo', () => {
    expect(planSelection([], [a])).toBe('filter');
    expect(planSelection([], [a, b])).toBe('filter');
  });

  it('dos planes de sedes distintas: null, nada cambia (D3)', () => {
    const otraSede = sel('pregrado', '5001', '2B10');
    expect(planSelection([], [a, otraSede])).toBeNull();
  });

  it('dos planes de niveles distintos: null, nada cambia (D3)', () => {
    const otroNivel = sel('posgrado', '1101', '2B10');
    expect(planSelection([], [a, otroNivel])).toBeNull();
  });

  it('más de MAX_PLANS: null', () => {
    const c = sel('pregrado', '1101', '2C20');
    expect(planSelection([], [a, b, c])).toBeNull();
  });

  it('conjunto vacío: null', () => {
    expect(planSelection([a], [])).toBeNull();
  });
});

describe('applySelect — la regla completa, con items', () => {
  const a = sel('pregrado', '1101', '2A74');
  const b = sel('pregrado', '1101', '2B10');

  it('primer plan elegido (currentPlans vacío) con materias guardadas de ANTES: las conserva si son de ese plan', () => {
    // El caso que `select()` en `main` preservaba: localStorage viejo o de
    // rollback con materias guardadas pero sin plan.v1 — PLAN-DOUBLE-TITULATION.md,
    // "Compatibilidad", caso 3.
    const items = [item('X', { program: '2A74' }), item('Y', { program: 'OTRO' })];
    const result = applySelect([], items, [a]);
    expect(result).not.toBeNull();
    expect(result!.plans).toEqual([a]);
    // Se queda con 'X' (es de 2A74) y descarta 'Y' (es de otro plan).
    expect(result!.items.map((i) => i.code)).toEqual(['X']);
  });

  it('primer plan elegido, doble titulación de una: conserva lo que sea de CUALQUIERA de los dos', () => {
    const items = [item('X', { program: '2A74' }), item('Y', { program: '2B10' }), item('Z', { program: 'OTRO' })];
    const result = applySelect([], items, [a, b]);
    expect(result!.items.map((i) => i.code).sort()).toEqual(['X', 'Y']);
  });

  it('cambio de verdad (ya había plan): borra todo, sin mirar si algo coincidía', () => {
    const items = [item('X', { program: '2A74' })];
    const result = applySelect([a], items, [b]);
    expect(result!.plans).toEqual([b]);
    expect(result!.items).toEqual([]);
  });

  it('mismo conjunto: los items no se tocan (misma referencia)', () => {
    const items = [item('X', { program: '2A74' })];
    const result = applySelect([a], items, [a]);
    expect(result!.items).toEqual(items);
  });

  it('conjunto inválido (D3): null, no toca nada', () => {
    const otraSede = sel('pregrado', '5001', '2B10');
    expect(applySelect([], [item('X')], [a, otraSede])).toBeNull();
  });
});

describe('addToPlan — D7 y D8', () => {
  it('un code que ya está desde OTRO plan: null (la invariante)', () => {
    const existing = [item('1000003-B', { program: '2A74' })];
    const fromOtherPlan = item('1000003-B', { program: '2B10' });
    expect(addToPlan(existing, fromOtherPlan, 1)).toBeNull();
  });

  it('agrega si el code no está', () => {
    const next = addToPlan([], item('9999999-A'), 42);
    expect(next).not.toBeNull();
    expect(next).toHaveLength(1);
    expect(next![0].addedAt).toBe(42);
  });

  it('el tope son 20 materias, con uno o con dos planes', () => {
    const full = Array.from({ length: 20 }, (_, i) => item(String(i)));
    expect(addToPlan(full, item('nueva'), 1)).toBeNull();
  });
});

describe('loadPlan — dedup por code', () => {
  it('con el mismo code guardado dos veces (de dos planes) devuelve una sola materia', () => {
    const dup = [item('1000003-B', { program: '2A74' }), item('1000003-B', { program: '2B10' })];
    localStorage.setItem(KEY, JSON.stringify(dup));

    const loaded = loadPlan();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].program).toBe('2A74'); // se queda con la primera
  });
});
