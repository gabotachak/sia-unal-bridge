import { describe, expect, it } from 'vitest';
import { abbreviateEngineering } from './format';

describe('abbreviateEngineering', () => {
  it('mayúscula, con y sin tilde → ING.', () => {
    expect(abbreviateEngineering('INGENIERÍA DE SISTEMAS')).toBe('ING. DE SISTEMAS');
    expect(abbreviateEngineering('INGENIERIA DE SISTEMAS')).toBe('ING. DE SISTEMAS');
  });

  it('primera letra alta → Ing.', () => {
    expect(abbreviateEngineering('Ingeniería de sistemas')).toBe('Ing. de sistemas');
    expect(abbreviateEngineering('Ingenieria de sistemas')).toBe('Ing. de sistemas');
  });

  it('minúscula → ing.', () => {
    expect(abbreviateEngineering('especialización en ingeniería de software')).toBe(
      'especialización en ing. de software',
    );
  });

  it('no toca otras palabras que contienen el fragmento', () => {
    expect(abbreviateEngineering('Bioingeniería aplicada')).toBe('Bioingeniería aplicada');
  });
});
