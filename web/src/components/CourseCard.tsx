import { useState } from 'react';
import { Clock, Trash2, TriangleAlert, User } from 'lucide-react';
import type { ClassSession } from '../api/types';
import type { Row } from '../hooks/useCourseDetails';
import { usePlan } from '../hooks/usePlan';
import { formatAge, formatScheduleSummary, groupSchedule, titleCase } from '../lib/format';
import { itemId } from '../lib/storage';
import { AppLink } from './AppLink';
import { IconButton } from './IconButton';
import { SeatsFigure } from './Seats';
import { Tooltip } from './Tooltip';
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
  const { item, detail, status, error, errorCode } = row;
  const all = detail?.sections ?? [];
  const sections = all.filter((s) => !onlyOpen || (s.seats?.available ?? 0) > 0);
  const totalSeats = all.reduce((n, s) => n + (s.seats?.available ?? 0), 0);
  const noGroups = status === 'done' && detail && all.length === 0;
  const groupName = itemId(item);

  // D10: la sigla del plan por fila, solo con doble titulación. Con un plan
  // esta tarjeta es byte por byte la de `main`.
  const showPlan = usePlan().plans.length > 1;

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
    // El nombre se recorta con puntos suspensivos cuando la columna no le
    // alcanza — los del SIA son largos. `onlyIfTruncated`: si entra
    // completo, el tooltip no tiene nada que agregar y se queda callado.
    <Tooltip content={<p className="tt-title">{item.name}</p>} onlyIfTruncated>

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
    </Tooltip>
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
        {showPlan ? (
          <span className="card__namecell">
            <Tooltip
              content={
                <p className="tt-body">
                  Se cuenta en <b>{item.program}</b> como <code>{item.typology}</code>
                </p>
              }
            >
              <span className="chip__code tnum card__plan-tag">{item.program}</span>
            </Tooltip>
            {nameLink}
          </span>
        ) : (
          nameLink
        )}
        <Tooltip
          content={
            <>
              <p className="tt-eyebrow">Tipología</p>
              <p className="tt-title">{item.typology}</p>
            </>
          }
        >
          <span className={`tag tag--${slugTypology(item.typology)} col-typ`}>
            {shortTypology(item.typology)}
          </span>
        </Tooltip>
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

      {status === 'error' && (
        <p className="card__error">
          {error}
          {/* La reconciliación (docs/PLAN-SIACHANGES.md D2) apaga la materia
              del catálogo del plan: reintentar nunca la trae de vuelta. La
              caneca de arriba ya la quita, pero acá al lado hace explícito
              QUÉ hacer con el error en vez de dejarlo en un limbo hasta que
              alguien note el ícono. */}
          {errorCode === 'unknown_course' && onRemove && (
            <>
              {' '}
              <button type="button" className="card__errorAction" onClick={onRemove}>
                quitar de la lista
              </button>
            </>
          )}
        </p>
      )}

      {noGroups && <p className="card__error card__error--soft">Sin grupos este semestre.</p>}

      {onlyOpen && all.length > 0 && sections.length === 0 && (
        <p className="card__error card__error--soft">Ningún grupo con cupo ahora mismo.</p>
      )}

      {sections.length > 0 && (
        <ul className="slots">
          {visibleSections.map((s) => {
            const seats = s.seats?.available ?? null;
            const inConflict = selection.conflictKeys.has(s.key);
            // Rojo: ESTE es el grupo elegido y choca — un bloqueo real, ya
            // armado. Ocre: un grupo que todavía no elegiste, pero que
            // chocaría si lo eligieras — un aviso, no un bloqueo, porque
            // nadie lo escogió todavía.
            const isActiveConflict = inConflict && selection.pickedKey === s.key;
            const isPotentialConflict = inConflict && selection.pickedKey !== s.key;
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
                className={`slot ${seats === 0 ? 'is-zero' : ''} ${isActiveConflict ? 'is-conflict' : ''} ${isPotentialConflict ? 'is-conflict-potential' : ''}`}
                onClick={selectRow}
              >
                <Tooltip
                  content={
                    <>
                      <p className="tt-eyebrow">Grupo</p>
                      <p className="tt-title">{s.key}</p>
                    </>
                  }
                  onlyIfTruncated
                >
                  <span className="slot__key tnum">{s.key}</span>
                </Tooltip>
                {/* El texto va en su propio <span> y no suelto al lado del
                    icono: `text-overflow` solo actúa sobre el contenido en
                    línea de un contenedor de bloque, y estos dos son
                    `display: flex` por el icono. Suelto, el texto se
                    recortaba a hachazo limpio —sin los puntos— porque quien
                    desbordaba era una caja anónima de flex, no el span. */}
                <span className="slot__who">
                  <User size={12} strokeWidth={1.75} aria-hidden="true" />
                  <Tooltip
                    content={
                      <>
                        <p className="tt-eyebrow">Docente</p>
                        <p className="tt-title">{who}</p>
                      </>
                    }
                    onlyIfTruncated
                  >
                    <span className="slot__text">{who}</span>
                  </Tooltip>
                </span>
                <span className={`slot__when${s.schedule.length > 0 ? ' tnum' : ''}`}>
                  <Clock size={12} strokeWidth={1.75} aria-hidden="true" />
                  {/* Sin `onlyIfTruncated`: a diferencia del nombre o el
                      docente, este texto siempre es un resumen —días
                      abreviados, hora sin el minuto en punto, sin salón—
                      así que el tooltip siempre tiene algo que agregar,
                      quepa o no quepa el resumen entero en la fila. */}
                  <Tooltip content={<ScheduleTooltip when={when} schedule={s.schedule} />}>
                    <span className="slot__text">{when}</span>
                  </Tooltip>
                </span>
                <span className="slot__seats">
                  <SeatsFigure available={seats} tone={seats === 0 ? 'empty' : 'ok'} animate />
                </span>
                <span className="slot__radio">
                  {inConflict && (
                    <Tooltip
                      content={
                        <p className="tt-body">
                          {isActiveConflict
                            ? 'Este horario choca con tu horario actual.'
                            : 'Si eliges este grupo, va a chocar con tu horario actual.'}
                        </p>
                      }
                    >
                      <span
                        className="slot__conflict-icon"
                        role="img"
                        aria-label={
                          isActiveConflict
                            ? 'Este horario choca con tu horario actual'
                            : 'Si eliges este grupo, va a chocar con tu horario actual'
                        }
                      >
                        <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
                      </span>
                    </Tooltip>
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

/**
 * El tooltip del horario de un grupo: la fila solo tiene espacio para el
 * resumen comprimido ('lu · mi 11-13'), pero el dato completo trae días
 * enteros, hora sin recortar y el salón — que el resumen ni carga. Un
 * `.tt-row` por franja horaria, no una frase corrida: son datos, no prosa.
 */
function ScheduleTooltip({ when, schedule }: { when: string; schedule: ClassSession[] }) {
  if (schedule.length === 0) return <p className="tt-title">{when}</p>;
  const groups = groupSchedule(schedule);
  return (
    <ul className="tt-rows">
      {groups.map((g) => (
        <li className="tt-row" key={`${g.days}-${g.time}`}>
          <span>
            {g.days}
            {g.place && (
              <>
                <br />
                {g.place}
              </>
            )}
          </span>
          <b className="tnum">{g.time}</b>
        </li>
      ))}
    </ul>
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
