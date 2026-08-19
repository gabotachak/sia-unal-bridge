import { useNav } from './state/nav';
import { NavProvider } from './state/NavProvider';
import { PlanProvider } from './state/PlanProvider';
import { PlanPicker } from './views/PlanPicker';
import { Program } from './views/Program';
import { Course } from './views/Course';
import { Semester } from './views/Semester';

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
  }
}

export function App() {
  return (
    <PlanProvider>
      {/* NavProvider adentro de PlanProvider a propósito: la pantalla inicial
          depende del plan ya elegido, así que necesita leerlo. */}
      <NavProvider>
        <Screens />
      </NavProvider>
    </PlanProvider>
  );
}
