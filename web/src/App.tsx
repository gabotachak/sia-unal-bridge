import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { usePlan } from './hooks/usePlan';
import { selectionPath } from './lib/storage';
import { PlanProvider } from './state/PlanProvider';
import { PlanPicker } from './views/PlanPicker';
import { Program } from './views/Program';
import { Course } from './views/Course';
import { Semester } from './views/Semester';

/**
 * El mapa de rutas.
 *
 * La URL es estado, no decoración: cualquiera de estas se puede pegar en un
 * chat y abre exactamente donde estabas. Los `:nombre` son huecos que la vista
 * lee con useParams().
 *
 * La forma imita a la de la API a propósito — la sede primero, siempre —
 * porque el código de un plan no identifica sin ella. Por eso las rutas de
 * catálogo y asignatura siguen cargando nivel/sede/plan aunque la interfaz ya
 * no haga navegar por ellos: son lo que hace que un enlace pegado signifique
 * lo mismo para quien lo recibe.
 *
 * Lo que SÍ desapareció son las rutas intermedias (/nivel/x, /nivel/x/sede/y).
 * Existían para recorrer la cascada del SIA a pie, y eso ahora se hace una
 * sola vez en /plan.
 *
 * PlanProvider envuelve todo porque la lista del semestre se toca desde varias
 * pantallas: se agrega en el catálogo y en la ficha, se cuenta en la barra, y
 * se lee en /semestre.
 */

/**
 * La raíz.
 *
 * Con un plan ya elegido, el tablero ES el catálogo de ese plan. Sin plan, la
 * única pantalla que tiene sentido es la de elegirlo.
 *
 * `replace` en las dos: la redirección no debe quedar en el historial, o el
 * botón de atrás rebotaría contra ella para siempre.
 */
function Home() {
  const { selection } = usePlan();
  return <Navigate to={selection ? selectionPath(selection) : '/plan'} replace />;
}

export function App() {
  return (
    <PlanProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />

          {/* El único sitio donde se elige plan. Se llega a propósito, desde
              el chip de la barra, y al terminar devuelve al catálogo. */}
          <Route path="/plan" element={<PlanPicker />} />

          <Route path="/nivel/:level/sede/:campus/plan/:program" element={<Program />} />
          <Route
            path="/nivel/:level/sede/:campus/plan/:program/asignatura/:code"
            element={<Course />}
          />

          <Route path="/semestre" element={<Semester />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </BrowserRouter>
    </PlanProvider>
  );
}
