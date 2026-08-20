import { useEffect, useMemo, useState } from 'react';
import { Download, PanelLeftClose, PanelLeftOpen, Share } from 'lucide-react';
import { Layout } from '../components/Layout';
import { AppLink } from '../components/AppLink';
import { Empty } from '../components/States';
import { IconButton } from '../components/IconButton';
import { PlanList } from '../components/PlanList';
import { PlanToolbar } from '../components/PlanToolbar';
import { Tooltip } from '../components/Tooltip';
import { WeekCalendar, type CalendarBlock } from '../components/WeekCalendar';
import { useCourseDetails } from '../hooks/useCourseDetails';
import { usePanelWidth } from '../hooks/usePanelWidth';
import { usePlan } from '../hooks/usePlan';
import { useScheduleConflicts } from '../hooks/useScheduleConflicts';
import { useScheduleSelection } from '../hooks/useScheduleSelection';
import { useViewportFit } from '../hooks/useViewportFit';
import { STACK_BREAKPOINT_PX } from '../lib/breakpoints';
import { blockId } from '../lib/conflicts';
import { courseColorVar } from '../lib/courseColors';
import { buildIcsCalendar, exportIcsFile, icsFileName, supportsFileShare } from '../lib/ics';
import { itemId } from '../lib/storage';
import './Schedule.css';

/**
 * El calendario semanal (issue #6). Materias, grupos y cupos salen de la
 * misma lista que Mi semestre —`plan.items`, medidos con
 * `useCourseDetails`—; el grupo elegido de cada una es el MISMO estado que
 * Mi semestre (`useScheduleSelection`, Context), así que marcar un radio acá
 * también lo marca allá. Lo único propio de esta pantalla es dónde cae eso
 * en la semana.
 *
 * El panel de la izquierda es Mi semestre, literalmente: la misma tabla
 * (`TableHead` + `CourseCard`), la misma barra de chips (`PlanToolbar`), el
 * mismo filtro y el mismo orden (`usePlanView`, Context). Antes era una
 * versión reducida —tarjetas sin código, sin tipología, sin créditos, sin
 * caneca y sin más control que "medir cupos"— y se leía como un recorte
 * deliberado. Lo único que obligaba a recortar era el ancho del panel, y de
 * eso ahora se encarga la propia tabla por consulta de contenedor.
 */
