import { memo } from 'react';
import { HelpCircle, Loader2, TriangleAlert } from 'lucide-react';
import { STALE_SEATS_SECONDS } from '../api/client';
import { AppLink } from './AppLink';
import { AddButton } from './AddButton';
import { CopyCode } from './CopyCode';
import { PlanAttributionRow, type PlanAttribution } from './PlanAttributionRow';
import { SeatsFigure } from './Seats';
import { Tooltip } from './Tooltip';
import { formatAge, sentence } from '../lib/format';
import type { MergedCourse } from '../lib/catalog';
import { typologyLetter, typologySlug } from '../lib/typology';
import type { Selection } from '../lib/storage';

// La fila del catálogo y su celda de cupos. Vivían al final de Program.tsx,
// que pasaba de 1400 líneas; son lo único de esa pantalla que se pinta cientos
// de veces, y lo que más cambió cuando se rehízo la medición automática.

/**
 * Una fila del catálogo. Memoizada: el catálogo son hasta ~700 de estas, cada
 * una con tres o cuatro `Tooltip`, y sin esto CUALQUIER cambio de estado de la
 * pantalla —una medición que llega, una tecla en el buscador— las repintaba a
 * todas. Sus props son primitivas u objetos que `withSeats` mantiene estables,
 * así que llega una medición y se repinta una fila.
 */
export const CatalogRow = memo(function CatalogRow({
  c,
  id,
  conflict,
  attr,
  plans,
  measuring,
}: {
  c: MergedCourse;
  id: string;
  conflict: 'active' | 'potential' | null;
  attr: { primary: PlanAttribution; secondary?: PlanAttribution } | null;
  plans?: readonly Selection[];
  measuring: boolean;
}) {
  const conflictText =
    conflict === 'active'
      ? 'El grupo elegido choca con tu horario actual.'
      : 'Ningún grupo de esta materia te sirve: todos chocan con tu horario actual.';
  return (
    // `data-cid`: por acá encuentra la fila el IntersectionObserver que decide
    // qué se mide (ver `unknownById` en Program).
    <li data-cid={id}>
      <AppLink
        className={`row table__row ${conflict === 'active' ? 'is-conflict' : ''} ${conflict === 'potential' ? 'is-conflict-potential' : ''}`}
        to={{ name: 'course', selection: c.plan, code: c.code, alsoIn: c.alsoIn }}
      >
        <CopyCode code={c.code} className="row__code tnum col-code" />
        <span className="row__name">
          {conflict && (
            <Tooltip content={<p className="tt-body">{conflictText}</p>}>
              <span className="row__conflict-icon" role="img" aria-label={conflictText.replace(/\.$/, '')}>
                <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
              </span>
            </Tooltip>
          )}
          <Tooltip content={<p className="tt-title">{sentence(c.name)}</p>} onlyIfTruncated>
            <span className="row__name-text">{sentence(c.name)}</span>
          </Tooltip>
        </span>
        <Tooltip
          content={
            attr && plans ? (
              <PlanTypologyInfo primary={attr.primary} secondary={attr.secondary} plans={plans} />
            ) : (
              <>
                <p className="tt-eyebrow">Tipología</p>
                <p className="tt-title">{c.typology}</p>
              </>
            )
          }
        >
          <span className={`tag tag--${typologySlug(attr?.primary.typology ?? c.typology)} col-typ`}>
            {typologyLetter(attr?.primary.typology ?? c.typology)}
          </span>
        </Tooltip>
        <span className="row__credits tnum col-cr">{c.credits}</span>
        {/* `c` ya viene de `withSeats`: si esta sesión midió esta materia, lo
            que se pinta es lo medido. */}
        <SeatsCell seats={c.seats} askedAt={c.detail_fetched_at} measuring={measuring} />
        <AddButton
          item={{
            level: c.plan.level,
            campus: c.plan.campus,
            program: c.plan.program,
            faculty: c.plan.faculty,
            code: c.code,
            name: c.name,
            credits: c.credits,
            typology: c.typology,
          }}
        />
      </AppLink>
    </li>
  );
});

