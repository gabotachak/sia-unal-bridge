# Plan: doble titulación

Cómo el tablero deja de asumir **un** plan de estudios por persona sin volverse más
complicado para quien solo tiene uno.

Hermano de [`PLAN-FRONTEND.md`](PLAN-FRONTEND.md), mismo formato: fases con criterio de
aceptación. Escrito para que lo ejecute otro modelo sin volver a leer todo `web/src/`,
así que cada decisión trae el archivo y la línea donde vive hoy.

> **Estado: propuesto.** Nada de esto está implementado. La rama es
> `feature/double-titulation`.

---

## El problema

Un estudiante de doble titulación cursa asignaturas de **dos planes distintos en el
mismo semestre**. Su horario es uno solo: las clases de los dos planes compiten por los
mismos bloques de la semana, y el choque entre un grupo del plan A y uno del plan B es
exactamente el conflicto que más le importa resolver.

El tablero hoy no lo deja ni intentarlo:

| Dónde | Qué pasa | Archivo |
|---|---|---|
| Elegir plan | Cambiar de plan **borra Mi semestre entero** | `web/src/state/PlanProvider.tsx:78-87` |
| Botón `+` | Se apaga en cualquier asignatura que no sea del plan elegido | `web/src/components/AddButton.tsx:22` |
| Catálogo ajeno | Aviso "para agregar materias tienes que estar en tu plan" | `web/src/views/Program.tsx:415-433` |
| Barra | El chip del plan es singular, y al tocarlo borra todo | `web/src/components/Topbar.tsx:104-112` |

O sea: la única forma de mirar el otro plan es perder el semestre armado. Para esta
persona el producto es inservible, y es justo la persona con el horario más difícil de
armar — la que más falta le hace.

**Cuántos son**: minoría clara. Todo lo que sigue está subordinado a una regla: **con un
solo plan, la interfaz no puede cambiar en nada visible**. Ni un control nuevo, ni un
clic más, ni una etiqueta de más. Lo que la mayoría ve hoy es lo que tiene que seguir
viendo.

---

## Por qué esto es casi gratis

La parte cara ya está hecha, sin querer. **El estado del semestre ya está etiquetado por
plan, asignatura por asignatura**:

```ts
// web/src/lib/storage.ts:26-36
export type PlanItem = {
  level: string;    // 'pregrado'
  campus: string;   // '1101'
  program: string;  // '2A74'   ← acá
  faculty: string;  // '2055'
  code: string;     // '1000003-B'
  ...
};

// web/src/lib/storage.ts:75-77 — y la identidad ya lo incluye
export function itemId(i) {
  return `${i.level}/${i.campus}/${i.program}/${i.code}`;
}
```

Consecuencias, todas verificadas leyendo el código:

- **`plan.items` ya puede contener materias de dos planes a la vez.** Nada en la lista
  asume que compartan `program`. Lo único que lo impide es el guardia de
  `AddButton.tsx:22`, que es un `if`.
- **Los cupos se piden con el `scope` de cada item, no con el del plan elegido**
  (`useCourseDetails.ts:127-129`: `{ level: item.level, campus: item.campus, faculty:
  item.faculty }`). Medir una lista mezclada ya funciona hoy, sin tocar una línea.
- **El choque de horarios ya es cross-plan.** `computeConflicts` compara por `itemId`
  (`conflicts.ts:36`), que lleva el plan adentro: dos materias de planes distintos son
  `itemId` distintos, así que se comparan entre sí como cualquier otro par. **La función
  estrella de la feature sale gratis.**
- **El grupo elegido por materia** (`ScheduleSelection`, `storage.ts:175`) está indexado
  por `itemId` → también es por plan, sin colisiones.
- **El calendario, el `.ics`, el filtro de disponibilidad y el marcado de choques en el
  catálogo** operan sobre `plan.items` y `itemId`. Ninguno pregunta por el plan.
- **El backend no se toca. La API no se toca. `openapi.yaml` no se toca.** El catálogo
  del segundo plan es una llamada más a `/v1/campuses/{campus}/programs/{program}/courses`
  con otro `program`, que la API ya cachea igual que cualquier otra.

Lo único genuinamente singular es **`Selection`**: el plan elegido
(`storage.ts:89-108`), que hoy es un objeto o `null`. Todo el trabajo de esta feature es
convertir ese objeto en una lista corta y quitar los cuatro guardias de la tabla de
arriba.

