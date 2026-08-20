import { useState } from 'react';
import { Clock, Trash2, TriangleAlert, User } from 'lucide-react';
import type { Row } from '../hooks/useCourseDetails';
import { formatAge, formatScheduleSummary, titleCase } from '../lib/format';
import { itemId } from '../lib/storage';
import { AppLink } from './AppLink';
import { IconButton } from './IconButton';
import { SeatsFigure } from './Seats';
import './CourseCard.css';

/**
 * Una materia con sus grupos. Mi semestre y Mi horario pintan la MISMA
 * tarjeta: mismos datos, mismas columnas, mismo radio de grupo elegido
 * conectado a la misma selección (`useScheduleSelection`, Context), misma
 * caneca para quitarla de la lista.
 *
 * Hubo una prop `compact` —una versión reducida a nombre, profe y horario—
 * para el panel de Mi horario. Se fue: dos dibujos distintos de la misma
 * cosa hacían que el panel se leyera como un recorte deliberado, y lo que
 * lo obligaba era el ancho del panel, que ahora la tabla resuelve sola
 * (`container: table` en styles/table.css).
 */
export function CourseCard({
  row,
  onlyOpen,
  onRemove,
  selection,
  linkFrom,
}: {
  row: Row;
  onlyOpen: boolean;
  onRemove?: () => void;
  selection: {
    pickedKey: string | null;
    onPick: (key: string | null) => void;
    /** section.key de esta materia que choca con otra ya elegida. */
    conflictKeys: Set<string>;
  };
  /** A qué pantalla vuelve la ficha de la materia al tocar el nombre. */
  linkFrom: 'semester' | 'schedule';
}) {
  const { item, detail, status, error } = row;
  const all = detail?.sections ?? [];
  const sections = all.filter((s) => !onlyOpen || (s.seats?.available ?? 0) > 0);
  const totalSeats = all.reduce((n, s) => n + (s.seats?.available ?? 0), 0);
  const noGroups = status === 'done' && detail && all.length === 0;
  const groupName = itemId(item);

  /**
   * Una materia de PEAMA puede traer 20+ grupos. Sin tope, cada tarjeta de
   * "Mi semestre" —una lista de hasta diez materias— se convertía en su
   * propia lista larga, y encontrar la tarjeta siguiente era desplazar a
   * ciegas. Se ven los primeros 5 y el resto queda detrás de "ver más".
   *
   * El corte solo entra por encima de COLLAPSE_THRESHOLD, no de
   * VISIBLE_SECTIONS: con 6 grupos, cortar en 5 dejaría "ver el 1 restante"
   * ocupando una fila entera por un solo grupo — peor que no cortar.
   */
  const VISIBLE_SECTIONS = 5;
  const COLLAPSE_THRESHOLD = 6;
  const [expanded, setExpanded] = useState(false);
  const collapsible = sections.length > COLLAPSE_THRESHOLD;
  const visibleSections = expanded || !collapsible ? sections : sections.slice(0, VISIBLE_SECTIONS);
  const hiddenCount = sections.length - visibleSections.length;

  // La edad más antigua entre los grupos: el dato que limita.
  const oldestAge = all.reduce<number | null>(
    (max, s) =>
      s.seats ? (max === null ? s.seats.age_seconds : Math.max(max, s.seats.age_seconds)) : max,
    null,
  );

  // Para "sin grupos": edad desde la última consulta al SIA.
  const noGroupsAge =
    noGroups && detail?.fetched_at ? (Date.now() - Date.parse(detail.fetched_at)) / 1000 : null;

  const nameLink = (
    // `from` es lo que le dice a la ficha adónde apunta la flecha de
    // volver — ver el comentario del `back` en Course.tsx. Los nombres de
    // la Selection son de relleno —esta lista solo guarda códigos— y no
    // hace falta que sean reales: la ficha nunca los lee cuando `from`
    // está puesto.
    <AppLink
      className="card__name"
      // El nombre se recorta con puntos suspensivos casi siempre: los del
      // SIA son largos y la columna cede ancho antes que nadie. El `title`
      // es la única forma de leer el resto sin abrir la ficha.
      title={item.name}
      to={{
        name: 'course',
        selection: {
          level: item.level,
          campus: item.campus,
          campusName: item.campus,
          faculty: item.faculty,
          facultyName: '',
          program: item.program,
          programName: item.program,
        },
        code: item.code,
        from: linkFrom,
      }}
    >
      {item.name}
    </AppLink>
  );

  const seatsTally = (
    <div
      className="card__tally col-seats"
      aria-label={
        status === 'done' && detail
          ? noGroups
            ? 'Sin grupos programados'
            : `${totalSeats} cupos disponibles`
          : undefined
      }
    >
      {status === 'done' && detail && (
        <>
          <SeatsFigure
            available={noGroups ? null : totalSeats}
            tone={totalSeats === 0 ? 'empty' : 'ok'}
            animate
            announce={false}
          />
          <span className="card__tallyLabel tnum" aria-hidden="true">
            {noGroups ? (
              <>
                sin grupos
                <span className="card__age">
                  {' · '}
                  {noGroupsAge !== null ? formatAge(noGroupsAge) : '—'}
                </span>
              </>
            ) : oldestAge !== null ? (
              formatAge(oldestAge)
            ) : (
              '—'
            )}
          </span>
        </>
      )}
      {status === 'loading' && <span className="card__tallyLabel">midiendo…</span>}
    </div>
  );

  return (
    <li className={`card ${status === 'loading' ? 'is-loading' : ''}`}>
      <header className="card__head table__row">
        <span className="card__code tnum col-code">{item.code}</span>
        {nameLink}
        <span className={`tag tag--${slugTypology(item.typology)} col-typ`} title={item.typology}>
          {shortTypology(item.typology)}
        </span>
        <span className="card__credits tnum col-cr" aria-label={`${item.credits} créditos`}>
          {item.credits}
        </span>
        {seatsTally}
        {onRemove && (
          <IconButton
            onClick={onRemove}
            label="Quitar del semestre"
            tip="left"
            className="iconbtn--row iconbtn--danger"
          >
            <Trash2 size={16} strokeWidth={1.75} />
          </IconButton>
        )}
      </header>

      {status === 'error' && <p className="card__error">{error}</p>}

      {noGroups && <p className="card__error card__error--soft">Sin grupos este semestre.</p>}

      {onlyOpen && all.length > 0 && sections.length === 0 && (
        <p className="card__error card__error--soft">Ningún grupo con cupo ahora mismo.</p>
      )}

      {sections.length > 0 && (
        <ul className="slots">
          {visibleSections.map((s) => {
            const seats = s.seats?.available ?? null;
            const inConflict = selection.conflictKeys.has(s.key);
            const who = s.instructor ? titleCase(s.instructor) : 'sin profesor asignado';
            const when = s.schedule.length === 0 ? 'sin horario' : formatScheduleSummary(s.schedule);

            const radio = (
              <input
                type="radio"
                name={groupName}
                checked={selection.pickedKey === s.key}
                aria-label={`Elegir grupo ${s.key} de ${item.name}`}
                onChange={() => selection.onPick(s.key)}
                // Dos cosas a la vez. Primera: un radio nativo no se
                // desmarca solo tocándolo de nuevo, y "no elijo ningún
                // grupo" es una opción válida — el mismo clic que lo marcó
                // tiene que poder desmarcarlo. Segunda: `stopPropagation`
                // corta la burbuja hacia el <li>, que también escucha click
                // para seleccionar con toda la fila; sin cortarla, tocar el
                // radio ya marcado lo desmarcaría acá y el <li> lo volvería
                // a marcar en el mismo clic.
                onClick={(e) => {
                  e.stopPropagation();
                  if (selection.pickedKey === s.key) {
                    e.preventDefault();
                    selection.onPick(null);
                  }
                }}
              />
            );

            // Toda la fila selecciona, no solo el radio: es un blanco de
            // 1rem en una lista pensada para tocar con el dedo. Desmarcar
            // sigue siendo cosa del radio (arriba) — la fila solo afirma
            // "quiero este grupo", nunca lo apaga.
            const selectRow = () => selection.onPick(s.key);

            return (
              <li
                key={s.key}
                className={`slot ${seats === 0 ? 'is-zero' : ''} ${inConflict ? 'is-conflict' : ''}`}
                onClick={selectRow}
              >
                <span className="slot__key tnum" title={s.key}>
                  {s.key}
                </span>
                {/* El texto va en su propio <span> y no suelto al lado del
                    icono: `text-overflow` solo actúa sobre el contenido en
                    línea de un contenedor de bloque, y estos dos son
                    `display: flex` por el icono. Suelto, el texto se
                    recortaba a hachazo limpio —sin los puntos— porque quien
                    desbordaba era una caja anónima de flex, no el span. */}
                <span className="slot__who">
                  <User size={12} strokeWidth={1.75} aria-hidden="true" />
                  <span className="slot__text" title={who}>
                    {who}
                  </span>
                </span>
                <span className={`slot__when${s.schedule.length > 0 ? ' tnum' : ''}`}>
                  <Clock size={12} strokeWidth={1.75} aria-hidden="true" />
                  <span className="slot__text" title={when}>
                    {when}
                  </span>
                </span>
                <span className="slot__seats">
                  <SeatsFigure available={seats} tone={seats === 0 ? 'empty' : 'ok'} animate />
                </span>
                <span className="slot__radio">
                  {inConflict && (
                    <TriangleAlert
                      className="slot__conflict-icon"
                      size={13}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  )}
                  {radio}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {collapsible && (
        <button type="button" className="slots__more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'ver menos' : `ver los ${hiddenCount} grupos restantes`}
        </button>
      )}
    </li>
  );
}

/** 'FUND. OBLIGATORIA (B)' → 'B'. Misma lógica que Program.tsx. */
function shortTypology(t: string): string {
  return t.match(/\(([^)]+)\)/)?.[1] ?? t.slice(0, 3);
}

function slugTypology(t: string): string {
  if (t.startsWith('LIBRE')) return 'libre';
  if (t.includes('OBLIGATORIA')) return 'obligatoria';
  if (t.includes('OPTATIVA')) return 'optativa';
  return 'otra';
}
