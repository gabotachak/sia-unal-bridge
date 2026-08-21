// Los detalles que esta sesión ya trajo, para no volver a pedirlos.
//
// El catálogo llega con `seats` pero SIN horarios (`CourseSummary` no tiene
// `sections`), así que para saber si una materia choca hay que pedir su
// detalle, uno por materia. Sin memoria, cada ida y vuelta entre Catálogo,
// Mi semestre y Mi horario tiraba a la basura todo lo traído y volvía a
// empezar: mirar Turco I y volver al catálogo dejaba el catálogo igual de
// ciego que antes de mirarla.
//
// Vive fuera de React —un módulo, no un provider— porque el dato no es de
// ninguna pantalla: lo trae la que lo necesite y lo aprovechan todas. Se
// lee con `useDetailCache()`, que usa `useSyncExternalStore` (de React, sin
// dependencias nuevas) para repintar cuando entra algo.
//
// En memoria y nada más: NO va a localStorage. Los cupos envejecen y un
// detalle guardado entre recargas volvería a pintar números viejos como si
// fueran de ahora, que es justo lo que la columna CUPOS promete no hacer.
// Al recargar se empieza de cero, que es correcto y además gratis.

import { useSyncExternalStore } from 'react';
import type { CourseDetail, Section } from '../api/types';

/** Se reemplaza entero en cada escritura: `useSyncExternalStore` compara la
 *  referencia, así que mutar en el sitio no repintaría nada. Son unas cientas
 *  de entradas como mucho — copiar el Map no se nota. */
let cache: ReadonlyMap<string, CourseDetail> = new Map();

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Guarda —o pisa— el detalle de una materia. Idempotente: si es el MISMO
 *  objeto que ya está guardado no repinta, que es lo que evita el bucle
 *  cuando quien escribe es un efecto que depende de la cache. */
export function putDetail(id: string, detail: CourseDetail): void {
  if (cache.get(id) === detail) return;
  cache = new Map(cache).set(id, detail);
  emit();
}

/** Varios de una, con un solo repintado. */
export function putDetails(entries: readonly (readonly [string, CourseDetail])[]): void {
  const fresh = entries.filter(([id, d]) => cache.get(id) !== d);
  if (fresh.length === 0) return;
  const next = new Map(cache);
  for (const [id, d] of fresh) next.set(id, d);
  cache = next;
  emit();
}

export function getDetail(id: string): CourseDetail | undefined {
  return cache.get(id);
}

export function hasDetail(id: string): boolean {
  return cache.has(id);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function snapshot(): ReadonlyMap<string, CourseDetail> {
  return cache;
}

/**
 * Los detalles conocidos, repintando cuando entra alguno.
 *
 * Al montar devuelve lo que la sesión ya sabe —por eso volver al catálogo
 * marca los choques al instante y sin pedirle nada al back— y después se
 * actualiza sola a medida que llegan los que falten.
 */
export function useDetailCache(): ReadonlyMap<string, CourseDetail> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Los grupos de una materia, o `undefined` si esta sesión no los conoce
 *  todavía — la distinción que `classifyConflict` necesita para no marcar
 *  por lo que no sabe. */
export function sectionsOf(
  details: ReadonlyMap<string, CourseDetail>,
  id: string,
): Section[] | undefined {
  return details.get(id)?.sections;
}

/** Solo para los tests: deja la cache como recién arrancada. */
export function resetDetailCache(): void {
  cache = new Map();
  listeners.clear();
}
