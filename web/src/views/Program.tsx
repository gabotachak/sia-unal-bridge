import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Check,
  CornerUpLeft,
  SlidersHorizontal,
  Ticket,
  TriangleAlert,
  X,
} from 'lucide-react';
import { ApiError, get, routes, STALE_SEATS_SECONDS } from '../api/client';
import type { CourseDetail, CoursesResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { useNow } from '../hooks/useNow';
import { useCatalogFilters } from '../hooks/useCatalogFilters';
import { useCourseDetails } from '../hooks/useCourseDetails';
import { usePlan } from '../hooks/usePlan';
import { useScheduleConflicts } from '../hooks/useScheduleConflicts';
import { useScheduleSelection } from '../hooks/useScheduleSelection';
import { Layout } from '../components/Layout';
import { AppLink } from '../components/AppLink';
import { AvailabilityFields } from '../components/AvailabilityPicker';
import { useConfirm } from '../components/Confirm';
import { CatalogRow } from '../components/CatalogRow';
import { Empty, Fault } from '../components/States';
import { SearchInput } from '../components/SearchInput';
import { TableHead } from '../components/TableHead';
import { Tooltip } from '../components/Tooltip';
import type { PlanAttribution } from '../components/PlanAttributionRow';
import type { TableCol } from '../lib/table';
import { SEATS_RANK, sortBy, type SortKey } from '../lib/sort';
import { useTableSort } from '../hooks/useTableSort';
import { abbreviateEngineering, fold, sentence } from '../lib/format';
import { classifyConflict, type SectionLike } from '../lib/conflicts';
import { putDetails, useDetailCache } from '../lib/detailCache';
import { mergeCatalogs, seatsFromDetail, seatsUnknown, type MergedCourse } from '../lib/catalog';
import { createQueue, pickToMeasure } from '../lib/pooled';
import { MAX_RETRIES, backoffMs, isTransient, sleep } from '../lib/retry';
import {
  DEFAULT_AVAILABILITY,
  courseFitsAvailability,
  isAvailabilityActive,
} from '../lib/availability';
import { itemId, planCodes, planNames, type Selection } from '../lib/storage';
import type { Screen } from '../state/nav';
import './Program.css';

/**
 * Cuántas mediciones automáticas en vuelo. Muy por debajo de `CONCURRENCY`
 * (la de Mi semestre, que sí responde a un botón): esto nadie lo pidió, y del
 * otro lado el carril de fondo de la API es medio pool para TODOS los
 * catálogos abiertos a la vez.
 */
const AUTO_MEASURE_CONCURRENCY = 6;

function scopeOf(s: Selection) {
  return { level: s.level, campus: s.campus, faculty: s.faculty };
}

/**
 * El catálogo de un plan — o de dos, con doble titulación
 * (PLAN-DOUBLE-TITULATION.md). Hasta ~700 asignaturas por plan (Medellín:
 * 694); la unión de dos NO es la suma (D6): comparten cientos de códigos de
 * libre elección.
 *
 * Los filtros son en memoria a propósito: el catálogo completo ya vino en la
 * misma respuesta, así que filtrar en el servidor costaría otra consulta al
 * SIA para mostrar menos de lo que ya tenemos.
 */
export function Program({
  screen,
}: {
  screen: Extract<Screen, { name: 'program' }>;
}) {
  const sel = screen.selection;
  const { level, program } = sel;

  const plan = usePlan();

  /**
   * Qué planes catalogar. Si `sel` es uno de los míos, es MI catálogo —la
   * unión de todos mis planes (D5)—; si es de otro plan, se pinta él solo
   * (Interfaz §5, "Catálogo ajeno"). Nunca los dos criterios a la vez: no
   * hay forma de mezclar un plan ajeno con los propios.
   */
  const mine = plan.owns(sel) ? plan.plans : [sel];

  const { availability } = useCatalogFilters();

  /**
   * Los horarios de los grupos se piden en la MISMA respuesta del catálogo
   * —y solo si hay un horario armado contra el que chocar, o el filtro de
   * horario del catálogo está activo (necesita el mismo detalle para saber
   * qué materia encaja).
   *
   * Antes esto era un prefetch aparte: hasta 40 peticiones de detalle, una
   * por asignatura, elegidas por orden alfabético. Con 200 asignaturas
   * medidas en un plan de Bogotá eso dejaba al 80% del catálogo sin marcar
   * —Turco I entre ellas, la número 194— y pedir las 200 habría sido ~30 s
   * de goteo. En la respuesta del catálogo son ~44 KB sobre 358 KB y cero
   * peticiones de más.
   *
   * Sin nada elegido ni filtro de horario no se pide: no hay con qué
   * chocar ni qué evaluar, así que no habría nada que marcar y sería peso
   * puro.
   */
  const { selection: scheduleSelection } = useScheduleSelection();
  const hasSchedule = Object.keys(scheduleSelection).length > 0;
  const include = hasSchedule || isAvailabilityActive(availability) ? 'schedules' : undefined;

  // Hooks FIJOS, sin condicional: `useApi` acepta `null` y no pide nada —lo
  // mismo que ya hace este archivo para no pedir el directorio sin sede. Con
  // un solo plan, `b` es un hook que nunca dispara nada.
  const a = useApi<CoursesResponse>(routes.courses(scopeOf(mine[0]), mine[0].program, include));
  const b = useApi<CoursesResponse>(
    mine[1] ? routes.courses(scopeOf(mine[1]), mine[1].program, include) : null,
  );

  // "Settled" = ya se sabe qué pasó con esta parte, para bien o para mal.
  // Mientras falte alguna, se muestra el Loading de siempre; en cuanto las
  // que hacían falta contestaron —aunque una haya sido con error— se pinta
  // lo que haya: media lista sirve, ninguna no.
  const settledA = a.data !== null || a.error !== null;
  const settledB = !mine[1] || b.data !== null || b.error !== null;
  const bothSettled = settledA && settledB;
  // `useApi` no borra `data` cuando su `path` pasa a `null` (useApi.ts:73):
  // si `mine[1]` desaparece de un render a otro —de doble a un plan ajeno,
  // sin desmontar esta pantalla— `b.data` se queda con el catálogo VIEJO.
  // `mine[1] &&` es lo que evita que ese resto cuente como si fuera de hoy.
  const anyData = !!a.data || (!!mine[1] && !!b.data);
  const combinedError = a.error ?? (mine[1] ? b.error : null);
  const reload = () => {
    a.reload();
    b.reload();
  };

  const courses = useMemo(
    () =>
      mergeCatalogs(
        mine[1]
          ? [
              { plan: mine[0], courses: a.data?.courses ?? [] },
              { plan: mine[1], courses: b.data?.courses ?? [] },
            ]
          : [{ plan: mine[0], courses: a.data?.courses ?? [] }],
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [a.data, b.data, mine[0], mine[1]],
  );

  /**
   * Los filtros.
   *
   * Tipología y créditos son conjuntos, no un valor: "3 o 4 créditos" y
   * "obligatorias y optativas" son preguntas normales, y con un desplegable de
   * una sola opción había que elegir dos veces y comparar de memoria. Los
   * valores son pocos y fijos —siete tipologías, una decena de créditos— así
   * que caben todos a la vista, con cuántas asignaturas hay en cada uno.
   *
   * Viven en `useCatalogFilters` (Context), no en `useState` local: ir a la
   * ficha de una asignatura desmonta esta pantalla, y sin Context los
   * filtros —y el scroll— se perdían en el viaje de ida y vuelta.
   */
  const {
    q,
    setQ,
    typols,
    setTypols,
    creds,
    setCreds,
    progs,
    setProgs,
    onlyOpen,
    setOnlyOpen,
    hideConflicts,
    setHideConflicts,
    setAvailability,
    showFacets,
    setShowFacets,
    scrollY,
    setScrollY,
  } = useCatalogFilters();

  // `code` alcanza para identificar DENTRO de la unión —D3 obliga a los dos
  // planes a compartir sede, y ahí `code` no colisiona (CLAUDE.md)— pero el
  // `itemId` de cada fila tiene que llevar el plan REAL que la gana (D6), no
  // el de la pantalla desde la que se llegó: es de ahí que sale el
  // `PlanItem` que recibe `AddButton`.
  const courseId = useCallback(
    (c: MergedCourse) =>
      itemId({ level: c.plan.level, campus: c.plan.campus, program: c.plan.program, code: c.code }),
    [],
  );

  /**
   * Mide sola, sin botón, las materias cuya celda de CUPOS está en duda — pero
   * solo las que se están MIRANDO.
   *
   * El criterio sigue siendo `seatsUnknown`, el mismo del filtro "con cupos".
   * Lo que cambió es cuándo: la primera versión medía el catálogo entero al
   * montar, y como nada mantiene los cupos a menos de STALE_SEATS_SECONDS eso
   * eran TODAS las filas — 267 detalles por abrir un plan de Bogotá, ~1000
   * POSTs al SIA, con 32 en vuelo: el pool entero de la API para una persona
   * (docs/internal/FABLE-IMPROVEMENTS.md §3). Ahora una fila se mide cuando entra a la
   * pantalla (el `IntersectionObserver` de más abajo), de a
   * AUTO_MEASURE_CONCURRENCY, por el carril de fondo de la API
   * (`background`), y salir del catálogo suelta lo que no había empezado.
   *
   * Lo medido NO recarga el catálogo: se escribe en `detailCache` y la fila lo
   * lee de ahí. Y se escribe UNA vez por frame, no una por respuesta: cada
   * escritura repinta la lista, y con ocho respuestas por segundo eso era la
   * lista entera rearmándose ocho veces para cambiar ocho celdas.
   *
   * ponytail: cada materia se intenta una vez por visita a esta pantalla. Sin
   * refresco periódico; para volver a medir se entra a la asignatura.
   */
  // Un solo reloj para las edades de toda la lista: cada fila calculaba la suya
  // con Date.now() al pintarse, y como van memoizadas se quedaba congelada
  // ("0 s" diez minutos después de medir).
  const now = useNow(30_000);
  const [measuring, setMeasuring] = useState<ReadonlySet<string>>(new Set());
  const attempted = useRef(new Set<string>());
  const measureQueue = useMemo(() => {
    const arrived: [string, CourseDetail][] = [];
    const finished: string[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      putDetails(arrived.splice(0));
      const done = finished.splice(0);
      setMeasuring((prev) => {
        const next = new Set(prev);
        for (const id of done) next.delete(id);
        return next;
      });
    };

    return createQueue<MergedCourse>(AUTO_MEASURE_CONCURRENCY, async (c) => {
      const id = courseId(c);
      const path = routes.course(
        { level: c.plan.level, campus: c.plan.campus, faculty: c.plan.faculty },
        c.plan.program,
        c.code,
        STALE_SEATS_SECONDS,
        true,
      );

      try {
        /**
         * Los mismos MAX_RETRIES con backoff que usa Mi semestre
         * (`lib/retry.ts`): `sia_noop` y `busy` son el estado de sesión del
         * SIA cediendo, y la petición idéntica, repetida, funciona. El
         * spinner no se apaga entre intentos: sigue en curso.
         *
         * Los reintentos NO fuerzan `max_age=0`. Acá nadie apretó nada:
         * forzar cruzaría FETCH_COOLDOWN y cambiaría un fallo transitorio por
         * un 429 seguro.
         *
         * Agotados los intentos, en silencio: nadie pidió esta medición, y la
         * fila se queda con lo que ya mostraba, que sigue siendo verdad.
         */
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            const res = await get<CourseDetail>(path);
            arrived.push([id, res.data]);
            return;
          } catch (e) {
            if (attempt === MAX_RETRIES) return;
            // El 429 del limitador por IP no encola, rechaza. Un Retry-After
            // largo es el cooldown de la materia, no el balde: ahí se suelta.
            if (e instanceof ApiError && e.status === 429 && (e.retryAfter ?? 1) <= 5) {
              await sleep((e.retryAfter ?? 1) * 1000 + backoffMs(0));
              continue;
            }
            if (!isTransient(e)) return;
            await sleep(backoffMs(attempt));
          }
        }
      } finally {
        finished.push(id);
        if (!frame) frame = requestAnimationFrame(flush);
      }
    });
  }, [courseId]);
  // Salir del catálogo deja de pedir. Lo que ya está en vuelo llega igual y se
  // aprovecha: `detailCache` es de módulo, no de este componente.
  useEffect(() => () => measureQueue.clear(), [measureQueue]);

  /**
   * Mi horario: los bloques ya elegidos, que son contra lo que se mide todo
   * choque del catálogo (issue #28: "Filtro por horario").
   *
   * Es el MISMO `useCourseDetails` que usan Mi semestre y Mi horario, con el
   * mismo pool y el mismo cooldown: entrar al catálogo no dispara nada que
   * esas pantallas no disparen ya solas.
   */
  const { rows: planRows } = useCourseDetails(plan.items);
  const { blocks: chosenBlocks } = useScheduleConflicts(
    planRows,
    scheduleSelection,
  );

  /**
   * Los grupos de cada materia que esta sesión conoce — del plan, de lo que
   * trajo el prefetch, y de cualquier ficha que se haya abierto antes
   * (lib/detailCache.ts). Es la MISMA fuente para el marcado de choques y
   * para el filtro de disponibilidad: dos criterios sobre el mismo dato.
   *
   * Al volver al catálogo esto ya viene lleno, así que las marcas aparecen
   * con la página, sin pedirle nada al back.
   */
  const detailCache = useDetailCache();
  const sectionsById = useMemo(() => {
    const map: Record<string, SectionLike[]> = {};
    // 1. Lo que vino en la respuesta del catálogo: todas las asignaturas
    //    cuyo detalle alguien pidió alguna vez, con `?include=schedules`.
    for (const c of courses) {
      if (c.section_schedules) map[courseId(c)] = c.section_schedules;
    }
    // 2. Y encima, lo que esta sesión trajo con más detalle —cupos por
    //    grupo incluidos, que es lo que mira el chip "con cupos"—: el plan,
    //    y cualquier ficha que se haya abierto (lib/detailCache.ts).
    for (const [id, detail] of detailCache) map[id] = detail.sections;
    for (const row of planRows) {
      if (row.detail) map[itemId(row.item)] = row.detail.sections;
    }
    return map;
  }, [courses, courseId, detailCache, planRows]);

  /**
   * Rojo, amarillo o nada para cada materia — una sola pasada, un solo
   * criterio (`classifyConflict`, lib/conflicts.ts, testeado caso por caso).
   *
   * Antes esto eran dos ramas de un `useMemo` más un tercer bucle sobre las
   * materias cacheadas, y ese tercer bucle podía marcar en amarillo una
   * materia que YA tenía grupo elegido y sin choque. Ahora cada materia se
   * clasifica una vez, con lo que se sepa de ella, venga de donde venga.
   */
  const conflictCourseIds = useMemo(() => {
    const active = new Set<string>();
    const potential = new Set<string>();
    if (chosenBlocks.length === 0) return { active, potential };

    for (const c of courses) {
      const id = courseId(c);
      const mark = classifyConflict({
        itemId: id,
        sections: sectionsById[id],
        pickedKey: scheduleSelection[id],
        chosenBlocks,
        onlyOpen,
      });
      if (mark === 'active') active.add(id);
      else if (mark === 'potential') potential.add(id);
    }
    return { active, potential };
  }, [courses, courseId, sectionsById, scheduleSelection, chosenBlocks, onlyOpen]);

  /**
   * Restaura el scroll UNA vez, apenas hay filas que pintar — antes de eso
   * la página mide menos alto que el que tenía cuando se guardó, y
   * `scrollTo` cae corto.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || courses.length === 0) return;
    restored.current = true;
    if (scrollY > 0) window.scrollTo(0, scrollY);
  }, [courses, scrollY]);

  /**
   * Guarda el scroll EN CADA scroll, no al desmontar.
   *
   * Se probó al desmontar primero y no servía: el cleanup de un efecto
   * corre después de que React ya pintó la pantalla siguiente, y para
   * cuando por fin se ejecutaba, el navegador ya había reflowado con la
   * página nueva —más corta— y `window.scrollY` ya no era el de acá, sino
   * el que el navegador recortó solo. Escuchando el scroll en vivo, el
   * valor guardado siempre es el último real de ESTA pantalla, tomado
   * mientras todavía existía.
   */
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrollY(window.scrollY);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [setScrollY]);

  // Los valores que EXISTEN en este plan, con su cuenta. Nada de listas fijas:
  // Medellín llega a 12 créditos y Bogotá no pasa de 6.
  const facets = useMemo(() => {
    const byTypology = new Map<string, number>();
    const byCredits = new Map<number, number>();
    const byProgram = new Map<string, number>();
    for (const c of courses) {
      if (c.typology)
        byTypology.set(c.typology, (byTypology.get(c.typology) ?? 0) + 1);
      byCredits.set(c.credits, (byCredits.get(c.credits) ?? 0) + 1);
      byProgram.set(c.plan.program, (byProgram.get(c.plan.program) ?? 0) + 1);
      if (c.alsoIn)
        byProgram.set(
          c.alsoIn.plan.program,
          (byProgram.get(c.alsoIn.plan.program) ?? 0) + 1,
        );
    }
    return {
      typologies: [...byTypology.keys()].sort((a, b) =>
        a.localeCompare(b, 'es'),
      ),
      credits: [...byCredits.keys()].sort((a, b) => a - b),
      byTypology,
      byCredits,
      byProgram,
    };
  }, [courses]);

  /**
   * El catálogo con los cupos que ESTA sesión ya midió encima.
   *
   * Una sola vez, acá, y no en cada sitio que los mire: la celda, el orden
   * por cupos y el filtro "con cupos" tienen que estar viendo el mismo
   * número. Cuando la celda leía lo medido pero el filtro seguía leyendo el
   * catálogo, una materia podía decir "0 cupos" y quedarse igual dentro de
   * "con cupos" —el filtro la creía incógnita, que es lo que era un segundo
   * antes—.
   *
   * Los dos campos se toman del MISMO objeto, nunca mezclados: un `seats`
   * nuevo con un sello viejo pintaría una edad que no le corresponde.
   */
  const mergedSeats = useRef(new WeakMap<MergedCourse, { from: CourseDetail; row: MergedCourse }>());
  const withSeats = useMemo(
    () =>
      detailCache.size === 0
        ? courses
        : courses.map((c) => {
            const m = detailCache.get(courseId(c));
            if (!m) return c;
            // El MISMO objeto mientras ni la fila ni su detalle cambien: las
            // filas van memoizadas, y un `{...c}` nuevo por cada materia
            // medida, en cada escritura, las repintaba a todas.
            const known = mergedSeats.current.get(c);
            if (known?.from === m) return known.row;
            // `seatsFromDetail` de respaldo: una API anterior no manda el
            // agregado en el detalle (lib/catalog.ts). Igual con el sello.
            const row = {
              ...c,
              seats: m.seats ?? seatsFromDetail(m),
              detail_fetched_at: m.detail_fetched_at ?? m.fetched_at,
            };
            mergedSeats.current.set(c, { from: m, row });
            return row;
          }),
    [courses, courseId, detailCache],
  );

  /** Se recuerda entre visitas. `null` = como lo mandó el SIA, ya alfabético. */
  const { sort, onSort } = useTableSort('catalog');

  const shown = useMemo(() => {
    const needle = fold(q);
    const kept = withSeats.filter((c) => {
      if (
        needle &&
        !fold(c.name).includes(needle) &&
        !fold(c.code).includes(needle)
      )
        return false;
      if (typols.size && !typols.has(c.typology)) return false;
      if (creds.size && !creds.has(c.credits)) return false;
      if (
        progs.size &&
        !progs.has(c.plan.program) &&
        !(c.alsoIn && progs.has(c.alsoIn.plan.program))
      )
        return false;
      if (onlyOpen && !hasRoom(c)) return false;
      if (hideConflicts) {
        const id = courseId(c);
        if (
          conflictCourseIds.active.has(id) ||
          conflictCourseIds.potential.has(id)
        )
          return false;
      }
      if (isAvailabilityActive(availability)) {
        // Sin detalle a mano no se puede saber si encaja — se cae del
        // filtro en vez de mostrarse sin marcar, porque acá el punto ES
        // filtrar: enseñar una materia que podría no encajar rompería la
        // confianza en el resultado.
        const sections = sectionsById[courseId(c)];
        if (!sections || !courseFitsAvailability(sections, availability))
          return false;
      }
      return true;
    });
    return sort ? sortBy(kept, (c) => sortKeyOf(c, sort.col), sort.dir) : kept;
  }, [
    withSeats,
    q,
    typols,
    creds,
    progs,
    onlyOpen,
    hideConflicts,
    conflictCourseIds,
    availability,
    sectionsById,
    courseId,
    sort,
  ]);

  /**
   * Quién se mide: la fila en duda que entra a la pantalla (con margen, para
   * que al hacer scroll el número ya esté). Una sola vez por materia.
   */
  const listRef = useRef<HTMLUListElement>(null);
  const unknownById = useMemo(() => {
    const map = new Map<string, MergedCourse>();
    for (const c of shown) if (seatsUnknown(c)) map.set(courseId(c), c);
    return map;
  }, [shown, courseId]);
  useEffect(() => {
    const list = listRef.current;
    if (!list || unknownById.size === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible: string[] = [];
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          visible.push((e.target as HTMLElement).dataset.cid ?? '');
        }
        const picked = pickToMeasure(visible, unknownById, attempted.current);
        for (const c of picked) measureQueue.push(c);
        const queued = picked.map(courseId);
        if (queued.length) setMeasuring((prev) => new Set([...prev, ...queued]));
      },
      { rootMargin: '400px 0px' },
    );
    for (const li of list.children) {
      const id = (li as HTMLElement).dataset.cid;
      if (id && unknownById.has(id) && !attempted.current.has(id)) io.observe(li);
    }
    return () => io.disconnect();
  }, [unknownById, measureQueue, courseId]);

  const total = courses.length;
  const facetCount =
    typols.size + creds.size + progs.size + (isAvailabilityActive(availability) ? 1 : 0);
  const filtering = !!q || facetCount > 0 || onlyOpen || hideConflicts;

  /**
   * Libre elección aparte del resto, con un atajo al lado.
   *
   * Es la tipología más numerosa con diferencia (215 de 694 en este plan) y
   * la que casi nadie busca junto con las demás: se arma el semestre con las
   * obligatorias y optativas del plan, y las libres se miran aparte —o se
   * excluyen de un toque, que es lo que da el chip sintético. No es una
   * tipología real del SIA: es `nonLibreTypologies` completo, así que
   * alternarlo compone con el resto de chips igual que cualquier selección
   * manual.
   */
  const libreTypology = facets.typologies.find((t) => t.startsWith('LIBRE'));
  const nonLibreTypologies = facets.typologies.filter(
    (t) => !t.startsWith('LIBRE'),
  );
  const notLibreActive =
    nonLibreTypologies.length > 0 &&
    typols.size === nonLibreTypologies.length &&
    nonLibreTypologies.every((t) => typols.has(t));
  const notLibreCount = nonLibreTypologies.reduce(
    (n, t) => n + (facets.byTypology.get(t) ?? 0),
    0,
  );
  function toggleNotLibre() {
    pickTypology(notLibreActive ? new Set() : new Set(nonLibreTypologies));
  }

  /**
   * Marcar TODAS las tipologías filtra exactamente igual que no marcar
   * ninguna —`typols.has(c.typology)` no excluye a nadie de cualquiera de
   * las dos formas— así que dejarlas todas en verde mentía: parecía un
   * filtro fuerte ("filtros 7") cuando en la lista de abajo no faltaba
   * nada. Elegir la última que cierra el conjunto completo lo vacía en vez
   * de completarlo — vuelve al estado real: sin filtro.
   */
  function pickTypology(
    next:
      | ReadonlySet<string>
      | ((prev: ReadonlySet<string>) => ReadonlySet<string>),
  ) {
    setTypols((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      return resolved.size === facets.typologies.length &&
        facets.typologies.length > 0
        ? new Set()
        : resolved;
    });
  }

  /**
   * Mismo truco que `pickTypology`: con doble titulación solo hay dos
   * carreras posibles, y marcar las dos filtra igual que no marcar
   * ninguna —así que elegir la segunda vacía el filtro en vez de sumarla.
   */
  function pickProgram(
    next:
      | ReadonlySet<string>
      | ((prev: ReadonlySet<string>) => ReadonlySet<string>),
  ) {
    setProgs((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      return resolved.size === mine.length && mine.length > 1 ? new Set() : resolved;
    });
  }

  function clearAll() {
    setQ('');
    setTypols(new Set());
    setCreds(new Set());
    setProgs(new Set());
    setOnlyOpen(false);
    setHideConflicts(false);
    setAvailability(DEFAULT_AVAILABILITY);
  }

  // El código y la tipología de un plan que se le enseñan al usuario, no la
  // que decide `mergeCatalogs` (D6): esa manda para saber qué grupos se ven
  // y qué tipología cuenta créditos — no puede cambiar con un filtro. Pero
  // mostrar SIEMPRE al mismo plan "ganador" mientras alguien filtra por el
  // OTRO se leía como que el catálogo se contradice con su propio filtro.
  // Acá se decide solo lo que se PINTA:
  //   - libre elección compartida entre los dos: ninguno "gana" de verdad
  //     (misma tipología en los dos), así que se enseñan los dos.
  //   - si no, y hay un solo plan filtrado, ESE se enseña primero.
  const filterProgram = progs.size === 1 ? [...progs][0] : null;

  function attributionOf(c: MergedCourse) {
    let primary: PlanAttribution = { plan: c.plan, typology: c.typology };
    if (!c.alsoIn) return { primary, secondary: undefined };
    let secondary: PlanAttribution = { plan: c.alsoIn.plan, typology: c.alsoIn.typology };
    // El filtro manda sobre la prioridad de D6: quien filtra por un plan
    // quiere VERLO primero, así rompa el desempate por rango.
    if (filterProgram && secondary.plan.program === filterProgram && primary.plan.program !== filterProgram) {
      [primary, secondary] = [secondary, primary];
    }
    return { primary, secondary };
  }

  /**
   * El plan de esta pantalla contra MIS planes.
   *
   * Casi siempre `sel` es uno de los míos. La excepción es llegar acá desde
   * un candidato de un 300 ambiguo (ver Fault en States.tsx) sin haber
   * confirmado el cambio, o mirar el plan de otra persona: ahí `sel` es el
   * plan que se está MIRANDO y no está entre `plan.plans`. No se toca nada
   * por las malas — se avisa y se deja decidir, porque cambiar de verdad
   * borra el semestre.
   *
   * `plan` en sí ya se trajo arriba, para el choque de horario y para saber
   * qué catalogar (`mine`).
   */
  const [ask, confirmDialog] = useConfirm();
  const foreign = plan.selection !== null && !plan.owns(sel);
  const double = plan.plans.length > 1;

  async function adoptThis() {
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
              semestre, porque {n === 1 ? 'es' : 'son'}{' '}
              {double ? (
                <>
                  de los planes <b>{planNames(plan.plans)}</b>
                </>
              ) : (
                <>
                  del plan <b>{planNames(plan.plans)}</b>
                </>
              )}
              .
            </p>
            <p>Sus grupos y su tipología son de {double ? 'esos planes' : 'ese plan'}, no de este.</p>
          </>
        ),
      });
      if (!ok) return;
    }
    // `[sel]` siempre pasa la validación de `planSelection` —es un solo
    // plan—, pero se revisa igual: es el único sitio de la app que llama a
    // `select()` sin que el picker ya haya impedido de antemano un
    // resultado inválido.
    const ok = plan.select([sel]);
    if (!ok) return;
  }

  const planEyebrow = planCodes(mine);

  return (
    <Layout>
      {confirmDialog}
      {foreign && (
        <div className="stray" role="status">
          <p className="stray__text">
            Estás mirando el plan <b>{program}</b>, y{' '}
            {double ? (
              <>
                los tuyos son <b>{planNames(plan.plans)}</b>
              </>
            ) : (
              <>
                el tuyo es <b>{abbreviateEngineering(plan.selection?.programName ?? '')}</b>
              </>
            )}
            . Puedes mirar todo lo que quieras, pero para agregar materias al semestre tienes que
            estar en {double ? 'uno de tus planes' : 'tu plan'}.
          </p>
          <div className="stray__actions">
            {plan.selection && (
              <AppLink className="btn" to={{ name: 'program', selection: plan.selection }}>
                <CornerUpLeft size={15} strokeWidth={1.75} aria-hidden="true" />
                volver al mío
              </AppLink>
            )}
            <button className="btn btn--ghost" onClick={adoptThis}>
              <ArrowLeftRight size={15} strokeWidth={1.75} aria-hidden="true" />
              cambiarme a este
            </button>
          </div>
        </div>
      )}

      <header className="head">
        <div>
          <p className="eyebrow">plan {planEyebrow}</p>
          <h1 className="head__title">Catálogo</h1>
        </div>
        {total > 0 && (
          <p className="head__meta tnum">
            {shown.length === total
              ? `${total} asignaturas`
              : `${shown.length} de ${total}`}
          </p>
        )}
      </header>

      {/* Skeleton: el catálogo tarda entre 3 y 8 s en un miss frío.
          En vez de bloquear toda la pantalla con un Loading centrado, se
          pintan filas fantasmas sobre la MISMA rejilla que las reales, con
          la cabecera de verdad encima: el número de columnas no cambia y el
          layout no salta cuando llegan los datos.

          Cada pastilla lleva su `col-*` como la celda que imita. No es
          decorativo: bajo 38rem, 35rem y 31.5rem la rejilla suelta columnas
          y esas clases son lo único que las esconde (styles/table.css). Sin
          ellas, seis pastillas en una rejilla de tres se desbordaban a
          renglones de más, y el skeleton dibujaba una tabla que no existe.

          `aria-busy` y `aria-label` van en el <ul>: un solo anuncio para la
          espera entera, en vez de quince filas vacías que leer. */}
      {!bothSettled && !anyData && (
        <div className="table">
          <TableHead sort={sort} onSort={onSort} />
          <ul className="rows" aria-busy="true" aria-label="Cargando el catálogo…">
            {catalogSkeletonRows.map((widths, i) => (
              <li key={i} className="table__row row--skeleton" aria-hidden="true">
                {/* código — --t-micro */}
                <span className="skel skel--sm col-code" style={{ width: widths[0] }} />
                {/* nombre — --t-body */}
                <span className="skel" style={{ width: widths[1] }} />
                {/* tipología */}
                <span className="skel skel--tag col-typ" />
                {/* créditos */}
                <span
                  className="skel skel--sm col-cr"
                  style={{ width: '1.2rem', marginLeft: 'auto' }}
                />
                {/* cupos */}
                <span
                  className="skel col-seats"
                  style={{ width: widths[2], marginLeft: 'auto' }}
                />
                {/* acción */}
                <span className="skel skel--tag" style={{ marginLeft: 'auto', opacity: 0.4 }} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {anyData && (
        <>
          <div className="toolbar">
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Buscar por nombre o código…"
              label="Buscar asignatura"
              className="search--flex"
            />

            {/* El filtro que más se usa va arriba y solo: es una pregunta de
                sí o no —"¿puedo meterme hoy?"— y no compite con las otras. */}
            <Tooltip
              content={
                <p className="tt-body">
                  Deja solo las que tienen cupo. Las que nunca se han consultado
                  también se quedan: es mejor que sobre una a que se pierda una
                  con cupos.
                </p>
              }
            >
              <button
                className={`chip ${onlyOpen ? 'is-on' : ''}`}
                onClick={() => setOnlyOpen((v) => !v)}
                aria-pressed={onlyOpen}
              >
                {onlyOpen ? (
                  <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  <Ticket size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
                con cupos
              </button>
            </Tooltip>

            {/* Al lado de "con cupos": la misma pregunta de sí o no, pero de
                horario en vez de cupo. Destacar el choque (ver `.row.is-conflict`
                más abajo) queda siempre puesto; este chip es solo para quien
                además quiere que desaparezcan de la lista (issue #28). */}
            <Tooltip
              content={
                <p className="tt-body">
                  Oculta las materias a las que ya no les sirve ningún grupo, y
                  aquellas cuyo grupo elegido choca con Mi horario. Se destacan
                  igual en la lista mientras este chip está apagado.
                </p>
              }
            >
              <button
                className={`chip ${hideConflicts ? 'is-on' : ''}`}
                onClick={() => setHideConflicts((v) => !v)}
                aria-pressed={hideConflicts}
              >
                {hideConflicts ? (
                  <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  <TriangleAlert
                    size={14}
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                )}
                sin choques
              </button>
            </Tooltip>

            {/* Solo se ve en el teléfono (CSS). El número es lo que evita que
                plegar esconda información: dice cuántas facetas hay puestas
                sin tener que abrir a mirar. */}
            <button
              className={`chip filters__toggle ${facetCount ? 'is-on' : ''}`}
              onClick={() => setShowFacets((v) => !v)}
              aria-expanded={showFacets}
              aria-controls="facetas"
            >
              <SlidersHorizontal
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
              />
              filtros
              {facetCount > 0 && (
                <span className="chip__code tnum">{facetCount}</span>
              )}
            </button>

            {filtering && (
              <Tooltip content={<p className="tt-title">Quitar los filtros</p>}>
                <button
                  className="toolbar__clear"
                  onClick={clearAll}
                  aria-label="Quitar los filtros"
                >
                  <X size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
          </div>

          <div
            className={`filters ${showFacets ? 'is-open' : ''}`}
            id="facetas"
          >
            {/* Solo con doble titulación (D6): elegir una carrera deja solo
                lo que cuenta para ella —lo compartido entre las dos sigue
                saliendo—, y marcar las dos es lo mismo que no marcar
                ninguna, igual que "todas menos libre elección". */}
            {mine.length > 1 && (
              <div className="filters__row">
                <span className="filters__label">carrera</span>
                <div className="chips">
                  {mine.map((m) => (
                    <button
                      key={m.program}
                      className={`chip chip--sm ${progs.has(m.program) ? 'is-on' : ''}`}
                      onClick={() => pickProgram((s) => toggle(s, m.program))}
                      aria-pressed={progs.has(m.program)}
                    >
                      {abbreviateEngineering(sentence(m.programName))}
                      <span className="chip__code tnum">
                        {facets.byProgram.get(m.program) ?? 0}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="filters__row">
              <span className="filters__label">tipología</span>
              <div className="chips">
                {nonLibreTypologies.map((t) => (
                  <Tooltip
                    key={t}
                    content={
                      <>
                        <p className="tt-eyebrow">Tipología</p>
                        <p className="tt-title">{t}</p>
                      </>
                    }
                  >
                    <button
                      className={`chip chip--sm ${typols.has(t) ? 'is-on' : ''}`}
                      onClick={() => pickTypology((s) => toggle(s, t))}
                      aria-pressed={typols.has(t)}
                    >
                      {sentence(t.replace(/\s*\([^)]*\)\s*$/, ''))}
                      <span className="chip__code tnum">
                        {facets.byTypology.get(t)}
                      </span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>

            {/* Aparte del resto: no es una tipología más entre siete, es la
                pregunta "¿libres sí o no?", binaria. */}
            <div className="filters__row">
              <span className="filters__label">electivas</span>
              <div className="chips">
                {libreTypology && (
                  <Tooltip
                    content={
                      <>
                        <p className="tt-eyebrow">Tipología</p>
                        <p className="tt-title">{libreTypology}</p>
                      </>
                    }
                  >
                    <button
                      className={`chip chip--sm ${typols.has(libreTypology) ? 'is-on' : ''}`}
                      onClick={() =>
                        pickTypology((s) => toggle(s, libreTypology))
                      }
                      aria-pressed={typols.has(libreTypology)}
                    >
                      {sentence(libreTypology.replace(/\s*\([^)]*\)\s*$/, ''))}
                      <span className="chip__code tnum">
                        {facets.byTypology.get(libreTypology)}
                      </span>
                    </button>
                  </Tooltip>
                )}
                {nonLibreTypologies.length > 0 && (
                  <Tooltip
                    content={
                      <p className="tt-body">
                        Todas las tipologías del plan menos libre elección.
                      </p>
                    }
                  >
                    <button
                      className={`chip chip--sm ${notLibreActive ? 'is-on' : ''}`}
                      onClick={toggleNotLibre}
                      aria-pressed={notLibreActive}
                    >
                      Todas menos libre elección
                      <span className="chip__code tnum">{notLibreCount}</span>
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>

            <div className="filters__row">
              <span className="filters__label">créditos</span>
              <div className="chips">
                {facets.credits.map((n) => (
                  <Tooltip
                    key={n}
                    content={
                      <p className="tt-title">
                        {n} {n === 1 ? 'crédito' : 'créditos'}
                      </p>
                    }
                  >
                    <button
                      className={`chip chip--sm ${creds.has(n) ? 'is-on' : ''}`}
                      onClick={() => setCreds((s) => toggle(s, n))}
                      aria-pressed={creds.has(n)}
                    >
                      <span className="tnum">{n}</span>
                      <span className="chip__code tnum">
                        {facets.byCredits.get(n)}
                      </span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>

            {/* "Cuándo puedo": la misma pregunta que tipología o créditos
                —"¿qué se queda en la lista?"— aplicada al horario que se
                está armando, no una caja aparte. */}
            <div className="filters__row">
              <span className="filters__label">horario</span>
              <AvailabilityFields
                value={availability}
                onChange={setAvailability}
              />
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
              <TableHead sort={sort} onSort={onSort} />

              <ul className="rows" ref={listRef}>
                {shown.map((c) => {
                  const id = courseId(c);
                  return (
                    <CatalogRow
                      key={c.code}
                      c={c}
                      id={id}
                      // Rojo: el grupo YA elegido choca — un bloqueo real. Ocre:
                      // todavía no elegiste grupo y NINGUNO de los que hay te
                      // sirve — un aviso, antes de comprometerte.
                      conflict={
                        conflictCourseIds.active.has(id)
                          ? 'active'
                          : conflictCourseIds.potential.has(id)
                            ? 'potential'
                            : null
                      }
                      // Solo con doble titulación: con un plan son `null` y
                      // `undefined` fijos, y la fila memoizada no se repinta.
                      attr={mine.length > 1 ? attributionOf(c) : null}
                      plans={mine.length > 1 ? mine : undefined}
                      measuring={measuring.has(id)}
                      now={now}
                    />
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}

      {/* Después de la tabla, no antes: con doble titulación, si un plan
          respondió y el otro no, esto se pinta DEBAJO de lo que sí hay —
          "media lista sirve, ninguna no" (interfaz §2). Con los dos
          fallidos es lo único que queda por mostrar. */}
      {combinedError && <Fault error={combinedError} level={level} onRetry={reload} />}
    </Layout>
  );
}

/**
 * Por qué se ordena cada columna. Cupos es la única con matiz: los cuatro
 * estados de la celda caen en una sola recta según SEATS_RANK.
 */
function sortKeyOf(c: MergedCourse, col: TableCol): SortKey {
  switch (col) {
    case 'code':
      return c.code;
    case 'name':
      return c.name;
    case 'typology':
      return c.typology;
    case 'credits':
      return c.credits;
    case 'seats':
      // Una fila que MUESTRA un número —aunque esté vencido— cae donde dice
      // ese número; incógnita es solo la que pinta el signo de pregunta.
      if (!c.seats && seatsUnknown(c)) return SEATS_RANK.unknown;
      // Sin cupos y con sello fresco: se preguntó y no hay grupos. El cero
      // es un dato, no una incógnita.
      if (!c.seats) return SEATS_RANK.noOffer;
      return c.seats.available === 0 ? SEATS_RANK.full : c.seats.available;
  }
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
function hasRoom(c: MergedCourse): boolean {
  if (seatsUnknown(c)) return true;
  return (c.seats?.available ?? 0) > 0;
}

/**
 * Anchos de las pastillas skeleton de cada fila del catálogo mientras carga.
 * Tres valores por fila: [código, nombre, cupos]. El nombre varía entre el
 * 35 % y el 80 % del ancho disponible para que las filas no parezcan clones.
 * Constante de módulo: no se recrea en cada render.
 */
const catalogSkeletonRows: [string, string, string][] = [
  ['4.5rem', '72%', '3rem'],
  ['5rem',   '55%', '2.5rem'],
  ['4rem',   '80%', '3.5rem'],
  ['5.5rem', '45%', '2rem'],
  ['4.5rem', '68%', '3rem'],
  ['5rem',   '38%', '2.5rem'],
  ['4rem',   '76%', '3rem'],
  ['5.5rem', '60%', '3.5rem'],
  ['4.5rem', '50%', '2rem'],
  ['5rem',   '82%', '3rem'],
  ['4rem',   '42%', '2.5rem'],
  ['5.5rem', '65%', '3rem'],
  ['4.5rem', '35%', '2rem'],
  ['5rem',   '78%', '3.5rem'],
  ['4rem',   '58%', '3rem'],
];
