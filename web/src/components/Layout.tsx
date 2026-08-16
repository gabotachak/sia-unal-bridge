import type { Freshness as F } from '../api/client';
import { Topbar } from './Topbar';
import './Layout.css';

/**
 * El marco de todas las pantallas: la barra, el contenido, el colofón.
 *
 * Ya no recibe migas de pan. Con un plan elegido, el camino "nivel / sede /
 * plan" no era navegación sino decoración: cada escalón rebotaba de vuelta
 * acá. El plan se elige una vez, en /plan, y desde entonces la barra lo
 * muestra como estado — que es lo que siempre fue.
 */
export function Layout({
  freshness,
  children,
}: {
  freshness?: F | null;
  children: React.ReactNode;
}) {
  return (
    <div className="shell">
      <Topbar freshness={freshness} />

      <main className="content">{children}</main>

      <footer className="colophon">
        <p>
          Datos del catálogo público del <strong>SIA</strong>, Universidad Nacional de
          Colombia. Proyecto <em>no oficial</em>: un puente de lectura, no un sistema de
          inscripción.
        </p>
      </footer>
    </div>
  );
}
