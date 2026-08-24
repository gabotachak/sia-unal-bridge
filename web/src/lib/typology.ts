// La tipología del SIA, reducida a lo que hace falta para desempatar entre
// dos planes (PLAN-DOUBLE-TITULATION.md, D6).

/** La letra entre paréntesis: 'FUND. OBLIGATORIA (B)' → 'B'. Es lo estable;
 *  la frase cambia de vocabulario entre vistas del SIA (GOTCHAS.md §17).
 *  Sin paréntesis → los 3 primeros caracteres, para que el tag (Program.tsx,
 *  Course.tsx) siempre tenga algo corto que mostrar. */
export function typologyLetter(raw: string): string {
  return raw.match(/\(([^)]+)\)/)?.[1] ?? raw.slice(0, 3);
}

/** El color del tag: 'FUND. OBLIGATORIA (B)' → 'obligatoria'. */
export function typologySlug(t: string): string {
  if (t.startsWith('LIBRE')) return 'libre';
  if (t.includes('OBLIGATORIA')) return 'obligatoria';
  if (t.includes('OPTATIVA')) return 'optativa';
  return 'otra';
}

/** Rango de exigencia (D6): a mayor rango, más urgente inscribirla. La
 *  NIVELACIÓN por encima de las obligatorias es deliberado —bloquea el
 *  avance del plan— y no un descuido de orden. */
const RANK: Record<string, number> = {
  P: 4, // TRABAJO DE GRADO
  E: 3, // NIVELACIÓN
  B: 2, // FUND. OBLIGATORIA
  C: 2, // DISCIPLINAR OBLIGATORIA
  O: 1, // FUND. OPTATIVA
  T: 1, // DISCIPLINAR OPTATIVA
};

/** P=4, E=3, B|C=2, O|T=1, todo lo demás —incluida LIBRE ELECCIÓN (L) y
 *  cualquier letra que el SIA no haya usado todavía— 0. */
export function typologyRank(raw: string): number {
  return RANK[typologyLetter(raw)] ?? 0;
}
