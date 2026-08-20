import { useNav } from './state/nav';
import { CatalogFiltersProvider } from './state/CatalogFiltersProvider';
import { NavProvider } from './state/NavProvider';
import { PlanProvider } from './state/PlanProvider';
import { PlanViewProvider } from './state/PlanViewProvider';
import { ScheduleProvider } from './state/ScheduleProvider';
import { PlanPicker } from './views/PlanPicker';
import { Program } from './views/Program';
import { Course } from './views/Course';
import { Semester } from './views/Semester';
import { Schedule } from './views/Schedule';
import { Donate } from './views/Donate';

/**
 * El árbol de pantallas.
 *
 * No hay rutas: la pantalla activa es un valor de estado —`useNav().screen`—
 * y no un segmento de la URL. Ver `state/nav.ts` y `state/NavProvider.tsx`
 * para el porqué: con un plan elegido en el navegador, no hay nada público
 * que una URL pudiera identificar o que valiera la pena pegar en un chat.
 */
function Screens() {
  const { screen } = useNav();
  switch (screen.name) {
    case 'plan-picker':
      return <PlanPicker />;
    case 'program':
      return <Program screen={screen} />;
    case 'course':
      return <Course screen={screen} />;
    case 'semester':
      return <Semester />;
    case 'schedule':
      return <Schedule />;
    case 'donate':
      return <Donate />;
  }
}

export function App() {
  return (
    <PlanProvider>
      {/* ScheduleProvider adentro de PlanProvider: poda su selección leyendo
          `plan.items`, así que necesita que ya exista. NavProvider adentro de
          los dos por la misma razón que antes — la pantalla inicial depende
          del plan ya elegido. */}
      <ScheduleProvider>
        {/* PlanViewProvider guarda cómo se está MIRANDO esa lista —filtro de
            cupos y orden de la tabla—, que Mi semestre y Mi horario comparten
            desde que las dos pintan la misma tabla. No depende de los otros
            dos, pero va con ellos: los tres son el estado del plan. */}
        <PlanViewProvider>
          {/* CatalogFiltersProvider no depende de nada de los otros dos —
              entra donde sea, va acá por quedar junto a su hermano de
              propósito similar. */}
          <CatalogFiltersProvider>
            <NavProvider>
              <Screens />
            </NavProvider>
          </CatalogFiltersProvider>
        </PlanViewProvider>
      </ScheduleProvider>
    </PlanProvider>
  );
}
