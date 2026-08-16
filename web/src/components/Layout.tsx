import { Link } from 'react-router';
import type { Freshness as F } from '../api/client';
import { usePlan } from '../hooks/usePlan';
import { Freshness } from './Freshness';
import './Layout.css';

export type Crumb = { label: string; to?: string };

/**
 * El marco de todas las pantallas: raíl con la marca, migas de pan, y la
 * insignia de frescura de lo que se esté mostrando.
 */
export function Layout({
  crumbs,
  freshness,
  children,
}: {
  crumbs: Crumb[];
  freshness?: F | null;
  children: React.ReactNode;
}) {
  const plan = usePlan();

  return (
    <div className="shell">
      <aside className="rail">
        <Link className="rail__mark" to="/">
          <span className="rail__glyph" aria-hidden="true">
            ▚
          </span>
          <span className="rail__name">TABLERO</span>
        </Link>

        {/* El acceso a /semestre, con cuántas materias lleva. Visible desde
            cualquier pantalla: sin esto, el botón de agregar no lleva a
            ningún lado y la lista es invisible. */}
        <Link
          className={`rail__plan ${plan.items.length ? 'has-items' : ''}`}
          to="/semestre"
          title={`Mi semestre · ${plan.items.length} ${plan.items.length === 1 ? 'materia' : 'materias'}`}
        >
          <span className="rail__count">{plan.items.length}</span>
          <span className="rail__planName">SEMESTRE</span>
        </Link>
      </aside>

      <div className="shell__body">
        <header className="masthead">
          <nav className="crumbs" aria-label="Ruta">
            {crumbs.map((c, i) => (
              <span key={i} className="crumbs__item">
                {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
                {i < crumbs.length - 1 && (
                  <i className="crumbs__sep" aria-hidden="true">
                    /
                  </i>
                )}
              </span>
            ))}
          </nav>
          <Freshness value={freshness ?? null} />
        </header>

        <main className="content">{children}</main>

        <footer className="colophon">
          <p>
            Datos del catálogo público del <strong>SIA</strong>, Universidad Nacional de
            Colombia. Proyecto <em>no oficial</em>: un puente de lectura, no un sistema de
            inscripción.
          </p>
        </footer>
      </div>
    </div>
  );
}
