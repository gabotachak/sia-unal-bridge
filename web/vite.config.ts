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
  // Lee variables VITE_* del .env de la raíz del monorepo (un nivel arriba).
  const env = loadEnv(mode, resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'VITE_');

  const apiTarget = env.VITE_API_TARGET || 'http://localhost:8080';
  const devPort = Number(env.VITE_DEV_PORT) || 5173;

  return {
    plugins: [react()],
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