export function Schedule() {
  const plan = usePlan();
  const [listOpen, setListOpen] = useState(true);
  const { rows, running, done, total, ready, measure, fetchAll } = useCourseDetails(plan.items);
  const { selection } = useScheduleSelection();
  const { chosen, conflicts, blocks } = useScheduleConflicts(rows, selection);

  // Mismo cálculo que usa el calendario al lado (`WeekCalendar.tsx`): los
  // dos arrancan a la misma altura de página, así que miden el mismo alto
  // disponible sin coordinarse entre sí — es lo que hace que ninguno de los
  // dos sobrepase al otro. Sin opciones de mobile porque este panel no
  // existe en mobile: ver `isMobile` abajo.
  const [listRef, listMaxHeightRem] = useViewportFit<HTMLDivElement>();

  // Ancho del panel, arrastrable. Ver usePanelWidth para el porqué del
  // tope y el piso.
  const { containerRef, widthRem, dragging, onPointerDown, onKeyDown, min, max } =
    usePanelWidth();

  /**
   * Debajo de STACK_BREAKPOINT_PX, Mi horario es SOLO el calendario.
   *
   * La lista de materias de al lado —tarjetas con sus grupos y un radio por
   * grupo— es Mi semestre otra vez: mismas tarjetas, mismo estado
   * (`useScheduleSelection` es un Context compartido), misma acción. En
   * escritorio se justifica porque está al lado del calendario y se ve el
   * efecto de marcar un grupo sin cambiar de pantalla. En el teléfono no
   * puede estar al lado de nada: sería una segunda pantalla completa que
   * clona a la vecina, y con `.tabbar` fija abajo la vecina de verdad está
   * a un toque. Así que no se dibuja.
   *
   * Se desmonta, no se esconde con `display: none`: el panel mide su alto
   * con `getBoundingClientRect` en `useViewportFit`, y oculto por CSS esa
   * medida da cero — al volver a escritorio se quedaría con un alto
   * guardado incorrecto. Desmontado, al remontarse mide de cero.
   */
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < STACK_BREAKPOINT_PX);

  useEffect(() => {
    function sync() {
      setIsMobile(window.innerWidth < STACK_BREAKPOINT_PX);
    }
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  const colorOf = (id: string) => {
    const idx = plan.items.findIndex((it) => itemId(it) === id);
    return courseColorVar(idx < 0 ? 0 : idx);
  };

  const calendarBlocks: CalendarBlock[] = useMemo(
    () =>
      chosen.flatMap(({ row, id, section }) =>
        section.schedule.map((session) => {
          const b = { itemId: id, sectionKey: section.key, session };
          return {
            id: blockId(b),
            itemId: id,
            code: row.item.code,
            name: row.item.name,
            sectionKey: section.key,
            session,
            color: colorOf(id),
            conflict: conflicts.conflictBlocks.has(blockId(b)),
          };
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chosen, conflicts.conflictBlocks],
  );

  const withoutSchedule = chosen.filter(({ section }) => section.schedule.length === 0);
  const empty = plan.items.length === 0;
  const pickedCount = Object.keys(selection).filter((id) =>
    plan.items.some((it) => itemId(it) === id),
  ).length;

  // Lo que de verdad se puede exportar: grupos elegidos CON horario. Uno
  // sin sesiones —`withoutSchedule`, arriba— no aporta ningún VEVENT, así
  // que ni cuenta para encender el botón ni entra al .ics.
  const exportable = chosen.filter(({ section }) => section.schedule.length > 0);

  function exportToCalendar() {
    const courses = exportable.map(({ row, section }) => ({
      code: row.item.code,
      name: row.item.name,
      section,
    }));
    const ics = buildIcsCalendar(courses, plan.selection?.campusName);
    void exportIcsFile(icsFileName(courses), ics, 'Mi horario UNAL');
  }

  /**
   * Solo decide el ÍCONO del botón (compartir vs. descargar) — el archivo en
   * sí es el mismo en los dos casos, `exportIcsFile` decide de verdad cuál
   * de los dos pasa al hacer click. Se calcula una vez: no cambia entre
   * renders, y `navigator.share` no depende de nada que este componente
   * observe.
   */
  const [canShareFile] = useState(supportsFileShare);

  /**
   * En mobile con materias, el calendario ya está calculado para llenar
   * exactamente lo que hay entre la barra de arriba y `.tabbar` — el
   * colofón del sitio debajo no cabe sin forzar la página a un scroll que
   * no revela nada nuevo. Se esconde con un atributo en `<html>`, mismo
   * patrón que el tema (`lib/theme.ts`) — más simple que colar una prop de
   * Layout.tsx hasta acá solo para esta pantalla.
   *
   * Vacía (`empty`) sí lleva colofón: ahí no hay calendario que llene la
   * pantalla, solo un aviso corto, y una página que se corta en la nada a
   * media altura se lee como rota.
   */
  useEffect(() => {
    const root = document.documentElement;
    const hide = isMobile && !empty;
    if (hide) root.setAttribute('data-hide-footer', '');
    else root.removeAttribute('data-hide-footer');
    return () => root.removeAttribute('data-hide-footer');
  }, [isMobile, empty]);

  return (
    <Layout>
      <header className="head">
        <div>
          <p className="eyebrow">planificador</p>
          <h1 className="head__title">Mi horario</h1>
        </div>

        {/* Mismo `.head__side` que Mi semestre: el conteo pegado al borde
            derecho, en la fila del título. El botón ya no vive acá — ver
            el `.toolbar` de abajo — así que esta cabecera es, hueso por
            hueso, la misma de Mi semestre. */}
        <div className="head__side">
          <p className="head__meta tnum">
            {pickedCount} de {plan.items.length} materias con grupo elegido
          </p>
        </div>
      </header>

      {/* Fila de controles propia, debajo del header — el mismo lugar y la
          misma clase (`.toolbar`) que el `PlanToolbar` de Mi semestre, para
          que las dos cabeceras se lean como la misma app. Fuera de
          `.sched__list-head` (donde están los controles de la lista)
          porque exportar es del CALENDARIO, no de la lista: sigue haciendo
          falta con la lista colapsada y en mobile, donde
          `.sched__list-head` ni se dibuja. Escondida en vacío por la misma
          razón que el `PlanToolbar` de Mi semestre: nada que exportar
          todavía. */}
      {!empty && (
        <div className="toolbar">
          <button
            type="button"
            className="btn"
            onClick={exportToCalendar}
            disabled={exportable.length === 0}
            title={
              exportable.length === 0
                ? 'Elige al menos un grupo con horario para exportar.'
                : canShareFile
                  ? 'Agrega las materias elegidas a tu calendario.'
                  : 'Descarga un .ics con las materias elegidas: se importa en Google Calendar, Apple Calendar u Outlook.'
            }
          >
            {canShareFile ? (
              <Share size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            exportar
          </button>
        </div>
      )}

      {empty ? (
        <>
          <Empty
            title="Todavía no hay materias en Mi semestre"
            note="El calendario se arma con las materias que agregues desde el catálogo. Toca el + en las que estés considerando."
          />
          {plan.selection && (
            <p className="sched__back">
              <AppLink
                className="btn btn--primary"
                to={{ name: 'program', selection: plan.selection }}
              >
                ir al catálogo
              </AppLink>
            </p>
          )}
        </>
      ) : (
        // Sin `.toolbar` a ancho de pantalla arriba: los tres chips —medir,
        // con cupos, vaciar— viven DENTRO del panel, que es sobre lo que
        // actúan. Puestos arriba correrían al calendario una fila entera
        // hacia abajo por controles que no le pertenecen.
        //
        // En mobile, sin panel, esta pantalla se queda sin los tres: es el
        // mismo razonamiento llevado hasta el final. Son acciones sobre la
        // lista de materias, y esa lista es Mi semestre, que tiene su barra
        // de siempre a un toque en `.tabbar`. Acá el alto que ocuparían es
        // lo único escaso que hay.
        // El ref mide el ancho de ESTA fila, de donde sale el tope del
        // panel: la mitad. Ver usePanelWidth.
        <div className="sched__body" ref={containerRef}>
          {/* El ref y el alto van en `.sched__list`, no en lo de adentro: al
              colapsar/abrir (`listOpen`) esto no se desmonta —solo lo que
              hay dentro cambia entre la lista y el riel—, así que es lo
              único que puede medir su propio `top` una sola vez y quedarse
              fijo entre esos dos estados. Puesto en el hijo condicional, el
              riel colapsado se quedaba sin alto propio: medía lo que su
              contenido —un ícono— pedía, un botón chico flotando en vez de
              un carril del mismo alto que el calendario.

              En mobile no se dibuja del todo (`isMobile` arriba): esa lista
              es Mi semestre otra vez, y ahora Mi semestre está a un toque
              en la barra de abajo. */}
          {!isMobile && (
            <aside
              className={`sched__list ${listOpen ? '' : 'is-collapsed'} ${dragging ? 'is-dragging' : ''}`}
              ref={listRef}
              style={{
                ...(Number.isFinite(listMaxHeightRem) ? { height: `${listMaxHeightRem}rem` } : undefined),
                ...(listOpen ? { flexBasis: `${widthRem}rem` } : undefined),
              }}
            >
              {listOpen ? (
                <>
                  {/* Fuera del scroll, no pegada con `sticky` dentro: la
                      barra de chips ya envuelve a dos líneas en un panel
                      angosto, y flotando sobre el contenido se comía el
                      alto que las tarjetas necesitan. Como hermana del
                      área que scrollea se queda quieta y no tapa nada. */}
                  <div className="sched__list-head">
                    <PlanToolbar
                      measure={measure}
                      running={running}
                      ready={ready}
                      onMeasure={() => void fetchAll(true, ready)}
                      className="toolbar sched__toolbar"
                    />
                    <IconButton
                      onClick={() => setListOpen(false)}
                      label="Ocultar lista de materias"
                      className="iconbtn--row"
                    >
                      <PanelLeftClose size={16} strokeWidth={1.75} />
                    </IconButton>
                  </div>

                  <div className="sched__list-scroll">
                    <PlanList
                      rows={rows}
                      running={running}
                      done={done}
                      total={total}
                      chosenBlocks={blocks}
                      linkFrom="schedule"
                    />
                  </div>
                </>
              ) : (
                // Con la lista oculta el calendario se queda con todo el
                // ancho —útil en la semana con más materias amontonadas—,
                // pero el control para volver a abrirla no puede irse con
                // ella: queda este riel angosto, no un botón flotante que
                // aparece de la nada.
                <Tooltip content={<p className="tt-title">Mostrar lista de materias</p>} placement="bottom">
                  <button
                    type="button"
                    className="sched__rail"
                    onClick={() => setListOpen(true)}
                    aria-label="Mostrar lista de materias"
                  >
                    <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
            </aside>
          )}

          {/* Solo con la lista abierta: colapsada (`sched__rail`) no hay
              ancho que redimensionar, y arrastrar el riel de 2.75rem no
              tiene ningún sentido. */}
          {!isMobile && listOpen && (
            <div
              className={`sched__resizer ${dragging ? 'is-dragging' : ''}`}
              role="separator"
              aria-orientation="vertical"
              aria-label="Redimensionar panel de materias"
              aria-valuenow={Math.round(widthRem)}
              aria-valuemin={min}
              aria-valuemax={max}
              aria-valuetext={`${Math.round(widthRem)} rem`}
              tabIndex={0}
              onPointerDown={onPointerDown}
              onKeyDown={onKeyDown}
            />
          )}

          <div className="sched__calendar">
            {/* El aviso de calendario vacío cambia con el ancho porque
                cambia dónde se marca un grupo: en escritorio, en la lista
                de al lado; en mobile, en Mi semestre, que ya no está a la
                vista. Mandarlo "a la lista" en un teléfono donde no hay
                lista es mandarlo a ninguna parte, así que ahí el aviso
                lleva el enlace. */}
            <WeekCalendar
              blocks={calendarBlocks}
              emptyNote={
                isMobile ? (
                  <>
                    Elige un grupo por materia en{' '}
                    <AppLink to={{ name: 'semester' }}>Mi semestre</AppLink> para verlo aquí.
                  </>
                ) : undefined
              }
            />

            {withoutSchedule.length > 0 && (
              <div className="sched__noschedule">
                <p className="sched__noschedule-title">Sin horario informado, no se pueden ubicar:</p>
                <ul>
                  {withoutSchedule.map(({ row, section }) => (
                    <li key={`${itemId(row.item)}:${section.key}`}>
                      {row.item.name} · grupo {section.key}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
