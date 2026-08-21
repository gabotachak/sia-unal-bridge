import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// El proxy es lo que hace que CORS no exista.
//
// El navegador bloquea que una página servida desde localhost:5173 lea una
// respuesta de localhost:8080 — origen distinto, puerto distinto. En vez de
// abrir CORS en la API, el front pide siempre a rutas relativas (`/v1/...`) y
// Vite las reenvía al back. Para el navegador todo salió del mismo origen, así
// que no hay nada que bloquear.
//
// En compose el mismo papel lo hace nginx (ver web/nginx.conf). La API nunca
// se entera de ninguno de los dos.
export default defineConfig(({ mode }) => {
  // Prefijo '' lee TODAS las variables del .env de la raíz, no sólo las VITE_*,
  // porque FETCH_COOLDOWN es una sola variable compartida con el backend y
  // duplicarla como VITE_FETCH_COOLDOWN sería tener dos fuentes de verdad para
  // el mismo número.
  //
  // Esto NO expone el .env al cliente: lo que llega al bundle lo decide
  // `envPrefix` (sigue en VITE_ por defecto) más el `define` explícito de aquí
  // abajo. POSTGRES_PASSWORD y compañía se quedan en el proceso de build.
  const env = loadEnv(mode, resolve(dirname(fileURLToPath(import.meta.url)), '..'), '');

  // process.env es el caso Docker: el build corre con contexto ./web, donde el
  // .env de la raíz no existe, así que compose lo inyecta como build arg.
  const cooldown = env.FETCH_COOLDOWN || process.env.FETCH_COOLDOWN || '300';

  // El `define` de abajo solo actúa en el build: en dev, Vite sirve
  // `import.meta.env` como un objeto de verdad y la propiedad se resuelve en
  // tiempo de ejecución contra él, no contra el reemplazo textual. Ese objeto
  // solo lleva las variables con prefijo VITE_, así que sin esta línea el
  // servidor de desarrollo ignoraba el .env y se quedaba con el valor por
  // defecto horneado en client.ts — el front y el backend podían discrepar sin
  // que nada lo dijera. Vite recoge las VITE_* de process.env al arrancar.
  process.env.VITE_FETCH_COOLDOWN = cooldown;

  // El banner de incidencia (components/Banner.tsx) al revés que un feature
  // flag normal: se apaga poniendo la variable, no encendiéndola. Ausente =
  // banner visible. Es a propósito — el estado por defecto de un aviso de "los
  // datos pueden estar viejos" tiene que ser CONTARLO; olvidar una variable no
  // puede ser lo que silencie el aviso mientras el problema sigue ahí.
  //
  // Presencia, no valor: `=false` también lo apaga (ver .env.example). Vacío
  // cuenta como ausente, que es lo que hace `|| ''` de abajo cuando la variable
  // existe pero no dice nada.
  const bannerOff =
    env.VITE_INCIDENT_BANNER_OFF || process.env.VITE_INCIDENT_BANNER_OFF || '';
  process.env.VITE_INCIDENT_BANNER_OFF = bannerOff;

  const apiTarget = env.VITE_API_TARGET || 'http://localhost:18080';
  const devPort = Number(env.VITE_DEV_PORT) || 5173;

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_FETCH_COOLDOWN': JSON.stringify(cooldown),
      'import.meta.env.VITE_INCIDENT_BANNER_OFF': JSON.stringify(bannerOff),
    },
    server: {
      port: devPort,
      proxy: {
        '/v1': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});