/**
 * Cómo cuenta esta materia en cada uno de mis planes — el contenido del
 * hover de la letra de tipología (col-typ). Antes había además un chip por
 * plan pegado al nombre (PlanTag); se quitó por pedido explícito —comía
 * espacio de lectura sin decir nada que este hover no dijera ya— así que
 * esto quedó como el único lugar donde se ve la atribución.
 *
 * `primary`/`secondary` ya vienen decididos por `attributionOf`: acá no se
 * elige nada, solo se pinta con `PlanAttributionRow` (components/), la
 * misma que usan Course.tsx y CourseCard.tsx (PLAN-DOUBLE-TITULATION.md D6
 * interfaz §7).
 */
function PlanTypologyInfo({
  primary,
  secondary,
  plans,
}: {
  primary: PlanAttribution;
  secondary?: PlanAttribution;
  plans: readonly Selection[];
}) {
  return (
    <>
      <PlanAttributionRow attr={primary} plans={plans} mine />
      {/* Si la materia está en el otro plan, se dice siempre — coincida o no
          la tipología. Antes se callaba cuando coincidía ("ruido puro"),
          pero eso era tratar la coincidencia como si no hubiera "ganador"
          que anunciar; el punto es al revés: coincidan o no, es información
          real sobre AMBOS planes, y callarla es lo que se leía raro. */}
      {secondary && <PlanAttributionRow attr={secondary} plans={plans} />}
    </>
  );
}


/**
 * Los cupos de la asignatura, sumados sobre los grupos que este plan ve.
 *
 * Tres estados, y la diferencia entre dos de ellos es la que importa:
 *
 *   sin preguntar   → un signo de pregunta. Nadie pidió el detalle todavía.
 *   sin grupos      → 0. Se preguntó y el SIA contestó que no hay oferta.
 *   con grupos      → el número, verde si queda algo y óxido si es cero.
 *
 * Los dos primeros se veían igual —un guion— y eso era mentir por omisión:
 * "no sé" y "no hay" son respuestas distintas. Lo que los separa es
 * `detail_fetched_at`, el sello de la última vez que este plan pidió el
 * detalle.
 *
 * Sin botón de recargar a propósito: acá se muestra lo que la base YA tiene.
 * Un botón por fila invitaría a disparar una consulta al SIA por cada una de
 * las 313 asignaturas. El signo de pregunta no es un botón aparte —la fila
 * entera ya es un enlace— sino la señal de que ahí adentro hay algo que
 * averiguar: entrar a la asignatura mide todos sus grupos de un POST.
 */