---

## Decisiones

Cada una con la alternativa que se descartó, para que nadie la reabra a mitad de camino.

### D1 · `Selection` pasa a ser lista, y `plan.selection` sobrevive intacto

`PlanApi` gana `plans: Selection[]`, y **`selection` se queda** como el plan *activo*
(`plans[i]` donde `i` es el activo). Es un cambio aditivo: los ~10 sitios que hoy leen
`plan.selection` —`Topbar`, `TabBar`, `Donate`, `Semester`, `Schedule`, `NavProvider`—
siguen compilando y comportándose igual.

> Descartado: renombrar `selection` a `activePlan` y tocar los 10 sitios. Diff más
> grande, cero beneficio.

### D2 · Tope de **2** planes

Doble titulación son dos. El tope se defiende igual que `MAX_ITEMS`
(`planContext.ts:6`): con el mismo patrón de botón apagado + tooltip que ya existe en
`AddButton`. Para agregar un tercero hay que quitar uno.

```ts
// ponytail: tope duro de 2, sube a N cambiando la constante si aparece el caso
export const MAX_PLANS = 2;
```

> Descartado: sin tope. La barra se llena de chips, el desglose de créditos deja de
> caber, y no hay ningún caso real detrás.

### D3 · Cambiar de plan **no borra nada**. Quitar un plan borra **solo lo suyo**

Es el corazón del cambio. Hoy `select()` limpia `items` al detectar otro plan
(`PlanProvider.tsx:78-87`). En el modelo nuevo:

| Acción | Efecto sobre `items` |
|---|---|
| Activar otro de mis planes | **ninguno** |
| Agregar un plan | **ninguno** |
| Quitar un plan | borra solo los `items` de ese plan (`selectionId(i) === id`) |
| Empezar de nuevo | borra todo, como hoy |

El diálogo destructivo de `PlanPicker.choose()` (`PlanPicker.tsx:110-130`) **desaparece
del camino de agregar** y reaparece, con el mismo `useConfirm`, en quitar un plan. Neto:
una destrucción menos, no una más.

### D4 · El tope de materias sigue siendo **10 en total**, no 10 por plan

`MAX_ITEMS = 10` es un presupuesto de mediciones contra el SIA (una petición de detalle
por materia), no una cuota académica. Duplicarlo por tener dos planes duplicaría el
costo del botón "medir cupos" y el tiempo de la ronda. 10 alcanzan de sobra para un
semestre de doble titulación (~7-8 materias).

### D5 · Una asignatura, un plan: no se agrega dos veces el mismo `code`

El mismo código puede existir en los dos planes (un cálculo compartido). Agregarlo dos
veces contaría los créditos dos veces y pintaría dos bloques idénticos en el calendario,
cuando la persona la va a inscribir **por un solo plan**.

El guardia va **en `PlanProvider.add()`**, no en el botón: `AddButton` es un caller
entre varios (la ficha de la materia también agrega), y el `add` es por donde pasan
todos. El botón solo *refleja* el bloqueo en su tooltip, igual que ya hace con
`plan.full`.

> Descartado: permitirlo y descontar el duplicado del total de créditos. Magia
> invisible: el número de la cabecera dejaría de ser la suma de lo que se ve.

### D6 · El plan activo es "el catálogo que estás mirando", y se fija solo

No hay un selector de plan activo aparte. Abrir el catálogo de un plan lo vuelve el
activo. El chip de la barra muestra cuál es. El único efecto de "activo" es a qué
catálogo apunta el icono de la barra y con qué plan abre la app (`NavProvider.tsx:25-27`).

Se guarda como `active: string` (un `selectionId`), no como índice: los índices se
corrompen al quitar un plan. Y el **orden de los chips no cambia al activar** — reordenar
por uso haría saltar de sitio el chip que acabás de tocar.

### D7 · Una sola tabla en Mi semestre, con la sigla del plan por fila

Con dos planes, Mi semestre y Mi horario mezclan materias de los dos. No se agrupa por
plan ni se parte la tabla: se agrega un chip con el código del plan en cada tarjeta,
**y solo si `plans.length > 1`**. Con un plan, la tarjeta es byte por byte la de hoy.

> Descartado: secciones por plan, y un filtro "solo plan A". Sobre 10 filas, ambos son
> andamio. Se agregan si alguien los pide.

