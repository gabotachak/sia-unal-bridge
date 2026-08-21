import { describe, expect, it } from 'vitest';
import type { ClassSession } from '../api/types';
import {
  allSectionsConflict,
  blockId,
  candidateConflictKeys,
  classifyConflict,
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

describe('classifyConflict', () => {
  // Mi horario de las capturas del issue #34, tal cual:
  //   Modelos estocásticos  MI 14-16
  //   Democracia p/ extra.  JU 14-17
  //   Bogotá musical        MA 17-20
  const miHorario: Block[] = [
    block('modelos', '2', at(3, '14:00', '16:00')),
    block('democracia', '1', at(4, '14:00', '17:00')),
    block('bogota', '1', at(2, '17:00', '20:00')),
  ];

  describe('sin detalle todavía', () => {
    it('no marca nada: no se sabe, y falla abierto', () => {
      expect(
        classifyConflict({ itemId: 'x', sections: undefined, chosenBlocks: miHorario }),
      ).toBe(null);
    });
  });

  describe('con grupo ya elegido', () => {
    const sections = [
      section('1', at(1, '07:00', '09:00')), // libre
      section('2', at(3, '14:00', '16:00')), // choca con modelos
    ];

    it('ROJO si el grupo elegido choca', () => {
      expect(
        classifyConflict({ itemId: 'x', sections, pickedKey: '2', chosenBlocks: miHorario }),
      ).toBe('active');
    });

    it('NADA si el grupo elegido no choca, aunque una alternativa sí', () => {
      expect(
        classifyConflict({ itemId: 'x', sections, pickedKey: '1', chosenBlocks: miHorario }),
      ).toBe(null);
    });

    it('ROJO aunque queden alternativas libres: el elegido es un bloqueo real', () => {
      const conSalida = [...sections, section('3', at(6, '08:00', '10:00'))];
      expect(
        classifyConflict({ itemId: 'x', sections: conSalida, pickedKey: '2', chosenBlocks: miHorario }),
      ).toBe('active');
    });

    it('una clave elegida que ya no existe se trata como si no hubiera elección', () => {
      const todosChocan = [section('9', at(3, '14:00', '16:00'))];
      expect(
        classifyConflict({
          itemId: 'x',
          sections: todosChocan,
          pickedKey: 'ya-no-existe',
          chosenBlocks: miHorario,
        }),
      ).toBe('potential');
    });
  });

  describe('sin grupo elegido', () => {
    it('AMARILLO cuando ningún grupo sirve — el caso Turco I del issue', () => {
      // Turco I, los 3 grupos reales de la captura.
      const turcoI = [
        section('1', at(1, '14:00', '16:00'), at(3, '14:00', '16:00')), // MI choca
        section('2', at(2, '14:00', '16:00'), at(4, '14:00', '16:00')), // JU choca
        section('3', at(1, '14:00', '16:00'), at(3, '14:00', '16:00')), // MI choca
      ];
      expect(classifyConflict({ itemId: 'turco', sections: turcoI, chosenBlocks: miHorario })).toBe(
        'potential',
      );
    });

    it('NADA cuando uno de cuatro choca (la regresión de #34)', () => {
      const cuatro = [
        section('1', at(3, '14:00', '16:00')), // choca
        section('2', at(1, '08:00', '10:00')),
        section('3', at(5, '08:00', '10:00')),
        section('4', at(6, '08:00', '10:00')),
      ];
      expect(classifyConflict({ itemId: 'x', sections: cuatro, chosenBlocks: miHorario })).toBe(null);
    });

    it('NADA cuando la materia no tiene grupos ("sin grupos")', () => {
      expect(classifyConflict({ itemId: 'x', sections: [], chosenBlocks: miHorario })).toBe(null);
    });

    it('NADA cuando un grupo no informa horario: ese salva la materia', () => {
      const conSinHorario = [section('1', at(3, '14:00', '16:00')), section('2')];
      expect(classifyConflict({ itemId: 'x', sections: conSinHorario, chosenBlocks: miHorario })).toBe(
        null,
      );
    });

    it('NADA si Mi horario está vacío: no hay contra qué chocar', () => {
      const todosChocarian = [section('1', at(3, '14:00', '16:00'))];
      expect(classifyConflict({ itemId: 'x', sections: todosChocarian, chosenBlocks: [] })).toBe(null);
    });

    it('un choque contra un grupo de la MISMA materia no cuenta', () => {
      const propio = [block('x', '1', at(3, '14:00', '16:00'))];
      expect(
        classifyConflict({ itemId: 'x', sections: [section('2', at(3, '14:00', '16:00'))], chosenBlocks: propio }),
      ).toBe(null);
    });
  });

  describe('con el chip "con cupos" puesto', () => {
    // El único grupo que no choca está lleno.
    const sections = [
      { ...section('1', at(3, '14:00', '16:00')), seats: { available: 20 } }, // choca
      { ...section('2', at(6, '08:00', '10:00')), seats: { available: 0 } }, // libre pero lleno
    ];

    it('AMARILLO: el grupo libre está lleno, no es escapatoria', () => {
      expect(
        classifyConflict({ itemId: 'x', sections, chosenBlocks: miHorario, onlyOpen: true }),
      ).toBe('potential');
    });

    it('NADA con el chip apagado: el grupo lleno sigue contando', () => {
      expect(
        classifyConflict({ itemId: 'x', sections, chosenBlocks: miHorario, onlyOpen: false }),
      ).toBe(null);
    });

    it('un grupo sin cupos MEDIDOS cuenta como servible: no se marca por lo que no se sabe', () => {
      const sinMedir = [
        { ...section('1', at(3, '14:00', '16:00')), seats: { available: 20 } },
        section('2', at(6, '08:00', '10:00')), // seats ausente
      ];
      expect(
        classifyConflict({ itemId: 'x', sections: sinMedir, chosenBlocks: miHorario, onlyOpen: true }),
      ).toBe(null);
    });

    it('NADA si ningún grupo tiene cupo: de eso habla la columna CUPOS, no el horario', () => {
      const todosLlenos = [
        { ...section('1', at(3, '14:00', '16:00')), seats: { available: 0 } },
        { ...section('2', at(6, '08:00', '10:00')), seats: { available: 0 } },
      ];
      expect(
        classifyConflict({ itemId: 'x', sections: todosLlenos, chosenBlocks: miHorario, onlyOpen: true }),
      ).toBe(null);
    });
  });
});
