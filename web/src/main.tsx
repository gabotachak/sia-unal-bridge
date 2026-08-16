// Punto de entrada. Lo único que hace: enganchar React al <div id="root">
// de index.html. De acá para abajo todo es React.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/base.css';

createRoot(document.getElementById('root')!).render(
  // StrictMode solo actúa en desarrollo: monta cada componente dos veces para
  // delatar efectos mal escritos. Si algo se pide dos veces en dev y una sola
  // en producción, es esto — y es a propósito.
  <StrictMode>
    <App />
  </StrictMode>,
);
