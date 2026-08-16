import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { usePlan } from './hooks/usePlan';
import { selectionPath } from './lib/storage';
import { PlanProvider } from './state/PlanProvider';
import { Campuses } from './views/Campuses';
import { Campus } from './views/Campus';
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
 * porque el código de un plan no identifica sin ella.
 *
 * PlanProvider envuelve todo porque la lista del semestre se toca desde varias
 * pantallas: se agrega en el catálogo y en la ficha, se cuenta en el raíl, y
 * se lee en /semestre.
 */
/**
 * La raíz.
 *
 * Con un plan ya elegido, el tablero ES el catálogo de ese plan: volver a la
 * marca no vuelve a preguntar nivel ni sede. Sin plan, la única pantalla que
 * tiene sentido es la de elegirlo.
 *
 * `replace` en las dos: la redirección no debe quedar en el historial, o el
 * botón de atrás rebotaría contra ella para siempre.
 */
function Home() {
  const { selection } = usePlan();
  return <Navigate to={selection ? selectionPath(selection) : '/nivel/pregrado'} replace />;
}

export function App() {
  return (
    <PlanProvider>
      <BrowserRouter>
        <Routes>
          {/* La cascada del SIA empieza por el nivel, así que la URL también.
              Sin nivel no hay default silencioso: se redirige, y queda escrito
              en la barra de direcciones cuál se está mirando. */}
          <Route path="/" element={<Home />} />
          <Route path="/nivel/:level" element={<Campuses />} />
          <Route path="/nivel/:level/sede/:campus" element={<Campus />} />
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
