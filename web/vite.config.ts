import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
