import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import './CopyCode.css';

/**
 * El código de una materia, copiable con un clic — catálogo, Mi semestre,
 * Mi horario y la ficha (donde aparezca). `role="button"` y no `<button>`:
 * en el catálogo esta celda vive DENTRO de la fila entera, que ya es un
 * `<a>` (AppLink) — anidar un `<button>` real en un `<a>` es HTML inválido.
 * Un `span` con rol de botón es válido ahí y se comporta igual en todos
 * lados, así que es una sola implementación en vez de dos.
 *
 * Icono siempre visible, no un tooltip que hay que descubrir — mismo
 * ícono Copy/Check que ya usa la llave Bre-B (Donate.tsx), reusado.
 */
export function CopyCode({ code, className }: { code: string; className: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(e: React.SyntheticEvent) {
    // Nunca dejar que el clic siga a lo que lo envuelve: en el catálogo eso
    // es navegar a la ficha, exactamente lo que copiar NO debería hacer.
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Sin permiso de portapapeles (Safari en algún contexto, http sin
      // TLS): el código sigue ahí, seleccionable a mano — ver Donate.tsx.
    }
  }

  return (
    <span
      className={`${className} code-copy ${copied ? 'is-copied' : ''}`}
      role="button"
      tabIndex={0}
      onClick={copy}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') copy(e);
      }}
      aria-label={`Copiar código ${code}`}
    >
      {code}
      {copied ? (
        <Check size={11} strokeWidth={2.5} aria-hidden="true" className="code-copy__icon" />
      ) : (
        <Copy size={11} strokeWidth={1.75} aria-hidden="true" className="code-copy__icon" />
      )}
    </span>
  );
}