function SeatsCell({
  seats,
  askedAt,
  measuring = false,
}: {
  seats?: MergedCourse['seats'];
  askedAt?: string | null;
  /** True mientras la medición automática de esta fila está en vuelo. */
  measuring?: boolean;
}) {
  // Manda sobre todo lo demás: con una petición en vuelo para esta fila, el
  // `?` sería mentira por unos segundos. Se va cuando llega el dato.
  //
  // Sin `aria-label` en el contenedor: con el `sr-only` adentro serían dos
  // anuncios del mismo estado. El ícono va `aria-hidden` y el texto es el
  // que se lee.
  if (measuring && !seats) {
    return (
      <span className="row__seats is-unknown col-seats">
        <Loader2 size={15} strokeWidth={2} className="skel--spin" aria-hidden="true" />
        <span className="sr-only">Midiendo cupos…</span>
      </span>
    );
  }
  if (!seats) {
    if (!askedAt) {
      return (
        <Tooltip
          content={
            <p className="tt-body">
              Nunca se le preguntó al SIA por esta asignatura. Ábrela para medir
              sus cupos.
            </p>
          }
        >
          <span className="row__seats is-unknown col-seats">
            <HelpCircle size={15} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Cupos sin consultar</span>
          </span>
        </Tooltip>
      );
    }
    // "Sin grupos" tampoco es para siempre: la UNAL puede programar oferta
    // mañana. Así que lleva su edad igual que todo lo demás — la del sello del
    // detalle, calculada acá porque el reloj del servidor solo sella los cupos.
    const ageSeconds = (Date.now() - Date.parse(askedAt)) / 1000;

    if (ageSeconds > STALE_SEATS_SECONDS) {
      const staleTimeText =
        STALE_SEATS_SECONDS >= 3600
          ? `${Math.floor(STALE_SEATS_SECONDS / 3600)} ${Math.floor(STALE_SEATS_SECONDS / 3600) === 1 ? 'hora' : 'horas'}`
          : `${Math.floor(STALE_SEATS_SECONDS / 60)} ${Math.floor(STALE_SEATS_SECONDS / 60) === 1 ? 'minuto' : 'minutos'}`;

      return (
        <Tooltip
          content={
            <p className="tt-body">
              Hace más de {staleTimeText} que se midieron los cupos. Ábrela para volver
              a preguntar.
            </p>
          }
        >
          <span className="row__seats is-unknown col-seats">
            <HelpCircle size={15} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Cupos desactualizados</span>
          </span>
        </Tooltip>
      );
    }

    const age = formatAge(ageSeconds);
    return (
      <Tooltip
        content={
          <>
            <p className="tt-title">Sin grupos programados</p>
            <p className="tt-body">
              Consultado el {new Date(askedAt).toLocaleString('es-CO')}.
            </p>
          </>
        }
      >
        <span className="row__seats is-none col-seats">
          <SeatsFigure available={null} announce={false} />
          <small>
            sin grupos<span className="row__age tnum"> · {age}</span>
          </small>
        </span>
      </Tooltip>
    );
  }
  // La edad sale del sello y no de `age_seconds`: ese número se calculó cuando
  // respondió la API, y una pestaña abierta una hora lo seguiría mostrando igual.
  const seatsAgeSeconds = (Date.now() - Date.parse(seats.measured_at)) / 1000;
  // Vencido NO es desconocido. Antes, pasado STALE_SEATS_SECONDS, la celda
  // tiraba el número y pintaba un `?`: la base sabía "12 cupos hace un día" y
  // la pantalla decía menos que eso. Fuera de inscripciones los cupos casi no
  // se mueven, así que el número viejo suele ser el correcto. Se deja a la
  // vista, atenuado y con su edad, y la rueda al lado mientras se remide — al
  // llegar la medición el número se actualiza en el sitio, sin pasar por nada.
  const stale = seatsAgeSeconds > STALE_SEATS_SECONDS;

  return (
    <Tooltip
      content={
        <ul className="tt-rows">
          <li className="tt-row">
            <span>Cupos</span>
            <b className="tnum">{seats.available}</b>
          </li>
          <li className="tt-row">
            <span>Grupos</span>
            <b className="tnum">{seats.sections}</b>
          </li>
          <li className="tt-row">
            <span>Medido</span>
            <b>{new Date(seats.measured_at).toLocaleString('es-CO')}</b>
          </li>
          {stale && (
            <li className="tt-row">
              <span>{measuring ? 'Midiendo de nuevo…' : 'Dato viejo: ábrela para volver a medir'}</span>
            </li>
          )}
        </ul>
      }
    >
      <span
        className={`row__seats col-seats ${stale ? 'is-stale' : seats.available === 0 ? 'is-zero' : 'is-open'}`}
      >
        {/* Sin animar: 313 filas aleteando en la primera pintura serían ruido
            y trabajo por nada. La forma y el color sí son los de la ficha. */}
        <SeatsFigure
          available={seats.available}
          tone={stale ? 'stale' : seats.available === 0 ? 'empty' : 'ok'}
        />
        {measuring ? (
          <small>
            <Loader2 size={11} strokeWidth={2} className="skel--spin" aria-hidden="true" />
            <span className="sr-only">Midiendo cupos…</span>
          </small>
        ) : (
          <small className="tnum">{formatAge(seatsAgeSeconds)}</small>
        )}
      </span>
    </Tooltip>
  );
}

