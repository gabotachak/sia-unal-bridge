import { Banner } from './Banner';
import { TabBar } from './TabBar';
import { Topbar } from './Topbar';
import './Layout.css';

/**
 * El marco de todas las pantallas: la barra, el contenido, el colofón.
 *
 * Ya no recibe migas de pan. Con un plan elegido, el camino "nivel / sede /
 * plan" no era navegación sino decoración: cada escalón rebotaba de vuelta
 * acá. El plan se elige una vez, en /plan, y desde entonces la barra lo
 * muestra como estado — que es lo que siempre fue.
 *
 * Dos barras y no una, pero nunca las dos a la vez: `Topbar` lleva la
 * navegación en escritorio y `TabBar` la lleva en el teléfono, fija abajo
 * (ver STACK_BREAKPOINT_PX en lib/breakpoints.ts). Cada una esconde por CSS
 * lo que le toca a la otra, así que en pantalla siempre hay exactamente un
 * juego de destinos.
 */
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      {/* Antes que la barra, que es lo que lo pone en la primerísima línea de
          la página. Se pinta o no según VITE_INCIDENT_BANNER_OFF — la decisión
          vive dentro de Banner.tsx, no acá, para que apagarlo no sea editar el
          marco de todas las pantallas. */}
      <Banner />

      <Topbar />

      <main className="content">{children}</main>

      <footer className="colophon">
        <p>
          Datos del catálogo público del <strong>SIA</strong>, Universidad Nacional de
          Colombia. Proyecto <em>no oficial</em>: un puente de lectura, no un sistema de
          inscripción.
        </p>
        <p className="colophon__credit">
          Creado con <span aria-hidden="true">&lt;3</span>
          <span className="sr-only">amor</span> por{' '}
          <a href="https://gabotachak.dev" target="_blank" rel="noopener noreferrer">
            gabotachak
          </a>{' '}
          · {import.meta.env.VITE_APP_VERSION || 'dev'}
        </p>
      </footer>

      {/* Después del colofón en el DOM, no antes: es lo último de la página
          en orden de lectura y de tabulación, aunque esté fija abajo. Que
          `position: fixed` la saque del flujo no cambia por dónde entra el
          teclado. */}
      <TabBar />
    </div>
  );
}
