import { Link, useNavigate } from 'react-router';
import type { Freshness as F } from '../api/client';
import { CHANGING_QS } from '../hooks/useChangingPlan';
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
  const navigate = useNavigate();
  const sel = plan.selection;

  // Cambiar de plan es volver al directorio de la sede. Acá no se borra nada:
  // el semestre se reinicia recién cuando se elige OTRO plan, que es la
  // decisión de verdad. Salir a mirar y volverse no debería costar la lista.
  //
  // El `?cambiar=1` es lo que le da permiso a esa pantalla de mostrarse: con
  // plan elegido, llegar ahí sin la marca rebota al catálogo. Este botón es la
  // única puerta, que es exactamente lo que se quería.
  const changePlan = () => {
    if (!sel) return;
    navigate(`/nivel/${sel.level}/sede/${sel.campus}${CHANGING_QS}`);
  };

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

          <div className="masthead__end">
            {sel && (
              <button
                className="planchip"
                onClick={changePlan}
                title={`${sel.programName} · ${sel.campusName}${sel.facultyName ? ` · ${sel.facultyName}` : ''}`}
              >
                <span className="planchip__name">{sel.programName}</span>
                <span className="planchip__swap" aria-hidden="true">
                  cambiar
                </span>
                <span className="sr-only">Cambiar de plan</span>
              </button>
            )}
            <Freshness value={freshness ?? null} />
          </div>
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
