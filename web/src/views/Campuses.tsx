import { Link, Navigate, useParams } from 'react-router';
import { routes } from '../api/client';
import type { CampusesResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { CHANGING_QS, useChangingPlan } from '../hooks/useChangingPlan';
import { usePlan } from '../hooks/usePlan';
import { Layout } from '../components/Layout';
import { LevelPicker } from '../components/LevelPicker';
import { Fault, Loading } from '../components/States';
import { selectionPath } from '../lib/storage';
import './Campuses.css';

/**
 * La entrada: nivel y sede, los dos primeros escalones de la cascada del SIA.
 *
 * Van juntos en una sola pantalla porque el nivel son tres opciones —una
 * página entera para eso sería un clic de peaje— pero sí condiciona la lista
 * de sedes: el back cachea las sedes POR NIVEL, así que cambiar de nivel
 * vuelve a pedirlas.
 */
export function Campuses() {
  const { level = 'pregrado' } = useParams();
  const { selection } = usePlan();
  const changing = useChangingPlan();

  // Con plan elegido esta pantalla solo se muestra si se vino a cambiarlo.
  // Llegar de rebote —un enlace viejo, el botón de atrás, /nivel/pregrado
  // tecleado— devuelve al catálogo, que es el tablero de verdad.
  const bounce = !!selection && !changing;

  // `null` cuando se va a rebotar: pedir las sedes para desmontar acto seguido
  // sería mandar al SIA una cascada que nadie va a mirar.
  const { data, error, loading, freshness, elapsed, reload } = useApi<CampusesResponse>(
    bounce ? null : routes.campuses(level),
  );

  if (bounce && selection) return <Navigate to={selectionPath(selection)} replace />;

  return (
    <Layout crumbs={[{ label: level }, { label: 'sedes' }]} freshness={freshness}>
      <header className="intro">
        <p className="eyebrow rise">catálogo de asignaturas · sia unal</p>
        <h1 className="intro__title rise" style={{ animationDelay: '60ms' }}>
          ¿Dónde<br />
          <em>estudiás?</em>
        </h1>
        <p className="intro__lead rise" style={{ animationDelay: '140ms' }}>
          Elegí nivel y sede. Todo lo demás cuelga de ahí: el mismo código de plan existe
          en varias sedes, así que preguntar sin decir dónde no significa nada.
        </p>
      </header>

      {/* Se está cambiando de plan: hay algo que perder, así que la salida
          tiene que estar a la vista y el precio dicho antes de pagarlo. */}
      {selection && (
        <p className="intro__mine rise" style={{ animationDelay: '160ms' }}>
          Tu plan es <b>{selection.programName}</b>.{' '}
          <Link to={selectionPath(selection)}>Volver a su catálogo</Link> — o elegí abajo
          para cambiarlo, que reinicia el semestre.
        </p>
      )}

      <LevelPicker current={level} qs={changing ? CHANGING_QS : ''} />

      {loading && !data && <Loading elapsed={elapsed} what="Trayendo las sedes" />}
      {error && <Fault error={error} onRetry={() => reload()} />}

      {data && (
        <ol className="board">
          {data.campuses.map((c, i) => (
            <li
              key={c.code}
              className="board__row rise"
              style={{ animationDelay: `${180 + i * 45}ms` }}
            >
              {/* El modo cambiar viaja con el enlace: sin esto, elegir sede
                  rebotaría de vuelta al catálogo del plan viejo. */}
              <Link to={`/nivel/${level}/sede/${c.code}${changing ? CHANGING_QS : ''}`}>
                <span className="board__code">{c.code}</span>
                <span className="board__name">{c.name.replace(/^SEDE\s+/, '')}</span>
                <span className="board__go" aria-hidden="true">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Layout>
  );
}
