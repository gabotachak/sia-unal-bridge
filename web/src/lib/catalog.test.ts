import { describe, expect, it } from 'vitest';
import type { CourseSummary } from '../api/types';
import { mergeCatalogs, seatsFromDetail, seatsUnknown } from './catalog';
import { STALE_SEATS_SECONDS } from '../api/client';
import type { Selection } from './storage';

function sel(program: string): Selection {
  return {
    level: 'pregrado',
    campus: '1101',
    campusName: 'sede bogotá',
    faculty: '2055',
    facultyName: 'facultad',
    program,
    programName: `plan ${program}`,
  };
}

function course(code: string, typology: string, over: Partial<CourseSummary> = {}): CourseSummary {
  return {
    campus_code: '1101',
    code,
    name: `asignatura ${code}`,
    credits: 3,
    typology,
    fetched_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

const A = sel('2A74');
const B = sel('2B10');

describe('mergeCatalogs — D6', () => {
  it('obligatoria en el primer plan, libre en el segundo: gana la obligatoria, alsoIn apunta al segundo', () => {
    const merged = mergeCatalogs([
      { plan: A, courses: [course('X', 'FUND. OBLIGATORIA (B)')] },
      { plan: B, courses: [course('X', 'LIBRE ELECCIÓN (L)')] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].typology).toBe('FUND. OBLIGATORIA (B)');
    expect(merged[0].plan).toBe(A);
    expect(merged[0].alsoIn).toEqual({ plan: B, typology: 'LIBRE ELECCIÓN (L)' });
  });

  it('al revés —el obligatorio en el SEGUNDO plan— gana igual el obligatorio, y ahora alsoIn apunta al primero', () => {
    const merged = mergeCatalogs([
      { plan: A, courses: [course('X', 'LIBRE ELECCIÓN (L)')] },
      { plan: B, courses: [course('X', 'FUND. OBLIGATORIA (B)')] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].typology).toBe('FUND. OBLIGATORIA (B)');
    expect(merged[0].plan).toBe(B);
    expect(merged[0].alsoIn).toEqual({ plan: A, typology: 'LIBRE ELECCIÓN (L)' });
  });

  it('el orden nuevo: NIVELACIÓN (E) le gana a DISCIPLINAR OBLIGATORIA (C)', () => {
    const merged = mergeCatalogs([
      { plan: A, courses: [course('X', 'DISCIPLINAR OBLIGATORIA (C)')] },
      { plan: B, courses: [course('X', 'NIVELACIÓN (E)')] },
    ]);
    expect(merged[0].typology).toBe('NIVELACIÓN (E)');
  });

  it('TRABAJO DE GRADO (P) le gana a todo', () => {
    const merged = mergeCatalogs([
      { plan: A, courses: [course('X', 'NIVELACIÓN (E)')] },
      { plan: B, courses: [course('X', 'TRABAJO DE GRADO (P)')] },
    ]);
    expect(merged[0].typology).toBe('TRABAJO DE GRADO (P)');
  });

  it('empate de rango (misma letra, o B contra C): gana el primer plan elegido, con alsoIn puesto', () => {
    const mismaLetra = mergeCatalogs([
      { plan: A, courses: [course('X', 'FUND. OBLIGATORIA (B)')] },
      { plan: B, courses: [course('X', 'FUND. OBLIGATORIA (B)')] },
    ]);
    expect(mismaLetra[0].plan).toBe(A);
    expect(mismaLetra[0].alsoIn).toEqual({ plan: B, typology: 'FUND. OBLIGATORIA (B)' });

    const bContraC = mergeCatalogs([
      { plan: A, courses: [course('Y', 'FUND. OBLIGATORIA (B)')] },
      { plan: B, courses: [course('Y', 'DISCIPLINAR OBLIGATORIA (C)')] },
    ]);
    expect(bContraC[0].plan).toBe(A);
    expect(bContraC[0].typology).toBe('FUND. OBLIGATORIA (B)');
    expect(bContraC[0].alsoIn).toEqual({ plan: B, typology: 'DISCIPLINAR OBLIGATORIA (C)' });
  });

  it('letra desconocida o formato raro: rango 0, no tira', () => {
    const merged = mergeCatalogs([
      { plan: A, courses: [course('X', 'RARO')] },
      { plan: B, courses: [course('X', '')] },
    ]);
    expect(() => merged).not.toThrow();
    expect(merged).toHaveLength(1);
    // Empate en rango 0: gana el primer plan.
    expect(merged[0].plan).toBe(A);
  });

  it('códigos que están en un solo plan: pasan tal cual, sin alsoIn', () => {
    const merged = mergeCatalogs([
      { plan: A, courses: [course('SOLO-A', 'LIBRE ELECCIÓN (L)')] },
      { plan: B, courses: [course('SOLO-B', 'LIBRE ELECCIÓN (L)')] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((c) => c.code === 'SOLO-A')?.alsoIn).toBeUndefined();
    expect(merged.find((c) => c.code === 'SOLO-B')?.alsoIn).toBeUndefined();
  });

  it('una sola parte: salida de igual largo y orden que la entrada, sin alsoIn', () => {
    const courses = [course('1', 'LIBRE ELECCIÓN (L)'), course('2', 'FUND. OBLIGATORIA (B)')];
    const merged = mergeCatalogs([{ plan: A, courses }]);
    expect(merged.map((c) => c.code)).toEqual(['1', '2']);
    expect(merged.every((c) => c.alsoIn === undefined)).toBe(true);
    expect(merged.every((c) => c.plan === A)).toBe(true);
  });

  it('el resultado no depende de section_schedules: el mismo par con y sin horarios da el mismo ganador', () => {
    const conHorarios = mergeCatalogs([
      { plan: A, courses: [course('X', 'LIBRE ELECCIÓN (L)', { section_schedules: [] })] },
      { plan: B, courses: [course('X', 'FUND. OBLIGATORIA (B)', { section_schedules: [{ key: '1', schedule: [] }] })] },
    ]);
    const sinHorarios = mergeCatalogs([
      { plan: A, courses: [course('X', 'LIBRE ELECCIÓN (L)')] },
      { plan: B, courses: [course('X', 'FUND. OBLIGATORIA (B)')] },
    ]);
    expect(conHorarios[0].plan).toEqual(sinHorarios[0].plan);
    expect(conHorarios[0].typology).toBe(sinHorarios[0].typology);
  });
});

describe('seatsUnknown', () => {
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
  const seats = (measured_at: string) => ({
    available: 5,
    measured_at,
    sections: 1,
    age_seconds: 0,
  });

  it('sin sello de detalle es incógnita: nadie preguntó nunca', () => {
    expect(seatsUnknown({})).toBe(true);
    expect(seatsUnknown({ detail_fetched_at: null })).toBe(true);
  });

  it('sin cupos pero con sello fresco NO es incógnita: se preguntó y no hay grupos', () => {
    expect(seatsUnknown({ detail_fetched_at: ago(60) })).toBe(false);
  });

  it('sin cupos y con sello viejo vuelve a ser incógnita', () => {
    expect(seatsUnknown({ detail_fetched_at: ago(STALE_SEATS_SECONDS + 60) })).toBe(true);
  });

  it('con cupos manda el sello de los cupos, no el del detalle', () => {
    // Detalle viejo, cupos recién medidos → hay dato, no incógnita.
    expect(
      seatsUnknown({
        seats: seats(ago(60)),
        detail_fetched_at: ago(STALE_SEATS_SECONDS + 600),
      }),
    ).toBe(false);
    // Y al revés: cupos viejos siguen siendo incógnita aunque el detalle sea nuevo.
    expect(
      seatsUnknown({
        seats: seats(ago(STALE_SEATS_SECONDS + 60)),
        detail_fetched_at: ago(10),
      }),
    ).toBe(true);
  });

  it('una fecha ilegible es incógnita, no un dato fresco', () => {
    expect(seatsUnknown({ detail_fetched_at: 'ayer' })).toBe(true);
  });
});

describe('seatsFromDetail', () => {
  const section = (key: string, seats?: { available: number; measured_at: string; age_seconds: number }) => ({
    term: '2026-2',
    key,
    number: 1,
    fetched_at: '2026-09-20T12:00:00Z',
    schedule: [],
    seats,
  });

  it('suma los grupos medidos y se queda con el sello del más viejo', () => {
    const seats = seatsFromDetail({
      sections: [
        section('1', { available: 5, measured_at: '2026-09-20T12:00:00Z', age_seconds: 10 }),
        section('2', { available: 7, measured_at: '2026-09-20T11:00:00Z', age_seconds: 3610 }),
        section('3'),
      ],
    });
    expect(seats).toEqual({
      available: 12,
      measured_at: '2026-09-20T11:00:00Z',
      sections: 2,
      age_seconds: 3610,
    });
  });

  it('sin grupos, o sin ninguno medido, no hay agregado: es "sin grupos", no un cero', () => {
    expect(seatsFromDetail({ sections: [] })).toBeUndefined();
    expect(seatsFromDetail({ sections: [section('1')] })).toBeUndefined();
  });
});
