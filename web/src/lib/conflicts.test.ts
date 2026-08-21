import { describe, expect, it } from 'vitest';
import type { ClassSession } from '../api/types';
import {
  allSectionsConflict,
  blockId,
  candidateConflictKeys,
  computeConflicts,
  overlaps,
  type Block,
} from './conflicts';

/** LUNES de 09:00 a 11:00 → `at(1, '09:00', '11:00')`. */
function at(weekday: number, start: string, end: string): ClassSession {
  return { weekday, start_time: start, end_time: end };
}

function section(key: string, ...schedule: ClassSession[]) {
  return { key, schedule };
}

function block(itemId: string, sectionKey: string, session: ClassSession): Block {
  return { itemId, sectionKey, session };
}

describe('overlaps', () => {
  it('solapa dentro del mismo día', () => {
    expect(overlaps(at(1, '09:00', '11:00'), at(1, '10:00', '12:00'))).toBe(true);
  });

  it('contiguo no solapa: 11:00 termina donde el otro empieza', () => {
    expect(overlaps(at(1, '09:00', '11:00'), at(1, '11:00', '13:00'))).toBe(false);
  });

  it('días distintos nunca solapan, aunque sea la misma hora', () => {
    expect(overlaps(at(1, '09:00', '11:00'), at(3, '09:00', '11:00'))).toBe(false);
  });
});

describe('candidateConflictKeys', () => {
  const chosen = [block('otra', '1', at(1, '09:00', '11:00'))];

  it('devuelve solo las claves que chocan', () => {
    const keys = candidateConflictKeys(
      'esta',
      [section('1', at(1, '10:00', '12:00')), section('2', at(2, '10:00', '12:00'))],
      chosen,
    );
    expect([...keys]).toEqual(['1']);
  });

  it('una materia nunca choca consigo misma', () => {
    const propio = [block('esta', '1', at(1, '09:00', '11:00'))];
    expect(candidateConflictKeys('esta', [section('2', at(1, '09:00', '11:00'))], propio).size).toBe(
      0,
    );
  });

  it('sin nada elegido no hay con qué chocar', () => {
    expect(candidateConflictKeys('esta', [section('1', at(1, '09:00', '11:00'))], []).size).toBe(0);
  });
});

describe('allSectionsConflict', () => {
  // El caso del issue #34: 4 grupos, uno solo choca.
  const chosen = [block('otra', '1', at(1, '09:00', '11:00'))];
  const cuatroGrupos = [
    section('1', at(1, '10:00', '12:00')), // choca
    section('2', at(2, '10:00', '12:00')),
    section('3', at(3, '10:00', '12:00')),
    section('4', at(4, '10:00', '12:00')),
  ];

  it('no marca la materia si le queda algún grupo servible (issue #34)', () => {
    expect(allSectionsConflict('esta', cuatroGrupos, chosen)).toBe(false);
  });

  it('marca la materia solo cuando TODOS los grupos chocan', () => {
    const todosChocan = [
      section('1', at(1, '10:00', '12:00')),
      section('2', at(1, '08:00', '10:00')),
    ];
    expect(allSectionsConflict('esta', todosChocan, chosen)).toBe(true);
  });

  it('un grupo sin horario informado salva la materia', () => {
    const conUnoSinHorario = [section('1', at(1, '10:00', '12:00')), section('2')];
    expect(allSectionsConflict('esta', conUnoSinHorario, chosen)).toBe(false);
  });

  it('sin grupos no hay nada que avisar', () => {
    expect(allSectionsConflict('esta', [], chosen)).toBe(false);
  });

  it('sin nada elegido no hay nada que avisar', () => {
    expect(allSectionsConflict('esta', cuatroGrupos, [])).toBe(false);
  });

  it('el choque de una materia consigo misma no la marca', () => {
    const propio = [block('esta', '1', at(1, '09:00', '11:00'))];
    expect(allSectionsConflict('esta', [section('2', at(1, '10:00', '12:00'))], propio)).toBe(false);
  });
});

describe('computeConflicts', () => {
  it('marca los dos bloques de materias distintas que se pisan', () => {
    const a = block('mat-a', '1', at(1, '09:00', '11:00'));
    const b = block('mat-b', '1', at(1, '10:00', '12:00'));
    const { conflictBlocks, conflictItems } = computeConflicts([a, b]);
    expect(conflictBlocks).toEqual(new Set([blockId(a), blockId(b)]));
    expect(conflictItems).toEqual(new Set(['mat-a', 'mat-b']));
  });

  it('dos sesiones de la MISMA materia no son un choque', () => {
    const a = block('mat-a', '1', at(1, '09:00', '11:00'));
    const b = block('mat-a', '1', at(1, '10:00', '12:00'));
    const { conflictBlocks, conflictItems } = computeConflicts([a, b]);
    expect(conflictBlocks.size).toBe(0);
    expect(conflictItems.size).toBe(0);
  });
});