### D8 · Los créditos siguen sumando en global, y el desglose por plan va al tooltip

`CreditsBadge` muestra el total de todo el semestre y el semáforo de los estatutos con
los mismos umbrales de hoy (`credits.ts:10,16`). El tooltip, que ya despliega el
desglose por tipología, gana un desglose por plan cuando hay dos.

**Lo que NO se hace: aplicar el semáforo por plan.** No sabemos si los mínimos de 6 y 10
créditos se exigen por plan de estudios o sobre la inscripción completa — ver
[Preguntas abiertas](#preguntas-abiertas). Inventarlo sería pintar de rojo un semestre
válido, y este badge es informativo por diseño: nunca bloquea nada.

---

## El modelo de estado nuevo

### `web/src/lib/storage.ts`

`Selection` y `selectionId` **no cambian**. Cambia solo qué se guarda:

```ts
/** v2: varios planes. La v1 guardaba un solo objeto Selection. */
const PICK_KEY = 'tablero.planes.v2';
/** La clave vieja, que solo se lee para migrar. */
const PICK_KEY_V1 = 'tablero.plan.v1';

export type Plans = {
  /** En orden de agregado. Nunca más de MAX_PLANS. */
  list: Selection[];
  /** selectionId() del plan activo. Siempre apunta a uno de `list`,
   *  o '' si `list` está vacía. */
  active: string;
};

export function loadPlans(): Plans;          // migra de v1 si hace falta
export function savePlans(p: Plans): void;   // list vacía ⇒ borra las dos claves
```

Reglas de `loadPlans()`, en este orden:

1. Si hay v2 válida, se usa. Se validan los campos como ya hace `loadSelection`
   (`storage.ts:115-132`): nunca confiar en lo guardado.
2. Se recorta a `MAX_PLANS` y se deduplica por `selectionId`.
3. Si `active` no está en `list`, se cae al primero.
4. Si no hay v2 pero sí v1: `{ list: [loadSelection()], active: selectionId(...) }`, se
   escribe la v2 y **se borra la v1**. Esta migración es lo único que separa a un usuario
   actual de perder su plan y su semestre al desplegar.
5. Sin nada: `{ list: [], active: '' }`.

`clearStored()` (`storage.ts:158-168`) borra **las dos** claves, v1 incluida.

> **La clave del semestre —`tablero.semestre.v2`— no se toca.** `PlanItem` no cambia de
> forma, y bumpear esa clave le borraría el semestre a todo el mundo por nada.

### `web/src/state/planContext.ts`

```ts
export const MAX_ITEMS = 10;   // sin cambios (D4)
export const MAX_PLANS = 2;    // nuevo (D2)

export type PlanApi = {
  // ── sin cambios ─────────────────────────────────────────────
  items: PlanItem[];
  has: (id: string) => boolean;
  add: (item: Omit<PlanItem, 'addedAt'>) => boolean;  // + guardia D5 adentro
  remove: (id: string) => void;
  clear: () => void;
  full: boolean;
  /** El plan ACTIVO. `null` si todavía no hay ninguno. Mismo significado
   *  de siempre para quien solo tiene uno. */
  selection: Selection | null;
  /** Activa un plan. Si no está en `plans`, lo agrega (si hay cupo).
   *  YA NO BORRA NADA. */
  select: (s: Selection) => void;

  // ── nuevo ───────────────────────────────────────────────────
  /** Mis planes, en orden de agregado. 0, 1 o 2. */
  plans: Selection[];
  /** true si `selectionId(s)` está en `plans`. */
  owns: (s: Pick<Selection, 'level' | 'campus' | 'program'>) => boolean;
  /** Quita un plan Y las materias de ese plan. No confirma: quien llama
   *  ya preguntó (useConfirm). */
  removePlan: (id: string) => void;
  /** `plans.length >= MAX_PLANS`. */
  plansFull: boolean;
};
```

`select()` queda así — comparar con el original en `PlanProvider.tsx:66-92`, que es lo
que se borra:

```ts
const select = useCallback((next: Selection) => {
  setPlans((prev) => {
    const id = selectionId(next);
    const known = prev.list.some((p) => selectionId(p) === id);
    if (known) {
      // Re-elegir un plan que ya tengo: solo lo activa, y pisa el guardado
      // (así un plan adoptado sin nombres se queda con los de verdad).
      return { list: prev.list.map((p) => (selectionId(p) === id ? next : p)), active: id };
    }
    if (prev.list.length >= MAX_PLANS) return prev;  // el tope no se salta por acá
    return { list: [...prev.list, next], active: id };
  });
}, []);
```

`ScheduleProvider` (`ScheduleProvider.tsx:31-40`) **no se toca**: poda por `plan.items`,
así que al quitar un plan los grupos elegidos de sus materias se limpian solos. Verificarlo
es parte del criterio de aceptación de la Fase 1, no código nuevo.

---

## La interfaz, pantalla por pantalla

### 1. La barra · el menú "Mis planes"

Hoy el chip del plan (`Topbar.tsx:104-112`) es a la vez rótulo y botón de "empezar de
nuevo" — con caneca y todo. Con dos planes ese doble papel deja de funcionar: hace falta
poder *cambiar* al otro, y "cambiar" y "borrar todo" no pueden ser el mismo clic.

**El chip pasa a abrir un menú.** Uno solo, con el mismo contenido para uno o dos planes:

```
┌─ Mis planes ─────────────────────────────┐
│ ● 2A74  Ingeniería de sistemas   Bogotá  │  ← activo, aria-current
│ ○ 2B10  Diseño industrial        Bogotá  │  ← clic: activa y va a su catálogo
│                                     🗑    │  ← por fila: quitar este plan
│ ────────────────────────────────────────  │
│ + Agregar plan (doble titulación)         │  ← apagado si plansFull
│ 🗑 Empezar de nuevo                        │  ← danger, el startOver de hoy
└──────────────────────────────────────────┘
```

- **Implementación: el atributo nativo `popover`** (`<button popovertarget="planes">` +
  `<div popover id="planes">`). Da capa superior, cierre al hacer clic afuera y `Esc`
  gratis, sin dependencias ni lógica de click-outside. Posicionado con CSS absoluto
  relativo a `.bar__inner` — **no** con anchor positioning, que todavía no está en todos
  los navegadores.
- Si el `popover` da problemas, el fallback es el `<dialog>` que ya usa
  `components/Confirm.tsx`. No se agrega ninguna librería de menús: es la fila 4 de la
  escalera (plataforma nativa antes que dependencia).
- **Quitar un plan pasa por `useConfirm`**, con el mismo tono que el diálogo actual de
  `PlanPicker`: "se van a borrar las N materias de este plan; las del otro se quedan".
- **Con un solo plan el menú se ve igual**, con una fila de plan y sin "quitar". El coste
  para la mayoría es un clic extra en una acción que hoy es un clic + confirmación —
  y de paso deja de ser posible tocar el chip por error y encontrarse un diálogo de borrar
  todo.
- Móvil: `.tabbar` (`components/TabBar.tsx`) **no cambia**. El menú vive donde vive el
  chip, y `popover` funciona igual con toque.

Accesibilidad, sin inventar nada: el disparador lleva `aria-expanded`; cada plan es un
`<button>` con `aria-current="true"` en el activo; el orden de tabulación es el del DOM.

### 2. `PlanPicker` · modo agregar

`Screen` (`state/nav.ts:26-32`) gana un campo opcional:

```ts
| { name: 'plan-picker'; mode?: 'add' }
```

Con `mode: 'add'` cambian **solo tres cosas** de la pantalla (`views/PlanPicker.tsx`):

1. El título: "Agregar plan" en vez de "Cambiar de plan"; el copy explica en una línea
   que es para doble titulación y que **no se pierde nada del semestre**.
2. `choose()` no muestra el diálogo destructivo (`PlanPicker.tsx:110-130`): llama a
   `plan.select(p)` y navega al catálogo del nuevo plan.
3. `mine` (`PlanPicker.tsx:291-293`) marca **todos** los planes que ya tengo, no solo el
   activo, y esos quedan deshabilitados con tooltip "ya es uno de tus planes".

Sin `mode`, la pantalla se comporta exactamente como hoy… con una diferencia: como
`select()` ya no borra, el diálogo de "cambiar de plan reinicia el tablero" **ya no
aplica**. En su lugar, si elegir un plan nuevo dejaría la lista por encima de `MAX_PLANS`,
se ofrece cambiar el activo o quitar uno primero.

### 3. Catálogo (`views/Program.tsx`) · el aviso deja de ser un muro

`foreign` (`Program.tsx:386`) cambia de significado: hoy es "no es el plan activo"; pasa
a ser **"no es ninguno de mis planes"** (`!plan.owns(sel)`).

- Mirando el catálogo de **un plan mío que no es el activo**: no hay aviso, y el `+`
  funciona. Esto es lo que hace que la feature exista.
- Mirando un plan **ajeno de verdad** (se llega desde un 300 ambiguo, ver `States.tsx`):
  se queda el aviso de hoy, con el botón "cambiarme a este" convertido en **"agregar a
  mis planes"** cuando hay cupo (`!plansFull`), que ya no borra nada. Lleno, vuelve a
  decir "cambiarme a este" con su confirmación.
- El marcado de choques del catálogo contra lo ya elegido (`Program.tsx:140-144`)
  **funciona cross-plan sin tocarlo**: `planRows` sale de `plan.items`, que ahora trae
  los dos planes. Navegar el catálogo del plan B viendo en rojo lo que choca con el
  horario del plan A es el momento en que esta feature se paga sola.

### 4. `AddButton` · se cae un `if`, se agrega otro

```ts
// antes (AddButton.tsx:22)
const foreign = !!plan.selection && selectionId(plan.selection) !== selectionId(item);
// después
const foreign = plan.plans.length > 0 && !plan.owns(item);
```

Y el bloqueo nuevo de D5 (duplicado por código en el otro plan), con su propio texto de
tooltip: "Ya está en tu semestre desde el plan 2A74. Se inscribe por un solo plan."
El estado visual ya existe: `Ban` + `disabled`, sin CSS nuevo.

### 5. `CourseCard` · de qué plan es esta materia

Un chip con el código del plan al lado del código de la asignatura, **solo si
`plan.plans.length > 1`**. Reutiliza `.chip__code` / `.planchip__code` de
`styles/tokens.css` + `Topbar.css`; no se crea un token de color nuevo ni una escala
tipográfica nueva.

**Los colores del calendario no se tocan.** `lib/courseColors.ts` asigna un color por
materia; meter un segundo eje de color por plan haría ilegible una semana con seis
bloques. Lo que sí lleva el plan es el texto accesible del bloque.

### 6. `CreditsBadge` · el desglose gana una sección

Total y semáforo, igual que hoy (D8). Con dos planes, el tooltip muestra primero el
desglose **por plan** y debajo el de tipología, que sigue siendo el de siempre. La
función nueva es una hermana de `creditsByTypology` (`lib/credits.ts:38-46`), con la
misma forma y el mismo orden de mayor a menor.

---

## Fases

Cinco commits. Cada uno compila, pasa `npx tsc -b --noEmit`, `npx oxlint` y
`npm test`, y **cada uno deja la app usable**. El mensaje de commit va literal — ver
[`COMMIT-CONVENTION.md`](COMMIT-CONVENTION.md): el título del PR es lo que lee
`semantic-release`.

### Fase 1 · El estado aguanta varios planes (invisible)

**Archivos**: `web/src/lib/storage.ts`, `web/src/state/planContext.ts`,
`web/src/state/PlanProvider.tsx`, `web/src/lib/plans.test.ts` (nuevo).

Todo lo de [El modelo de estado nuevo](#el-modelo-de-estado-nuevo). Ninguna pantalla
cambia: con un plan, `plan.selection` devuelve lo mismo que hoy.

**Criterio de aceptación**

- [ ] Con `tablero.plan.v1` en el navegador y **sin** v2: al cargar, el plan y las
      materias siguen ahí, aparece `tablero.planes.v2` y la v1 desaparece.
- [ ] `plan.select()` con otro plan **no** vacía Mi semestre.
- [ ] `plan.removePlan(id)` borra ese plan y solo sus materias; las del otro sobreviven,
      y sus grupos elegidos también.
- [ ] Al quitar el plan activo, el activo pasa a ser el que queda.
- [ ] `plan.add()` devuelve `false` si ya hay una materia con el mismo `code` en otro
      plan (D5), y `false` si la lista está llena (como hoy).
- [ ] "Empezar de nuevo" deja el `localStorage` sin `tablero.plan.v1`,
      `tablero.planes.v2`, `tablero.semestre.v2`, `tablero.orden.v1`,
      `tablero.horario.v1` ni `tablero.horario.ancho.v1`.

```
feat(web): guardar varios planes de estudios en vez de uno
```

### Fase 2 · El menú de planes y el modo agregar

**Archivos**: `web/src/components/Topbar.tsx` + `Topbar.css`, `web/src/state/nav.ts`,
`web/src/views/PlanPicker.tsx`.

**Criterio de aceptación**

- [ ] Con **un** plan: el menú tiene una fila de plan, "agregar plan" y "empezar de
      nuevo". Nada más de la barra cambió de sitio ni de tamaño.
- [ ] "Agregar plan" abre `PlanPicker` en modo `add`, y elegir uno **no** muestra ningún
      diálogo de borrado.
- [ ] Con **dos** planes: tocar el inactivo lo activa y abre su catálogo; el semestre
      queda intacto y el chip refleja el cambio.
- [ ] Con dos planes, "agregar plan" está apagado y su tooltip dice por qué.
- [ ] Quitar un plan pide confirmación y dice cuántas materias se van.
- [ ] `Esc` cierra el menú; el foco vuelve al chip; se navega entero con teclado.
- [ ] En móvil (< `STACK_BREAKPOINT_PX`) el menú abre y se usa con el pulgar sin taparse
      con `.tabbar`.

```
feat(web): menú de planes en la barra, con agregar y quitar
```

### Fase 3 · Se pueden agregar materias de cualquiera de mis planes

**Archivos**: `web/src/components/AddButton.tsx`, `web/src/views/Program.tsx`.

**Criterio de aceptación**

- [ ] Con dos planes, el `+` funciona en el catálogo de los dos, esté cual esté activo.
- [ ] En un plan que no es mío, el aviso sigue apareciendo y ofrece "agregar a mis
      planes" (con cupo) o "cambiarme a este" (lleno).
- [ ] Una materia ya agregada desde el plan A aparece con el `+` apagado en el catálogo
      del plan B, con el tooltip de D5.
- [ ] **La prueba que importa**: con un grupo elegido en una materia del plan A, el
      catálogo del plan B marca en rojo/amarillo las materias que chocan contra él, sin
      pedir nada nuevo al back.

```
feat(web): permitir materias de los dos planes en el mismo semestre
```

### Fase 4 · Decir de qué plan es cada cosa

**Archivos**: `web/src/components/CourseCard.tsx` (+ `.css`),
`web/src/components/CreditsBadge.tsx`, `web/src/lib/credits.ts`.

**Criterio de aceptación**

- [ ] Con un plan, `CourseCard` y `CreditsBadge` se ven **idénticos** a `main`.
- [ ] Con dos, cada tarjeta muestra el código de su plan, y el tooltip de créditos
      desglosa por plan y por tipología.
- [ ] El `.ics` exportado y el calendario siguen saliendo bien con materias de los dos
      planes (los colores siguen siendo por materia).

```
feat(web): marcar de qué plan es cada materia con dos titulaciones
```

### Fase 5 · Pulido y poda

- Pasar `/ponytail-review` sobre el diff completo de la rama y **borrar lo que sobre**.
  Sospechosos de origen: helpers de un solo uso, estado derivable, un `useMemo` que
  envuelve un `find` sobre una lista de dos elementos.
- Revisar que ningún comentario del código siga diciendo "el semestre es de UN plan"
  (`AddButton.tsx:19-21`, `planContext.ts:18-21`, `PlanPicker.tsx:94-97`,
  `PlanProvider.tsx:58-59`): esos comentarios pasan a ser mentira y en este repo los
  comentarios explican el porqué, así que hay que reescribirlos, no borrarlos.
- Actualizar `web/README.md` (sección "Decisiones que conviene no deshacer") y este
  documento a **Estado: implementado**.

```
docs(web): actualizar el porqué del estado del plan tras doble titulación
```

---

## Tests

El repo corre `vitest` (`web/package.json` → `npm test`) y hoy tiene una sola suite:
`web/src/lib/conflicts.test.ts`. Se sigue esa forma —funciones puras, sin librería de
render, sin fixtures— con **un** archivo nuevo:

**`web/src/lib/plans.test.ts`**, sobre las funciones puras que salen de la Fase 1
(migración y reglas de lista). Casos mínimos, uno por regla que puede romper datos de
alguien:

1. v1 presente y v2 ausente → migra, conserva el plan, borra la v1.
2. v2 con `active` apuntando a un plan que no está → cae al primero.
3. v2 con tres planes guardados a mano → se recorta a `MAX_PLANS`.
4. v2 con dos planes de igual `selectionId` → se deduplica.
5. Basura en la clave (`'{'`, `'[]'`, `null`) → `{ list: [], active: '' }` sin tirar.

No se testea React ni el menú: no hay entorno de render montado en el repo y montarlo
para esto sería traer `@testing-library` entero por un popover. Los criterios de
aceptación de las fases 2-4 se verifican a mano en el navegador, como el resto de la
interfaz.

---

## Cómo usar los plugins

- **ponytail** (activo por hook, nivel `full`): la escalera manda. Antes de escribir un
  componente nuevo, buscar el que ya existe — `Confirm`, `Tooltip`, `IconButton`,
  `SearchInput`, `.chip`, `.btn` cubren casi todo lo de acá. **Ninguna dependencia nueva**
  en esta rama: el menú es `popover` nativo. Al terminar, `/ponytail-review` sobre el
  diff (Fase 5).
- **frontend-design**: útil para el menú de planes y el chip de plan en la tarjeta,
  **con un guardarraíl**: este repo ya tiene identidad visual cerrada en
  `web/src/styles/tokens.css`, y la skill está pensada para *proponer* una. Se usa para
  jerarquía, espaciado y estados del menú — **no** para elegir tipografías, paletas ni
  un lenguaje visual nuevo. Si el resultado no se puede pintar con los tokens que ya
  existen, está mal.
- **context7**: para dudas de API real —`popover` / `popovertarget`, `<dialog>`,
  React 19— antes que tirar de memoria. `resolve-library-id` → `query-docs`.
- **caveman**: solo estilo de conversación. Los commits, el cuerpo del PR y los
  comentarios del código van en prosa normal, en español, como el resto del repo.

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| La migración v1→v2 falla y alguien pierde plan y semestre | Es el primer criterio de la Fase 1, con test propio. `loadPlans` nunca tira: ante cualquier duda devuelve vacío, y el peor caso es volver a elegir el plan — el semestre vive en otra clave que no se toca |
| El menú tapa contenido o no se cierra en móvil | `popover` nativo trae el cierre por clic afuera y `Esc`; criterio explícito de la Fase 2 |
| La mayoría de un solo plan nota el cambio | Criterio repetido en las fases 2 y 4: con un plan, idéntico a `main`. Si algo se ve distinto, es un bug de la rama |
| Dos catálogos = dos misses fríos contra el SIA | No es nuevo ni evitable: es una llamada más a un endpoint que ya existe y que la API cachea. La pantalla de carga ya explica el costo |
| 10 materias entre dos planes se quedan cortas | Es una constante (`MAX_ITEMS`). Si aparece el caso real, se sube; no se diseña para él ahora |

---

## Preguntas abiertas

1. **Los mínimos de créditos (6 para inscribir, 10 para cerrar) ¿son por plan de estudios
   o por la inscripción completa?** De la respuesta depende si `CreditsBadge` debería
   tener un semáforo por plan. Hasta saberlo, se muestra el total global (D8) y el
   desglose por plan es informativo. **No inventar la regla.**
2. **¿La sede puede diferir entre los dos planes?** El modelo lo soporta —cada
   `PlanItem` lleva su `campus` y su `faculty`, y las peticiones de detalle usan el del
   item (`useCourseDetails.ts:127-129`)—, así que no hay nada que hacer salvo no
   asumir lo contrario en el copy. Que sea posible en el SIA es otra pregunta.
3. **¿La doble titulación puede cruzar niveles** (un pregrado y un posgrado)? Mismo caso:
   soportado por el modelo, no verificado contra la realidad.

Ninguna de las tres bloquea la implementación.

---

## Checklist antes del PR

- [ ] `npx tsc -b --noEmit` limpio
- [ ] `npx oxlint` limpio
- [ ] `npm test` verde
- [ ] Probado a mano con **un** plan: no se ve ninguna diferencia contra `main`
- [ ] Probado a mano con **dos** planes: agregar de los dos, choque cruzado, quitar uno,
      exportar `.ics`
- [ ] Probado con `localStorage` de un usuario viejo (v1) — la migración
- [ ] `/ponytail-review` pasado y aplicado
- [ ] Comentarios que decían "un solo plan" reescritos, no borrados

**Título del PR** (es lo que lee `semantic-release`):

```
feat(web): soporte para doble titulación
```
