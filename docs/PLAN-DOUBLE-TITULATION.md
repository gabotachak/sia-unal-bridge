# Plan: doble titulación

Cómo el tablero deja de asumir **un** plan de estudios por persona sin volverse más
complicado para quien solo tiene uno — ni para quien tiene dos.

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

**Las dos poblaciones y sus dos fricciones**, que no son la misma:

| | Quiere | Su fricción si lo hacemos mal |
|---|---|---|
| **Un plan** (la mayoría) | Que nada cambie | Preguntas de más en el onboarding; controles nuevos que nunca va a usar |
| **Dos planes** (la minoría) | Que exista, y enterarse | Descubrirlo semanas después; y una vez adentro, pagar peaje de pestañas y menús cada vez que busca una materia |

Todo lo que sigue está subordinado a esas dos reglas a la vez:

1. **Con un solo plan, la interfaz no cambia en nada** salvo una casilla sin marcar en la
   pantalla de elegir plan.
2. **Con dos, no hay modo aparte.** Se declara una vez al principio, y después la app es
   la misma: **un catálogo, un semestre, un horario**.

---

## La forma de la solución, en una frase

**El doble titulación no navega dos catálogos: navega uno que es la suma de los dos.**

No hay pestañas, no hay "plan activo", no hay que acordarse de en cuál se está. Se
declara la doble titulación con una casilla al elegir plan, se eligen dos, y de ahí en
adelante el catálogo es la unión de los dos conjuntos de asignaturas, con una única regla
para los códigos que aparecen en los dos: **obligatorio > optativo > libre elección**.

Eso es lo que hace que la feature no cueste nada de aprender — y, de paso, hace el código
**más chico** que la alternativa de pestañas: sin plan activo no hay estado que guardar,
que persistir ni que sincronizar.

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
- **El calendario, el `.ics`, el filtro de disponibilidad y el marcado de choques**
  operan sobre `plan.items` y `itemId`. Ninguno pregunta por el plan.
- **El backend no se toca. La API no se toca. `openapi.yaml` no se toca.** El catálogo del
  segundo plan es una llamada más a
  `/v1/campuses/{campus}/programs/{program}/courses`, que la API ya cachea igual que
  cualquier otra.

Lo genuinamente nuevo son **dos cosas y nada más**: `Selection` pasa de objeto a lista, y
el catálogo aprende a fusionar dos respuestas.

---

## El flujo

### ¿Un flujo aparte para doble titulación? No

Tentador y equivocado:

1. **Duplica la superficie.** Dos onboardings, dos catálogos, dos "Mi semestre" que
   mantener sincronizados. Es la clase de rama que se desincroniza en el tercer commit.
2. **No es lo que quieren.** Las dos poblaciones quieren el mismo producto: un horario.
   La minoría solo pide que ese horario beba de dos catálogos. Eso es **un dato con
   cardinalidad distinta**, no un producto distinto.

Lo que sí hace falta es declararlo **donde el doble ya sabe que es doble**: en la pantalla
que le pregunta dónde estudia. Ahí no es una pregunta nueva — es la misma pregunta con la
respuesta que le corresponde, y una casilla sin marcar no le cuesta nada a nadie.

### Primera vez

```
UN PLAN (la mayoría)                    DOBLE TITULACIÓN
────────────────────                    ─────────────────
¿Dónde estudias?                        ¿Dónde estudias?
  ☐ Estudio doble titulación              ☑ Estudio doble titulación  ← un clic
  nivel · sede · lista de planes          nivel · sede · lista de planes
  [clic en su plan]                       [clic en el primero]  → chip "1 de 2"
        ↓                                 [clic en el segundo]  (nivel y sede
  catálogo                                       ↓               quedan donde están)
                                          catálogo: los dos, sumados
  1 clic. Igual que hoy,
  más una casilla que ignoró.             3 clics. Ningún concepto nuevo.
```

**La casilla no abre un modo distinto de elegir.** La lista de planes es la misma, con
los mismos botones de fila: elegís, elegís, entrás. Lo único que cambia es que el primer
clic no navega — deja un chip y espera al segundo. Salir a mitad de camino deja un plan
elegido y funcionando: **nunca hay un estado a medias que limpiar**.

### Ya adentro

Idéntico para los dos, salvo por lo que hay dentro de las listas:

```
┌────────────────────────────────────────────────────────┐
│ SIA Bridge      [2A74 · 2B10 ▾]         ▤  ☑  📅  ☕  ◐│  ← el chip lista los dos
├────────────────────────────────────────────────────────┤
│  plan 2A74 · 2B10                                      │
│  Catálogo                                1 187 asignat.│  ← la unión, deduplicada
│  [buscar…] [tipología ▾] [créditos ▾] [con cupo]       │  ← los mismos filtros
└────────────────────────────────────────────────────────┘
```

