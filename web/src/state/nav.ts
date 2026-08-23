import { createContext, useContext } from 'react';
import type { Selection } from '../lib/storage';

/**
 * Las pantallas de la app.
 *
 * No hay URL detrás de esto — la barra de direcciones se queda fija en "/"
 * (ver NavProvider) — así que cada pantalla lleva en el objeto mismo todo lo
 * que antes se leía con useParams()/useSearchParams().
 *
 * Las dos que cuelgan de un plan llevan la Selection completa, con nombres,
 * y no solo los códigos — por dos razones distintas:
 *
 *  - 'program' puede "adoptar" el plan que muestra (el aviso de plan ajeno en
 *    Program.tsx), y adoptar es `plan.select(selection)`, que necesita los
 *    nombres para no dejar el chip de la barra diciendo el código a secas.
 *  - 'course' los lleva para poder volver al catálogo de ESE plan con sus
 *    nombres ya puestos, sin ir a buscarlos nunca.
 *
 * Cuando se llega desde Mi semestre u Horario (`from: 'semester' |
 * 'schedule'`) no hay nombres a mano —PlanItem solo guarda códigos— y no hace
 * falta: la flecha de volver apunta a esa pantalla, no a 'program', así que
 * esos nombres de relleno nunca se leen. Ver CourseCard.tsx, que es quien
 * arma esa Selection para las dos.
 */
export type Screen =
  | { name: 'plan-picker' }
  | { name: 'program'; selection: Selection }
  | {
      name: 'course';
      selection: Selection;
      code: string;
      from?: 'semester' | 'schedule';
      /**
       * Cómo figura esta asignatura en el OTRO plan, con doble titulación
       * (D6, PLAN-DOUBLE-TITULATION.md). Solo se sabe si se llegó desde el
       * catálogo unido (`MergedCourse.alsoIn`, Program.tsx): desde Mi
       * semestre u Horario no hay de dónde sacarlo —`PlanItem` no lo
       * guarda— y pedir el otro catálogo solo para esto sería una petición
       * de ~350 KB por una frase.
       */
      alsoIn?: { plan: Selection; typology: string };
    }
  | { name: 'semester' }
  | { name: 'schedule' }
  | { name: 'donate' };

export type NavApi = {
  screen: Screen;
  /** Cambia de pantalla. `replace` no deja rastro en el historial — para
   *  redirecciones, no para navegación de verdad. */
  navigate: (next: Screen, opts?: { replace?: boolean }) => void;
};

export const NavContext = createContext<NavApi | null>(null);

export function useNav(): NavApi {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav debe usarse dentro de <NavProvider>');
  return ctx;
}
