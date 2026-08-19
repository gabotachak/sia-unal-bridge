import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Layout } from '../components/Layout';
import { AppLink } from '../components/AppLink';
import { CourseCard } from '../components/CourseCard';
import { Empty } from '../components/States';
import { IconButton } from '../components/IconButton';
import { MeasureChip } from '../components/MeasureChip';
import { MeasureProgress } from '../components/MeasureProgress';
import { WeekCalendar, type CalendarBlock } from '../components/WeekCalendar';
import { useCourseDetails } from '../hooks/useCourseDetails';
import { usePlan } from '../hooks/usePlan';
import { useScheduleConflicts } from '../hooks/useScheduleConflicts';
import { useScheduleSelection } from '../hooks/useScheduleSelection';
import { useViewportFit } from '../hooks/useViewportFit';
import { STACK_BREAKPOINT_PX } from '../lib/breakpoints';
import { blockId } from '../lib/conflicts';
import { courseColorVar } from '../lib/courseColors';
import { itemId } from '../lib/storage';
import './Schedule.css';

/**
 * El calendario semanal (issue #6). Materias, grupos y cupos salen de la
 * misma lista que Mi semestre —`plan.items`, medidos con
 * `useCourseDetails`—; el grupo elegido de cada una es el MISMO estado que
 * Mi semestre (`useScheduleSelection`, Context), así que marcar un radio acá
 * también lo marca allá. Lo único propio de esta pantalla es dónde cae eso
 * en la semana.
 */
export function Schedule() {
  const plan = usePlan();
  const [listOpen, setListOpen] = useState(true);
  const { rows, running, done, total, ready, measure, fetchAll } = useCourseDetails(plan.items);
  const { selection, pick } = useScheduleSelection();
  const { chosen, conflicts } = useScheduleConflicts(rows, selection);

  // Mismo cálculo que usa el calendario al lado (`WeekCalendar.tsx`): los
  // dos arrancan a la misma altura de página, así que miden el mismo alto
  // disponible sin coordinarse entre sí — es lo que hace que ninguno de los
  // dos sobrepase al otro. Se apaga bajo STACK_BREAKPOINT_PX por la misma
  // razón que en WeekCalendar: apilados, el scroll de la página alcanza.
  const [listRef, listMaxHeightRem] = useViewportFit<HTMLDivElement>({
    disableBelowPx: STACK_BREAKPOINT_PX,
  });

  /**
   * Colapsar la lista es un gesto de "gano ancho para el calendario" — en
   * una pantalla angosta, apilados, no hay ancho que ganar: la lista ya
   * ocupa el mismo 100% colapsada o abierta, y lo único que lograba antes
   * era un riel vacío tan alto como el calendario, empujándolo fuera de
   * vista. Se fuerza abierta ahí, y el botón para colapsar se esconde por
   * CSS (`.sched__list-head .iconbtn` bajo el breakpoint) para que no
   * quede una acción que no hace nada visible.
   */
  useEffect(() => {
    function sync() {
      if (window.innerWidth < STACK_BREAKPOINT_PX) setListOpen(true);
    }
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  /**
   * El atajo flotante de "saltar a la otra sección" — solo tiene sentido
   * apilado (`.sched__fab`, escondido por CSS en escritorio: ahí las dos
   * secciones ya están una al lado de la otra). Uno solo, no dos botones
   * fijos al final de cada sección: uno al final de una lista larga nunca
   * se ve mientras se scrollea, que es justo cuando hace falta. Flotando
   * queda a mano todo el tiempo, y cambia de sentido solo — apunta hacia
   * la sección que NO se está viendo — según cuál cruzó la mitad de la
   * pantalla. `listRef` ya existe para medir el alto del panel; sirve
   * igual de bien como blanco del scroll y como límite para saber cuál se
   * está viendo.
   */
  const calendarRef = useRef<HTMLDivElement>(null);
  const [viewingList, setViewingList] = useState(false);

  useEffect(() => {
    let raf = 0;
    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const listTop = listRef.current?.getBoundingClientRect().top ?? Infinity;
        setViewingList(listTop <= window.innerHeight / 2);
      });
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [listRef]);

  function jumpToList() {
    listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function jumpToCalendar() {
    calendarRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

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

  return (
    <Layout>
      <header className="head">
        <div>
          <p className="eyebrow">planificador</p>
          <h1 className="head__title">Mi horario</h1>
        </div>
        <p className="head__meta tnum">
          {pickedCount} de {plan.items.length} materias con grupo elegido
        </p>
      </header>

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
        // Sin `.toolbar` propio arriba: "medir cupos" vive DENTRO del panel
        // —es una acción sobre la lista, no sobre la pantalla— y eso deja al
        // calendario empezar justo debajo del título, en vez de correrlo una
        // fila entera hacia abajo por un botón que no le pertenece.
        <div className="sched__body">
          {/* El ref y el alto van en `.sched__list`, no en lo de adentro:
              esto NUNCA se desmonta —solo lo que hay dentro cambia entre
              la lista y el riel—, así que es lo único que puede medir su
              propio `top` una sola vez y quedarse fijo mientras se
              colapsa y se vuelve a abrir. Puesto en el hijo condicional,
              el riel colapsado se quedaba sin alto propio: medía lo que
              su contenido —un ícono— pedía, un botón chico flotando en
              vez de un carril del mismo alto que el calendario. */}
          <aside
            className={`sched__list ${listOpen ? '' : 'is-collapsed'}`}
            ref={listRef}
            style={Number.isFinite(listMaxHeightRem) ? { height: `${listMaxHeightRem}rem` } : undefined}
          >
            {listOpen ? (
              <div className="sched__list-scroll">
                <div className="sched__list-head">
                  <MeasureChip
                    measure={measure}
                    running={running}
                    disabled={running || ready.length === 0}
                    onClick={() => void fetchAll(true, ready)}
                  />
                  <IconButton
                    onClick={() => setListOpen(false)}
                    label="Ocultar lista de materias"
                    className="iconbtn--row"
                  >
                    <PanelLeftClose size={16} strokeWidth={1.75} />
                  </IconButton>
                </div>

                <MeasureProgress running={running} done={done} total={total} />

                <ul className="sched__cards">
                  {rows.map((r) => {
                    const id = itemId(r.item);
                    return (
                      <CourseCard
                        key={id}
                        row={r}
                        onlyOpen={false}
                        compact
                        linkFrom="schedule"
                        selection={{
                          pickedKey: selection[id] ?? null,
                          onPick: (key) => pick(id, key),
                          conflictKeys:
                            selection[id] && conflicts.conflictItems.has(id)
                              ? new Set([selection[id]])
                              : new Set(),
                        }}
                      />
                    );
                  })}
                </ul>
              </div>
            ) : (
              // Con la lista oculta el calendario se queda con todo el
              // ancho —útil en la semana con más materias amontonadas—,
              // pero el control para volver a abrirla no puede irse con
              // ella: queda este riel angosto, no un botón flotante que
              // aparece de la nada.
              <button
                type="button"
                className="sched__rail"
                onClick={() => setListOpen(true)}
                title="Mostrar lista de materias"
                aria-label="Mostrar lista de materias"
              >
                <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </aside>

          <div className="sched__calendar" ref={calendarRef}>
            <WeekCalendar blocks={calendarBlocks} />

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

          <button type="button" className="sched__fab" onClick={viewingList ? jumpToCalendar : jumpToList}>
            {viewingList ? (
              <ChevronUp size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
            {viewingList ? 'ver horario' : 'seleccionar grupos'}
          </button>
        </div>
      )}
    </Layout>
  );
}
