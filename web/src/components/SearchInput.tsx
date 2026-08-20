import { Search, X } from 'lucide-react';
import { Tooltip } from './Tooltip';

/**
 * El buscador de PlanPicker y del catálogo: mismo `.search` (PlanPicker.css,
 * global como toda hoja de vista), misma cruz para borrar. El `type=search`
 * nativo trae una cruz de fábrica, pero es "de otro sistema de diseño" —ver
 * el comentario en PlanPicker.css que la apaga— así que esta es la propia,
 * visible solo cuando hay algo que borrar.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** Texto para quien usa lector de pantalla — el input no lleva rótulo visible. */
  label: string;
  className?: string;
}) {
  return (
    <label className={`search ${className}`}>
      <Search size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <Tooltip content={<p className="tt-title">Borrar búsqueda</p>}>
          <button
            type="button"
            className="search__clear"
            onClick={() => onChange('')}
            aria-label="Borrar búsqueda"
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </label>
  );
}