- **Un solo buscador** para las materias de los dos planes.
- **Un solo "Mi semestre"** y **un solo "Mi horario"**, como ya son hoy.
- Sin pestañas, sin plan activo, sin cambiar de contexto.

### Y si se entera tarde

El chip de la barra abre un menú con "cambiar mis planes", que lleva al mismo
`PlanPicker` con la casilla — que ahora aparece marcada o no según lo que ya tenga. Es la
misma puerta, de vuelta. (Hoy no existe ninguna: la única forma de cambiar de plan es
"empezar de nuevo", que borra todo. Ver [interfaz §3](#3-la-barra--el-menú-del-chip).)

---

## Decisiones

Cada una con la alternativa que se descartó, para que nadie la reabra a mitad de camino.

### D1 · `Selection` pasa a ser lista, y `plan.selection` sobrevive intacto

`PlanApi` gana `plans: Selection[]`, y **`selection` se queda** como `plans[0]`. Es un
cambio aditivo: los ~10 sitios que hoy leen `plan.selection` —`Topbar`, `TabBar`,
`Donate`, `Semester`, `Schedule`, `NavProvider`— siguen compilando y comportándose igual.

> Descartado: renombrar `selection` a `activePlan` y tocar los 10 sitios. Diff más
> grande, cero beneficio.

### D2 · **No hay plan activo**

Con el catálogo unido no existe "el plan que estoy mirando", así que no hay nada que
guardar, persistir ni sincronizar. `plans` es una lista en orden de elección y el primero
manda para lo poco que necesita un solo plan (con qué abre la app, `NavProvider.tsx:25-27`;
adónde apunta el icono de catálogo de la barra).

> Descartado (era la propuesta anterior de este documento): pestañas de plan en el
> catálogo + `active` persistido. Le cobraba un clic a la acción más frecuente de la
> minoría y metía un campo de estado nuevo en `localStorage`. La unión hace las dos cosas
> mejor con menos código.

### D3 · Tope de **2** planes

Doble titulación son dos, y la casilla lo dice literalmente. Con dos elegidos, las filas
de la lista quedan deshabilitadas hasta que se suelte una — mismo patrón de botón apagado
+ tooltip que ya usa `AddButton` con `MAX_ITEMS`.

```ts
// ponytail: tope duro de 2, sube a N cambiando la constante si aparece el caso
export const MAX_PLANS = 2;
```

### D4 · Cambiar de plan **no borra nada**. Quitar un plan borra **solo lo suyo**

Es el corazón del cambio. Hoy `select()` limpia `items` al detectar otro plan
(`PlanProvider.tsx:78-87`). En el modelo nuevo:

| Acción | Efecto sobre `items` |
|---|---|
| Agregar un plan | **ninguno** |
| Quitar un plan (soltar un chip, o desmarcar la casilla) | borra solo los `items` de ese plan |
| Reemplazar el único plan (la mayoría, sin casilla) | borra todo, con confirmación — como hoy |
| Empezar de nuevo | borra todo, como hoy |

### D5 · El catálogo es la **unión** de los dos, deduplicada por código

Con dos planes, `Program` pide los dos catálogos (`useApi` acepta `null`, así que son dos
llamadas fijas sin hooks condicionales) y los fusiona en memoria. Cada fila recuerda de
qué plan salió, que es lo que después arma su `PlanItem`.

Los códigos que existen en los dos planes **aparecen una sola vez**. Esto no es cosmético:
`course.code` se repite entre planes con frecuencia y la persona va a inscribir la materia
**por un solo plan**, así que dos filas idénticas serían dos formas de agregar la misma
clase dos veces.

> Descartado: dos listas, una debajo de otra, con encabezado por plan. Rompe el orden,
> rompe el buscador y duplica los códigos compartidos, que es justo lo que hay que
> resolver.

### D6 · La regla de tipología: obligatorio > optativo > libre elección

Cuando un código está en los dos planes **con tipología distinta** —confirmado que pasa:
8 de 22 códigos compartidos divergen entre planes de Bogotá, `GOTCHAS.md` §17— gana la
tipología más exigente, y con ella gana su plan.

La letra entre paréntesis es la clave estable, no la frase: `FUND. OBLIGATORIA (B)` → `B`.

| Rango | Tipologías (literal del SIA) | Letra |
|---:|---|---|
| 4 | `TRABAJO DE GRADO` | `P` |
| 3 | `FUND. OBLIGATORIA`, `DISCIPLINAR OBLIGATORIA` | `B`, `C` |
| 2 | `FUND. OPTATIVA`, `DISCIPLINAR OPTATIVA` | `O`, `T` |
| 1 | `LIBRE ELECCIÓN` | `L` |
| 0 | `NIVELACIÓN`, y cualquier letra desconocida | `E`, … |

Empate (misma letra en los dos planes) → gana el **primer plan elegido**, por desempate
estable y no por azar del orden de llegada de las respuestas.

Consecuencias que hay que saber:

- **El literal que se muestra y se guarda en `PlanItem.typology` es el del plan
  ganador**, crudo, tal como lo manda el SIA. No se normaliza ni se traduce: es dato de
  ellos (convención de idioma, `CLAUDE.md`).
- **El desglose de créditos por tipología cuenta la materia una sola vez**, en la
  tipología ganadora.
- **Los grupos visibles son los del plan ganador.** Los grupos que se ven dependen del
  programa desde el que se consulta (`CLAUDE.md`: relación de subconjunto estricto), así
  que una materia ganada por el plan A puede mostrar menos grupos de los que mostraría
  desde el B. Se avisa en la tarjeta con una línea —"también en 2B10 como
  `LIBRE ELECCIÓN (L)`"— y no se hace nada más: fusionar los grupos de las dos
  consultas duplicaría las peticiones de detalle para un caso de borde.
  Ver [Preguntas abiertas](#preguntas-abiertas) §2.

> Rangos 4 y 0 son propuesta, no instrucción recibida: `TRABAJO DE GRADO` y `NIVELACIÓN`
> no entran en la regla de tres niveles. Ver [Preguntas abiertas](#preguntas-abiertas) §1.

### D7 · Una asignatura, un plan: no se agrega dos veces el mismo `code`

La deduplicación de D5 ya hace imposible agregarla dos veces desde el catálogo. El
guardia va igual **en `PlanProvider.add()`**, porque la ficha de la materia también agrega
y porque un `localStorage` viejo puede traer la lista ya duplicada. Es una línea:
`if (prev.some((i) => i.code === item.code)) return prev;`

### D8 · El tope de materias sube a **15** cuando hay dos planes

`MAX_ITEMS = 10` (`planContext.ts:6`) es un presupuesto de mediciones contra el SIA —una
petición de detalle por materia, pool de 4—, no una cuota académica. Un semestre de doble
titulación son ~8-9 materias inscritas, y la lista es una **preselección**: con 10 se
queda sin espacio para comparar candidatas, que es para lo que existe el tablero.

```ts
// ponytail: el techo real es la ronda de medición (~1.3 s por materia, 4 en
// paralelo): 15 son ~5 s con la barra de progreso a la vista. Si molesta, baja.
const max = plans.length > 1 ? 15 : 10;
```

### D9 · Los créditos siguen sumando en global; el desglose por plan va al tooltip

`CreditsBadge` muestra el total del semestre y el semáforo de los estatutos con los
mismos umbrales de hoy (`credits.ts:10,16`). El tooltip, que ya despliega el desglose por
tipología, gana uno por plan cuando hay dos.

**Lo que NO se hace: aplicar el semáforo por plan.** No sabemos si los mínimos de 6 y 10
créditos se exigen por plan de estudios o sobre la inscripción completa
([Preguntas abiertas](#preguntas-abiertas) §3). Inventarlo sería pintar de rojo un
semestre válido, y este badge es informativo por diseño: nunca bloquea nada.

### D10 · En Mi semestre, la sigla del plan por fila; en el calendario, nada

Mi semestre y Mi horario mezclan las materias de los dos planes. Se agrega un chip con el
código del plan en cada tarjeta **solo si `plans.length > 1`**; con un plan la tarjeta es
byte por byte la de hoy.

**Los colores del calendario no se tocan**: `lib/courseColors.ts` asigna un color por
materia, y un segundo eje de color por plan haría ilegible una semana con seis bloques. El
plan viaja en el texto accesible del bloque.

---

## El modelo de estado nuevo

### `web/src/lib/storage.ts`

`Selection` y `selectionId` **no cambian**. Cambia solo qué se guarda: un array en vez de
un objeto.

```ts
/** v2: varios planes, en orden de elección. La v1 guardaba un solo objeto. */
const PICK_KEY = 'tablero.planes.v2';
/** La clave vieja, que solo se lee para migrar. */
const PICK_KEY_V1 = 'tablero.plan.v1';

export function loadPlans(): Selection[];        // migra de v1 si hace falta
export function savePlans(p: Selection[]): void; // vacío ⇒ borra las dos claves
```

Reglas de `loadPlans()`, en este orden:

1. Si hay v2 válida, se usa; cada plan se valida campo por campo como ya hace
   `loadSelection` (`storage.ts:115-132`). Nunca confiar en lo guardado.
2. Se deduplica por `selectionId` y se recorta a `MAX_PLANS`.
3. Si no hay v2 pero sí v1: `[loadSelection()]`, se escribe la v2 y **se borra la v1**.
   Esta migración es lo único que separa a un usuario actual de perder su plan al
   desplegar.
4. Sin nada: `[]`.

`clearStored()` (`storage.ts:158-168`) borra **las dos** claves, v1 incluida.

> **La clave del semestre —`tablero.semestre.v2`— no se toca.** `PlanItem` no cambia de
> forma, y bumpearla le borraría el semestre a todo el mundo por nada.

### `web/src/state/planContext.ts`

```ts
export const MAX_PLANS = 2;
export const MAX_ITEMS = 10;       // con un plan
export const MAX_ITEMS_PAIR = 15;  // con dos (D8)

export type PlanApi = {
  // ── sin cambios ─────────────────────────────────────────────
  items: PlanItem[];
  has: (id: string) => boolean;
  add: (item: Omit<PlanItem, 'addedAt'>) => boolean;  // + guardia D7
  remove: (id: string) => void;
  clear: () => void;
  full: boolean;                    // contra el tope que corresponda (D8)
  /** El primer plan. Mismo significado de siempre para quien tiene uno. */
  selection: Selection | null;
  /** Fija el plan ÚNICO: reemplaza la lista entera. Es lo que usa quien no
   *  marcó la casilla. Con items guardados, quien llama confirma antes. */
  select: (s: Selection) => void;

  // ── nuevo ───────────────────────────────────────────────────
  /** Mis planes, en orden de elección. 0, 1 o 2. */
  plans: Selection[];
  owns: (s: Pick<Selection, 'level' | 'campus' | 'program'>) => boolean;
  /** Agrega un plan si hay cupo. No borra nada. */
  addPlan: (s: Selection) => boolean;
  /** Quita un plan Y las materias de ese plan. No confirma: quien llama
   *  ya preguntó (useConfirm). */
  removePlan: (id: string) => void;
  plansFull: boolean;
};
```

`ScheduleProvider` (`ScheduleProvider.tsx:31-40`) **no se toca**: poda por `plan.items`,
así que al quitar un plan los grupos elegidos de sus materias se limpian solos.
Verificarlo es criterio de aceptación de la Fase 1, no código nuevo.

### `web/src/lib/typology.ts` (nuevo, ~15 líneas)

```ts
/** La letra entre paréntesis: 'FUND. OBLIGATORIA (B)' → 'B'. Es lo estable;
 *  la frase cambia de vocabulario entre vistas del SIA (GOTCHAS §17). */
export function typologyLetter(raw: string): string;

/** Rango de exigencia (D6). Más alto gana. Desconocida → 0. */
export function typologyRank(raw: string): number;
```

### `web/src/lib/catalog.ts` (nuevo, ~30 líneas)

```ts
export type MergedCourse = CourseSummary & {
  /** De qué plan salió esta fila: lo que arma su PlanItem y su itemId. */
  plan: Selection;
  /** Si el mismo código estaba en el otro plan, con qué tipología. Solo
   *  para la línea informativa de la tarjeta. */
  alsoIn?: { plan: Selection; typology: string };
};

/** Une los catálogos de 1 o 2 planes. Dedup por `code` con la regla de D6.
 *  Con un solo plan es un map sobre la lista: mismo orden, mismo largo. */
export function mergeCatalogs(
  parts: { plan: Selection; courses: CourseSummary[] }[],
): MergedCourse[];
```

---

## La interfaz, pantalla por pantalla

### 1. `PlanPicker` · la casilla

Va debajo del párrafo de entrada (`PlanPicker.tsx:160-171`) y encima de "Nivel", como
`<input type="checkbox">` nativo con su `<label>` — no un toggle pintado:

> ☐ **Estudio doble titulación** — elige tus dos planes; el horario los junta.

Estado local (`useState`), **no** entra a `nav.ts` ni a `localStorage`: se deriva de lo
que ya hay (`plans.length > 1`) al montar, así que volver a esta pantalla la encuentra
marcada sola.

Con la casilla **marcada**:

- Arriba de la lista, los planes ya elegidos como chips con su `×`, y el contador
  "1 de 2".
- `choose()` llama a `addPlan()`. Si con eso quedan dos, navega al catálogo; si es el
  primero, **se queda** y espera el segundo.
- Con dos elegidos, las filas quedan deshabilitadas ("suelta uno para cambiarlo").
- Nivel y sede no se tocan entre un plan y el otro: el componente no se desmonta, así
  que el segundo plan de la misma sede está a un clic.

Con la casilla **sin marcar** (la mayoría): la pantalla es la de hoy, con `choose()`
llamando a `select()` — que reemplaza el plan único, con la confirmación de siempre si
hay materias guardadas.

**Desmarcarla teniendo dos planes** suelta el segundo: confirma con `useConfirm`, diciendo
cuántas materias se van.

En todos los casos, `mine` (`PlanPicker.tsx:291-293`) marca **todos** los planes que ya
tengo, no solo el primero.

### 2. Catálogo (`views/Program.tsx`) · la unión

```tsx
const merged = plan.owns(sel) ? plan.plans : [sel];   // plan ajeno ⇒ solo ese

const a = useApi<CoursesResponse>(routes.courses(scope(merged[0]), merged[0].program, inc));
const b = useApi<CoursesResponse>(
  merged[1] ? routes.courses(scope(merged[1]), merged[1].program, inc) : null,
);

const courses = useMemo(() => mergeCatalogs([...]), [a.data, b.data, merged]);
```

- **Hooks fijos, sin condicional**: `useApi` ya acepta `null` y no pide nada
  (`useApi.ts:37`), que es como `PlanPicker` evita pedir el directorio sin sede.
- **Carga**: mientras falte alguno, el `Loading` de siempre. **Error**: un solo `Fault`
  cuyo `onRetry` recarga los dos. Si uno respondió y el otro no, se pinta lo que hay con
  el `Fault` debajo: media lista sirve, ninguna no.
- `courseId(c)` deja de armarse con la `Selection` de la pantalla y pasa a usar `c.plan`
  (`Program.tsx:127-130`). **Es el cambio con más alcance del archivo**: de ahí salen el
  `itemId` de cada fila, el `PlanItem` que recibe `AddButton` y las claves de
  `sectionsById`.
- Filtros, facetas, buscador, orden y el marcado de choques trabajan sobre la lista
  fusionada sin enterarse: son funciones sobre un array.
- Cabecera: `plan 2A74 · 2B10` en el `eyebrow`, y el conteo es el de la unión.
- Con **un** plan, `mergeCatalogs` de una sola parte es un `map`: mismo orden, mismo
  largo, misma pantalla que `main`.

### 3. La barra · el menú del chip

Hoy el chip (`Topbar.tsx:104-112`) es rótulo y botón de "empezar de nuevo" a la vez, con
caneca. Con dos planes tiene que listar dos códigos, y hace falta una puerta no
destructiva de vuelta al `PlanPicker` — que **hoy no existe**: la única forma de cambiar
de plan es borrarlo todo.

```
┌─ Mis planes ─────────────────────────────┐
│ 2A74  Ingeniería de sistemas     Bogotá  │
│ 2B10  Diseño industrial          Bogotá  │
│ ────────────────────────────────────────  │
│ ⇄ Cambiar mis planes                      │  → PlanPicker (la casilla hace el resto)
│ 🗑 Empezar de nuevo                        │  → el startOver de hoy, con su confirmación
└──────────────────────────────────────────┘
```

- **Implementación: el atributo nativo `popover`** (`<button popovertarget>` + `<div
  popover>`): capa superior, cierre al hacer clic afuera y `Esc` gratis, sin dependencias
  ni lógica de click-outside. Posicionado con CSS absoluto relativo a `.bar__inner` —
  **no** con anchor positioning, que todavía no está en todos lados.
- Fallback si `popover` da guerra: el `<dialog>` de `components/Confirm.tsx`. **Ninguna
  librería de menús.**
- Con un plan el menú tiene una fila y las dos acciones. El costo para la mayoría es un
  clic extra en algo que se hace una vez cada varios meses — y deja de ser posible tocar
  el chip por error y encontrarse un diálogo de borrar todo.
- Móvil: `.tabbar` (`components/TabBar.tsx`) **no cambia**.

Accesibilidad: `aria-expanded` en el disparador; cada acción es un `<button>`; orden de
tabulación el del DOM.

### 4. `AddButton` · se cae un `if`, se agrega otro

```ts
// antes (AddButton.tsx:22)
const foreign = !!plan.selection && selectionId(plan.selection) !== selectionId(item);
// después
const foreign = plan.plans.length > 0 && !plan.owns(item);
```

Y el guardia de D7 (mismo `code` ya en la lista desde el otro plan), con su tooltip
propio: "Ya está en tu semestre desde el plan 2A74. Se inscribe por un solo plan." El
estado visual ya existe: `Ban` + `disabled`, sin CSS nuevo.

### 5. Catálogo ajeno · el aviso deja de ser un muro

`foreign` (`Program.tsx:386`) pasa de "no es el plan activo" a **"no es ninguno de mis
planes"** (`!plan.owns(sel)`). Ahí el catálogo se pinta solo (no unido), se queda el aviso
de hoy, y "cambiarme a este" se convierte en **"agregar a mis planes"** cuando hay cupo
(`!plansFull`) — que ya no borra nada.

### 6. `CourseCard` · de qué plan es, y dónde más está

Con `plans.length > 1`, un chip con el código del plan al lado del código de la
asignatura (`.chip__code`, ya existe). Y en las que vinieron de los dos, la línea de D6:
"también en 2B10 como `LIBRE ELECCIÓN (L)`". Con un plan, nada de esto se dibuja.

### 7. `CreditsBadge` · el desglose gana una sección

Total y semáforo igual que hoy (D9). Con dos planes el tooltip muestra primero el
desglose **por plan** y debajo el de tipología. La función nueva es hermana de
`creditsByTypology` (`lib/credits.ts:38-46`), misma forma, mismo orden.

---

## Fases

Seis commits, en el orden en que se vive la feature: **declarar → ver → agregar → leer**.
Cada uno compila, pasa `npx tsc -b --noEmit`, `npx oxlint` y `npm test`, y deja la app
usable. El mensaje va literal — ver [`COMMIT-CONVENTION.md`](COMMIT-CONVENTION.md).

### Fase 1 · El estado aguanta varios planes (invisible)

**Archivos**: `web/src/lib/storage.ts`, `web/src/state/planContext.ts`,
`web/src/state/PlanProvider.tsx`, `web/src/lib/plans.test.ts` (nuevo).

**Criterio de aceptación**

- [ ] Con `tablero.plan.v1` y **sin** v2: al cargar, el plan y las materias siguen ahí,
      aparece `tablero.planes.v2` y la v1 desaparece.
- [ ] `addPlan()` no toca `items`; `removePlan(id)` borra ese plan y solo sus materias —
      las del otro sobreviven, y sus grupos elegidos también.
- [ ] `add()` devuelve `false` si ya hay una materia con el mismo `code` (D7); el tope es
      10 con un plan y 15 con dos (D8).
- [ ] "Empezar de nuevo" deja el `localStorage` sin `tablero.plan.v1`,
      `tablero.planes.v2`, `tablero.semestre.v2`, `tablero.orden.v1`,
      `tablero.horario.v1` ni `tablero.horario.ancho.v1`.

```
feat(web): guardar varios planes de estudios en vez de uno
```

### Fase 2 · La casilla: declarar doble titulación y elegir dos

**Archivos**: `web/src/views/PlanPicker.tsx` (+ `.css`), `web/src/components/Topbar.tsx`
(+ `.css`).

Interfaz §1 y §3. El menú entra acá porque es la puerta de vuelta al picker.

**Criterio de aceptación**

- [ ] Primera visita sin marcar la casilla: **un clic** de la lista al catálogo, igual que
      hoy. Lo único distinto en pantalla es la casilla sin marcar.
- [ ] Marcándola: el primer plan deja el chip "1 de 2" y **no** navega; el segundo entra
      al catálogo; nivel y sede se quedaron donde estaban.
- [ ] Salir a mitad (atrás del navegador) deja un plan elegido y la app funcionando.
- [ ] Desmarcarla con dos planes pide confirmación y borra solo las materias del segundo.
- [ ] Volver al picker desde el menú lo encuentra con la casilla marcada y los dos chips.
- [ ] El menú: lista los planes, "cambiar mis planes", "empezar de nuevo"; `Esc` lo
      cierra, el foco vuelve al chip, se navega con teclado; en móvil se usa con el pulgar
      sin taparse con `.tabbar`.

```
feat(web): declarar doble titulación y elegir dos planes al empezar
```

### Fase 3 · El catálogo suma los dos conjuntos

**Archivos**: `web/src/lib/typology.ts` (nuevo), `web/src/lib/catalog.ts` (nuevo),
`web/src/lib/catalog.test.ts` (nuevo), `web/src/views/Program.tsx`.

**Criterio de aceptación**

- [ ] Con un plan, el catálogo es **idéntico** a `main`: mismo conteo, mismo orden,
      mismas facetas.
- [ ] Con dos, el conteo es la unión deduplicada, y el buscador encuentra materias de los
      dos planes.
- [ ] Un código presente en los dos aparece **una sola vez**, con la tipología de mayor
      rango (D6) y contado una vez en las facetas de tipología y créditos.
- [ ] Si un catálogo falla y el otro no, se ve el que respondió y un `Fault` con
      reintento que vuelve a pedir los dos.
- [ ] `npm test` cubre la regla de D6: divergencia, empate, letra desconocida, código en
      un solo plan.

```
feat(web): unir los catálogos de los dos planes en una sola lista
```

### Fase 4 · Agregar materias de los dos planes

**Archivos**: `web/src/components/AddButton.tsx`, `web/src/views/Program.tsx`.

**Criterio de aceptación**

- [ ] El `+` funciona en las filas de los dos planes, y la materia se guarda con el plan
      de su fila (el ganador de D6 si estaba en los dos).
- [ ] Una materia ya agregada no se puede volver a agregar por el otro plan (D7), con su
      tooltip.
- [ ] En un plan que no es mío, el aviso ofrece "agregar a mis planes" (con cupo) o
      "cambiarme a este" (lleno).
- [ ] **La prueba que importa**: con un grupo elegido en una materia del plan A, las
      materias del plan B que chocan contra él salen marcadas en el catálogo, sin pedir
      nada nuevo al back.

```
feat(web): permitir materias de los dos planes en el mismo semestre
```

### Fase 5 · Leer un semestre mezclado

**Archivos**: `web/src/components/CourseCard.tsx` (+ `.css`),
`web/src/components/CreditsBadge.tsx`, `web/src/lib/credits.ts`.

**Criterio de aceptación**

- [ ] Con un plan, `CourseCard` y `CreditsBadge` se ven **idénticos** a `main`.
- [ ] Con dos, cada tarjeta muestra el código de su plan; las compartidas dicen dónde más
      están y con qué tipología; el tooltip de créditos desglosa por plan y por tipología.
- [ ] El calendario y el `.ics` salen bien con materias de los dos planes (colores por
      materia, sin eje nuevo).

```
feat(web): marcar de qué plan es cada materia con dos titulaciones
```

### Fase 6 · Pulido y poda

- `/ponytail-review` sobre el diff completo y **borrar lo que sobre**. Sospechosos:
  helpers de un solo uso, estado derivable de `plans.length`, cualquier resto de "plan
  activo" (D2) y cualquier `useMemo` sobre una lista de dos elementos.
- Reescribir —no borrar— los comentarios que pasan a ser mentira: `AddButton.tsx:19-21`,
  `planContext.ts:18-21`, `PlanPicker.tsx:94-97`, `PlanProvider.tsx:58-59`,
  `nav.ts:14-19`. En este repo los comentarios explican el porqué; un porqué caducado es
  peor que ninguno.
- Actualizar `web/README.md` ("Decisiones que conviene no deshacer") y este documento a
  **Estado: implementado**.

```
docs(web): actualizar el porqué del estado del plan tras doble titulación
```

---

## Tests

El repo corre `vitest` (`web/package.json` → `npm test`) con una sola suite hoy:
`web/src/lib/conflicts.test.ts`. Se sigue esa forma —funciones puras, sin librería de
render, sin fixtures— con **dos** archivos nuevos:

**`web/src/lib/plans.test.ts`** (Fase 1), un caso por regla que puede romper datos:

1. v1 presente y v2 ausente → migra, conserva el plan, borra la v1.
2. v2 con tres planes guardados a mano → se recorta a `MAX_PLANS`.
3. v2 con dos planes de igual `selectionId` → se deduplica.
4. Basura en la clave (`'{'`, `'[]'`, `null`) → `[]` sin tirar.
5. `removePlan` deja solo las materias del otro plan.

**`web/src/lib/catalog.test.ts`** (Fase 3), la regla de D6, que es la lógica no trivial de
esta rama:

1. Mismo código, `FUND. OBLIGATORIA (B)` en A y `LIBRE ELECCIÓN (L)` en B → una fila, con
   `B`, plan A, y `alsoIn` apuntando a B.
2. Al revés (el obligatorio en el segundo plan) → gana igual el obligatorio.
3. Misma letra en los dos → gana el primero elegido, con `alsoIn` puesto.
4. Letra desconocida o formato raro (`'RARO'`, `''`) → rango 0, no tira.
5. Códigos que están en un solo plan → pasan tal cual.
6. Una sola parte → salida de igual largo y orden que la entrada.

No se testea React: no hay entorno de render en el repo y montarlo sería traer
`@testing-library` entero por un popover. Las fases 2, 4 y 5 se verifican a mano.

---

## Cómo usar los plugins

- **ponytail** (activo por hook, nivel `full`): la escalera manda. Antes de escribir un
  componente nuevo, buscar el que ya existe — `Confirm`, `Tooltip`, `IconButton`,
  `SearchInput`, `.chips`, `.chip.is-on`, `.btn` cubren casi todo. La casilla es un
  `<input type="checkbox">` nativo y el menú es `popover` nativo: **ninguna dependencia
  nueva** en esta rama. Al terminar, `/ponytail-review` (Fase 6).
- **frontend-design**: útil para el menú del chip, la fila de chips "1 de 2" y el chip de
  plan en la tarjeta, **con un guardarraíl**: este repo ya tiene identidad visual cerrada
  en `web/src/styles/tokens.css`, y la skill está pensada para *proponer* una. Se usa para
  jerarquía, espaciado y estados — **no** para elegir tipografías, paletas ni un lenguaje
  visual nuevo. Si el resultado no se puede pintar con los tokens que ya existen, está
  mal.
- **context7**: para dudas de API real —`popover` / `popovertarget`, `<dialog>`,
  React 19— antes que tirar de memoria. `resolve-library-id` → `query-docs`.
- **caveman**: solo estilo de conversación. Commits, cuerpo del PR y comentarios del
  código van en prosa normal, en español, como el resto del repo.

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| La migración v1→v2 falla y alguien pierde plan y semestre | Primer criterio de la Fase 1, con test. `loadPlans` nunca tira: ante la duda devuelve `[]`, y el peor caso es volver a elegir el plan — el semestre vive en otra clave que no se toca |
| La regla de tipología esconde grupos (D6) | Es una consecuencia real y declarada: la tarjeta dice dónde más está la materia. Si molesta en uso, la salida es fusionar los grupos de las dos consultas de detalle — más peticiones, se decide con datos |
| Dos catálogos = ~700 KB y dos misses fríos la primera vez | Los dos van en paralelo y la pantalla de carga ya explica el costo. La segunda visita sale de Postgres |
| La casilla se lee como ruido para la mayoría | Es una casilla sin marcar, sin decisión forzada y sin desplazar la lista. Si molesta, baja al pie del bloque de "Nivel" |
| La mayoría de un solo plan nota el cambio | Criterio repetido en las fases 2, 3 y 5: con un plan, idéntico a `main` salvo la casilla. Si algo más cambia, es un bug de la rama |
| 15 materias entre dos planes se quedan cortas | Es una constante (D8). Se sube cuando aparezca el caso, no antes |

---

## Preguntas abiertas

Ninguna bloquea la implementación: cada una tiene un default puesto en el plan.

1. **`TRABAJO DE GRADO (P)` y `NIVELACIÓN (E)` no entran en "obligatorio > optativo >
   libre elección".** Default asumido: `P` por encima de las obligatorias (es requisito de
   grado) y `E` por debajo de libre elección (es nivelación, no cuenta como avance).
   Cambiar esto es cambiar una tabla de 7 filas en `lib/typology.ts`.
2. **Si un código está en los dos planes, ¿basta con quedarse con los grupos del plan
   ganador?** Los grupos visibles dependen del programa, así que el ganador puede mostrar
   menos. Default: sí, y se avisa en la tarjeta. La alternativa —pedir el detalle a los
   dos planes y unir los grupos— duplica peticiones para un caso de borde.
3. **Los mínimos de créditos (6 para inscribir, 10 para cerrar) ¿son por plan o por la
   inscripción completa?** Default: total global, desglose por plan solo informativo (D9).
   **No inventar la regla.**
4. **¿La doble titulación puede cruzar sedes o niveles?** El modelo lo soporta —cada
   `PlanItem` lleva su `campus`, `faculty` y `level`, y el detalle se pide con los del item
   (`useCourseDetails.ts:127-129`)—, así que no hay nada que hacer salvo no asumir lo
   contrario en el copy.

---

## Checklist antes del PR

- [ ] `npx tsc -b --noEmit` limpio
- [ ] `npx oxlint` limpio
- [ ] `npm test` verde
- [ ] Probado a mano con **un** plan: la única diferencia contra `main` es la casilla
- [ ] Probado a mano con **dos** planes: elegirlos de una, buscar en el catálogo unido,
      un código compartido apareciendo una sola vez con la tipología correcta, agregar de
      los dos, choque cruzado, quitar uno, exportar `.ics`
- [ ] Probado con `localStorage` de un usuario viejo (v1) — la migración
- [ ] `/ponytail-review` pasado y aplicado
- [ ] Comentarios que decían "un solo plan" reescritos, no borrados

**Título del PR** (es lo que lee `semantic-release`):

```
feat(web): soporte para doble titulación
```
