import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ArrowLeftRight, Check, CornerUpLeft, HelpCircle, Search, Ticket, X } from 'lucide-react';
import { routes } from '../api/client';
import type { CoursesResponse, CourseSummary, ProgramsResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { usePlan } from '../hooks/usePlan';
import { Layout } from '../components/Layout';
import { useConfirm } from '../components/Confirm';
import { AddButton } from '../components/AddButton';
import { Empty, Fault, Loading } from '../components/States';
import { fold, formatAge, sentence } from '../lib/format';
import { selectionId, selectionPath } from '../lib/storage';
import './Program.css';

/**
 * El catálogo de un plan. Hasta ~700 asignaturas (Medellín: 694).
 *
 * Los filtros son en memoria a propósito: el catálogo completo ya vino en la
 * misma respuesta, así que filtrar en el servidor costaría otra consulta al
 * SIA para mostrar menos de lo que ya tenemos.
 */
export function Program() {
  const { campus = '', program = '', level = 'pregrado' } = useParams();
  const [params] = useSearchParams();
  const faculty = params.get('f') ?? '';

  const path = routes.courses({ level, campus, faculty }, program);
  const { data, error, loading, elapsed, attempt, reload } =
    useApi<CoursesResponse>(path);

  /**
   * Los filtros.
   *
   * Tipología y créditos son conjuntos, no un valor: "3 o 4 créditos" y
   * "obligatorias y optativas" son preguntas normales, y con un desplegable de
   * una sola opción había que elegir dos veces y comparar de memoria. Los
   * valores son pocos y fijos —siete tipologías, una decena de créditos— así
   * que caben todos a la vista, con cuántas asignaturas hay en cada uno.
   */
  const [q, setQ] = useState('');
  const [typols, setTypols] = useState<ReadonlySet<string>>(new Set());
  const [creds, setCreds] = useState<ReadonlySet<number>>(new Set());
  const [onlyOpen, setOnlyOpen] = useState(false);

  // Los valores que EXISTEN en este plan, con su cuenta. Nada de listas fijas:
  // Medellín llega a 12 créditos y Bogotá no pasa de 6.
  const facets = useMemo(() => {
    const byTypology = new Map<string, number>();
    const byCredits = new Map<number, number>();
    for (const c of data?.courses ?? []) {
      if (c.typology) byTypology.set(c.typology, (byTypology.get(c.typology) ?? 0) + 1);
      byCredits.set(c.credits, (byCredits.get(c.credits) ?? 0) + 1);
    }
    return {
      typologies: [...byTypology.keys()].sort((a, b) => a.localeCompare(b, 'es')),
      credits: [...byCredits.keys()].sort((a, b) => a - b),
      byTypology,
      byCredits,
    };
  }, [data]);

  const shown = useMemo(() => {
    const needle = fold(q);
    return (data?.courses ?? []).filter((c) => {
      if (needle && !fold(c.name).includes(needle) && !fold(c.code).includes(needle)) return false;
      if (typols.size && !typols.has(c.typology)) return false;
      if (creds.size && !creds.has(c.credits)) return false;
      if (onlyOpen && !hasRoom(c)) return false;
      return true;
    });
  }, [data, q, typols, creds, onlyOpen]);

  const total = data?.courses.length ?? 0;
  const filtering = !!q || typols.size > 0 || creds.size > 0 || onlyOpen;

  function clearAll() {
    setQ('');
    setTypols(new Set());
    setCreds(new Set());
    setOnlyOpen(false);
  }

  /**
   * El plan de la URL contra el plan elegido.
   *
   * Se puede llegar acá sin haber pasado por /plan: una URL pegada en un chat,
   * un marcador viejo, el botón de atrás. Dos casos, dos respuestas distintas:
   *
   *  - sin plan elegido → este vale como la elección. No hay nada que perder,
   *    así que no hay nada que preguntar.
   *  - con otro plan elegido → NO se toca nada por las malas. Se avisa y se
   *    deja decidir: el cambio borra el semestre y eso no puede pasar por
   *    haber tocado "atrás".
   */
  const plan = usePlan();
  const [ask, confirmDialog] = useConfirm();
  const { selection, select } = plan;
  const here = { level, campus, program };
  const foreign = selection && selectionId(selection) !== selectionId(here);

  useEffect(() => {
    if (selection) return;
    select({
      ...here,
      // Entrando por URL directa no hay lista de planes a mano de dónde sacar
      // los nombres. El código alcanza como rótulo hasta que se complete abajo.
      campusName: campus,
      faculty,
      facultyName: '',
      programName: program,
    });
    // Solo importa el plan de la URL: los nombres son decoración.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, select, level, campus, faculty, program]);

  /**
   * Ponerle nombre a un plan adoptado desde una URL pegada.
   *
   * Ese camino guarda el código como rótulo, porque ahí no hay de dónde sacar
   * el nombre — y el chip de la barra terminaría diciendo "2A74 · 2A74". El
   * directorio de la sede sí lo tiene, así que se pide UNA vez, solo cuando
   * falta: la condición es que el nombre siga siendo igual al código.
   */
  const needsName = !!selection && !foreign && selection.programName === selection.program;
  const directory = useApi<ProgramsResponse>(
    needsName ? routes.programs({ level, campus, faculty }) : null,
  );

  useEffect(() => {
    if (!needsName || !selection) return;
    const p = directory.data?.programs.find((x) => x.code === program);
    if (!p) return;
    select({
      level,
      campus,
      campusName: p.campus_name,
      faculty: p.faculty_code,
      facultyName: p.faculty_name,
      program: p.code,
      programName: p.name,
    });
  }, [directory.data, needsName, selection, select, level, campus, program]);

  async function adoptThis() {
    if (!selection) return;
    const n = plan.items.length;
    if (n > 0) {
      const ok = await ask({
        title: `Cambiar al plan ${program}`,
        danger: true,
        confirmLabel: 'Cambiar de plan',
        body: (
          <>
            <p>
              Se va a borrar {n === 1 ? 'la materia guardada' : `las ${n} materias guardadas`} en Mi
              semestre, porque {n === 1 ? 'es' : 'son'} del plan <b>{selection.programName}</b>.
            </p>
            <p>Sus grupos y su tipología son de ese plan, no de este.</p>
          </>
        ),
      });
      if (!ok) return;
    }
    select({ ...here, campusName: campus, faculty, facultyName: '', programName: program });
  }

  return (
    <Layout>
      {confirmDialog}
      {foreign && selection && (
        <div className="stray" role="status">
          <p className="stray__text">
            Estás mirando el plan <b>{program}</b>, y el tuyo es <b>{selection.programName}</b>.
            Puedes mirar todo lo que quieras, pero para agregar materias al semestre tienes que
            estar en tu plan.
          </p>
          <div className="stray__actions">
            <Link className="btn" to={selectionPath(selection)}>
              <CornerUpLeft size={15} strokeWidth={1.75} aria-hidden="true" />
              volver al mío
            </Link>
            <button className="btn btn--ghost" onClick={adoptThis}>
              <ArrowLeftRight size={15} strokeWidth={1.75} aria-hidden="true" />
              cambiarme a este
            </button>
          </div>
        </div>
      )}

      <header className="head">
        <div>
          <p className="eyebrow">plan {program}</p>
          <h1 className="head__title">Catálogo</h1>
        </div>
        {total > 0 && (
          <p className="head__meta tnum">
            {shown.length === total ? `${total} asignaturas` : `${shown.length} de ${total}`}
          </p>
        )}
      </header>

      {loading && !data && (
        <Loading elapsed={elapsed} attempt={attempt} what="Trayendo el catálogo" />
      )}
      {error && <Fault error={error} onRetry={() => reload()} />}

      {data && (
        <>
          <div className="toolbar">
            <label className="search search--flex">
              <Search size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="sr-only">Buscar asignatura</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar por nombre o código…"
              />
            </label>

            {/* El filtro que más se usa va arriba y solo: es una pregunta de
                sí o no —"¿puedo meterme hoy?"— y no compite con las otras. */}
            <button
              className={`chip ${onlyOpen ? 'is-on' : ''}`}
              onClick={() => setOnlyOpen((v) => !v)}
              aria-pressed={onlyOpen}
              title="Deja solo las que tienen cupo. Las que nunca se han consultado también se quedan: es mejor que sobre una a que se pierda una con cupos."
            >
              {onlyOpen ? (
                <Check size={14} strokeWidth={2.5} aria-hidden="true" />
              ) : (
                <Ticket size={14} strokeWidth={1.75} aria-hidden="true" />
              )}
              con cupos
            </button>

            {filtering && (
              <button
                className="toolbar__clear"
                onClick={clearAll}
                aria-label="Quitar los filtros"
                title="Quitar los filtros"
              >
                <X size={15} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="filters">
            <div className="filters__row">
              <span className="filters__label">tipología</span>
              <div className="chips">
                {facets.typologies.map((t) => (
                  <button
                    key={t}
                    className={`chip chip--sm ${typols.has(t) ? 'is-on' : ''}`}
                    onClick={() => setTypols((s) => toggle(s, t))}
                    aria-pressed={typols.has(t)}
                    title={t}
                  >
                    {sentence(t.replace(/\s*\([^)]*\)\s*$/, ''))}
                    <span className="chip__code tnum">{facets.byTypology.get(t)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="filters__row">
              <span className="filters__label">créditos</span>
              <div className="chips">
                {facets.credits.map((n) => (
                  <button
                    key={n}
                    className={`chip chip--sm ${creds.has(n) ? 'is-on' : ''}`}
                    onClick={() => setCreds((s) => toggle(s, n))}
                    aria-pressed={creds.has(n)}
                    title={`${n} ${n === 1 ? 'crédito' : 'créditos'}`}
                  >
                    <span className="tnum">{n}</span>
                    <span className="chip__code tnum">{facets.byCredits.get(n)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {shown.length === 0 ? (
            <Empty
              title="Ninguna asignatura coincide"
              note="Quita algún filtro. Ojo: la tipología depende del plan, no de la asignatura."
            />
          ) : (
            <div className="table">
              {/* La cabecera comparte la MISMA rejilla que las filas: es lo que
                  hace que las columnas queden alineadas sin usar <table>, que
                  no sabe truncar celdas sin romper el ancho. */}
              <div className="table__head" aria-hidden="true">
                <span className="col-code">código</span>
                <span>asignatura</span>
                <span className="col-typ">tip</span>
                <span className="col-cr">cr</span>
                <span className="col-seats">cupos</span>
                <span />
              </div>

              <ul className="rows">
                {shown.map((c) => (
                  <li key={c.code}>
                    <Link
                      className="row"
                      to={`/nivel/${level}/sede/${campus}/plan/${program}/asignatura/${encodeURIComponent(c.code)}${
                        faculty ? `?f=${faculty}` : ''
                      }`}
                    >
                      <span className="row__code tnum col-code">{c.code}</span>
                      <span className="row__name">{sentence(c.name)}</span>
                      <span
                        className={`tag tag--${slugTypology(c.typology)} col-typ`}
                        title={c.typology}
                      >
                        {shortTypology(c.typology)}
                      </span>
                      <span className="row__credits tnum col-cr">{c.credits}</span>
                      <SeatsCell seats={c.seats} askedAt={c.detail_fetched_at} />
                      <AddButton
                        item={{
                          level,
                          campus,
                          program,
                          faculty,
                          code: c.code,
                          name: c.name,
                          credits: c.credits,
                          typology: c.typology,
                        }}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Layout>
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
}: {
  seats?: CourseSummary['seats'];
  askedAt?: string | null;
}) {
  if (!seats) {
    if (!askedAt) {
      return (
        <span
          className="row__seats is-unknown col-seats"
          title="Nunca se le preguntó al SIA por esta asignatura. Ábrela para medir sus cupos."
        >
          <HelpCircle size={15} strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">Cupos sin consultar</span>
        </span>
      );
    }
    // "Sin grupos" tampoco es para siempre: la UNAL puede programar oferta
    // mañana. Así que lleva su edad igual que todo lo demás — la del sello del
    // detalle, calculada acá porque el reloj del servidor solo sella los cupos.
    const age = formatAge((Date.now() - Date.parse(askedAt)) / 1000);
    return (
      <span
        className="row__seats is-none col-seats"
        title={`Sin grupos programados · consultado ${new Date(askedAt).toLocaleString('es-CO')}`}
      >
        {/* Una raya, no un cero. En una columna de cupos el cero significa
            "hay grupos y están llenos", que es la mala noticia accionable;
            acá no hay nada que llenar. La raya es la convención de "no hay
            valor" y deja el óxido para los ceros de verdad. */}
        <b aria-hidden="true">—</b>
        <small>
          sin grupos<span className="row__age tnum"> · {age}</span>
        </small>
      </span>
    );
  }
  return (
    <span
      className={`row__seats col-seats ${seats.available === 0 ? 'is-zero' : 'is-open'}`}
      title={`${seats.available} cupos en ${seats.sections} grupos · medido ${new Date(seats.measured_at).toLocaleString('es-CO')}`}
    >
      <b className="tnum">{seats.available}</b>
      <small className="tnum">{formatAge(seats.age_seconds)}</small>
    </span>
  );
}

/** Añade o quita, sin mutar: React solo repinta si el objeto es otro. */
function toggle<T>(set: ReadonlySet<T>, v: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(v)) next.add(v);
  return next;
}

/**
 * ¿Se puede entrar hoy?
 *
 * Las nunca consultadas cuentan como que SÍ, y es a propósito: de esas no se
 * sabe nada, y esconderlas por no saber sería tomar la decisión por quien
 * busca. Que sobre una asignatura con un `?` es barato; que se pierda una con
 * cupos porque nadie la había abierto todavía, no.
 *
 * Las que sí se consultaron y no tienen grupos, o los tienen llenos, se van:
 * de esas la respuesta ya se sabe.
 */
function hasRoom(c: CourseSummary): boolean {
  if (c.seats) return c.seats.available > 0;
  return !c.detail_fetched_at;
}

/** 'FUND. OBLIGATORIA (B)' → 'B'. La letra entre paréntesis es lo que informa. */
function shortTypology(t: string): string {
  return t.match(/\(([^)]+)\)/)?.[1] ?? t.slice(0, 3);
}

function slugTypology(t: string): string {
  if (t.startsWith('LIBRE')) return 'libre';
  if (t.includes('OBLIGATORIA')) return 'obligatoria';
  if (t.includes('OPTATIVA')) return 'optativa';
  return 'otra';
}
