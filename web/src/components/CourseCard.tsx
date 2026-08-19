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
 * tarjeta —mismos datos, mismo radio de grupo elegido, conectado a la misma
 * selección (`useScheduleSelection`, Context)— y solo cambia cuánto detalle
 * muestran: Mi semestre es la vista completa (tabla con código, tipología,
 * créditos), Mi horario es la reducida (nombre, profe, horario) para dejarle
 * sitio al calendario. Esa diferencia es la prop `compact`.
 */
export function CourseCard({
  row,
  onlyOpen,
  onRemove,
  selection,
  compact = false,
  linkFrom,
}: {
  row: Row;
  onlyOpen: boolean;
  /** Ausente en Mi horario: ahí no tiene sentido quitar de Mi semestre. */
  onRemove?: () => void;
  selection: {
    pickedKey: string | null;
    onPick: (key: string | null) => void;
    /** section.key de esta materia que choca con otra ya elegida. */
    conflictKeys: Set<string>;
  };
  /** Vista reducida: nombre, profe, horario. La usa Mi horario para dejarle
   *  sitio al calendario. */
  compact?: boolean;
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
    <li className={`card ${compact ? 'card--compact' : ''} ${status === 'loading' ? 'is-loading' : ''}`}>
      {compact ? (
        <header className="card__head card__head--compact">
          {nameLink}
          {seatsTally}
        </header>
      ) : (
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
      )}

      {status === 'error' && <p className="card__error">{error}</p>}

      {noGroups && <p className="card__error card__error--soft">Sin grupos este semestre.</p>}

      {onlyOpen && all.length > 0 && sections.length === 0 && (
        <p className="card__error card__error--soft">Ningún grupo con cupo ahora mismo.</p>
      )}

      {sections.length > 0 && (
        <ul className={compact ? 'slotsc' : 'slots'}>
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

            if (compact) {
              return (
                <li
                  key={s.key}
                  className={`slotc ${inConflict ? 'is-conflict' : ''}`}
                  onClick={selectRow}
                >
                  <span className="slotc__radio">{radio}</span>
                  <span className="slotc__body">
                    <span className="slotc__line1">
                      {inConflict && (
                        <TriangleAlert
                          className="slotc__conflict-icon"
                          size={12}
                          strokeWidth={2.25}
                          aria-hidden="true"
                        />
                      )}
                      <span className="slotc__key tnum">{s.key}</span>
                      {who}
                    </span>
                    <span className={`slotc__line2${s.schedule.length > 0 ? ' tnum' : ''}`}>{when}</span>
                  </span>
                  <span className="slotc__seats">
                    <SeatsFigure available={seats} tone={seats === 0 ? 'empty' : 'ok'} animate />
                  </span>
                </li>
              );
            }

            return (
              <li
                key={s.key}
                className={`slot ${seats === 0 ? 'is-zero' : ''} ${inConflict ? 'is-conflict' : ''}`}
                onClick={selectRow}
              >
                <span className="slot__key tnum">{s.key}</span>
                <span className="slot__who">
                  <User size={12} strokeWidth={1.75} aria-hidden="true" />
                  {who}
                </span>
                <span className={`slot__when${s.schedule.length > 0 ? ' tnum' : ''}`}>
                  <Clock size={12} strokeWidth={1.75} aria-hidden="true" />
                  {when}
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
