import './Banner.css';

/**
 * ¿Hay que pintar el aviso?
 *
 * Al revés que un feature flag normal: **ausente = visible**. Poner
 * `VITE_INCIDENT_BANNER_OFF` en el `.env` de la raíz es lo que lo apaga.
 *
 * La polaridad es a propósito. Un aviso de "los datos que estás viendo pueden
 * estar viejos" tiene que ser lo que pasa por defecto: si el flag fuera al
 * derecho, olvidar una variable dejaría el sitio mintiendo en silencio. Con
 * este sentido, olvidarla solo deja un aviso de más.
 *
 * Presencia, no valor — `=false` también lo apaga; el vacío se normaliza a
 * ausente en `vite.config.ts`. Ver `.env.example`, sección 3.
 *
 * Se resuelve en el BUILD, no en tiempo de ejecución: `import.meta.env` es un
 * reemplazo textual de Vite, y esto es un sitio estático que sirve nginx. Para
 * prender o apagar el banner hay que recompilar el front —
 * `docker compose build web && docker compose up -d --no-deps web`.
 */
const SHOW = !import.meta.env.VITE_INCIDENT_BANNER_OFF;

/**
 * El aviso rojo de arriba de todo.
 *
 * Temporal por definición: existe mientras la actualización de datos esté
 * fallando. Por eso no tiene props ni botón de cerrar — mientras el dato de
 * abajo pueda estar viejo, el aviso no debería poder esconderse desde el
 * navegador. Quien lo silencia es quien opera el despliegue, con la variable.
 *
 * `role="status"`: es información sobre el estado de la app, no una alerta que
 * interrumpa lo que el lector esté haciendo.
 */
export function Banner() {
  if (!SHOW) return null;

  return (
    <div className="banner" role="status">
      <p>
        Estamos experimentando problemas temporales actualizando la información, trabajamos
        para solucionarlos.
      </p>
    </div>
  );
}
