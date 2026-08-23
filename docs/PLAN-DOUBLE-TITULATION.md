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
| **Dos planes** (la minoría) | Que exista, y enterarse al empezar | No enterarse hasta tener el semestre armado; y una vez adentro, pagar peaje de pestañas y menús cada vez que busca una materia |

Todo lo que sigue está subordinado a esas dos reglas a la vez:

1. **Con un solo plan, el flujo es el de hoy, clic por clic.** Cambian dos cosas y
   ninguna más (lista exacta abajo). Buscar, agregar, medir cupos, armar el horario,
   exportar: ni un píxel.
2. **Con dos, no hay modo aparte.** Se declara **al empezar**, se eligen los dos planes
   ahí mismo, y después la app es la misma: **un catálogo, un semestre, un horario**.

### Los dos cambios que ve la mayoría

Ni uno más. Si aparece un tercero, es un bug de la rama:

| # | Qué ve | Dónde | Por qué |
|---|---|---|---|
| 1 | Una **casilla sin marcar**, "Estudio doble titulación" | `PlanPicker`, sobre "Nivel" | Es la puerta de la minoría, y la única forma de que se enteren de que existe. No pide decisión: se ignora y la pantalla se comporta igual que hoy |
| 2 | El tope de materias pasa de **10 a 20** | `AddButton`, `Semester` | Decisión explícita (D8). Toca a todos porque el costo de medir no depende de cuántos planes haya |

Los dos son deliberados. El resto de la interfaz —la barra, el catálogo, la ficha, Mi
semestre, Mi horario, el calendario, el `.ics`, los filtros, el orden, los cupos— queda
**idéntico a `main`** para quien tiene un plan: todo lo nuevo va detrás de
`plans.length > 1`.

**Y no hay ninguna forma nueva de llegar a ningún lado.** Nada de menús nuevos en la
barra, ni de "agregar un segundo plan" a mitad de semestre: la doble titulación se declara
al empezar y se eligen los dos planes de una. Quien ya venía con un plan y quiere pasar a
dos, empieza de nuevo — el mismo botón destructivo que existe hoy, con la misma
confirmación. Ver [Declararse tarde](#declararse-tarde-se-empieza-de-cero).

---

## La forma de la solución, en una frase

**Dos planes son dos fuentes para el mismo horario y la misma inscripción. No se duplica
nada.**

De ahí sale todo lo demás. El doble titulación no navega dos catálogos: navega uno que es
la suma de los dos. No hay pestañas, no hay "plan activo", no hay que acordarse de en cuál
se está. Se declara la doble titulación con una casilla al elegir plan, se eligen dos, y
de ahí en adelante el catálogo es la unión de los dos conjuntos de asignaturas, con una
única regla para los códigos que aparecen en los dos: **la tipología de mayor rango
manda**.

Eso es lo que hace que la feature no cueste nada de aprender — y, de paso, hace el código
**más chico** que la alternativa de pestañas: sin plan activo no hay estado que guardar,
que persistir ni que sincronizar.

Y marca el límite de hasta dónde llega este tablero: **somos informativos, no somos el
SIA.** No inscribimos a nadie ni decidimos por cuál plan queda una materia; eso pasa en
el SIA y no acá. Lo nuestro es mostrar el dato correcto y decir de dónde salió. Por eso,
cuando una asignatura está en los dos planes, se le da el rango más alto y **se aclara a
qué plan la estamos atribuyendo** — y ahí se acaba nuestra responsabilidad. Nada de
botones para "cambiarla de plan": sería fingir un control sobre la inscripción que no
tenemos.

---

## La invariante: una materia, una sola fila

**Lo más importante de todo el plan.** Si algo de esta rama se implementa a medias, que
no sea esto:

> Nadie ve nunca la misma asignatura dos veces por estar en los dos planes. Ni en el
> catálogo, ni en Mi semestre, ni en el horario, ni en los conteos.

No es cosmético. Una persona inscribe la asignatura **una vez, por un solo plan**; dos
filas serían dos formas de agregar la misma clase, dos bloques idénticos pisados en el
calendario y créditos contados dos veces. Es la diferencia entre un tablero que suma dos
planes y uno que dice mentiras.

**La clave de identidad es `code`**, no `itemId`. `itemId` lleva el plan adentro
(`storage.ts:75-77`), así que la misma asignatura desde dos planes son dos `itemId`
distintos: perfecto para no colisionar en el estado, inútil para deduplicar de cara a la
persona. Lo que hay que comparar es el código de la asignatura.

Y `code` alcanza **porque los dos planes son de la misma sede**
([D3](#d3--dos-planes-misma-sede-y-mismo-nivel)): la identidad de una asignatura en la
base es `(campus_code, code)`, no `code` a secas.

Dónde se garantiza, superficie por superficie:

| Superficie | Cómo | Dónde |
|---|---|---|
| Catálogo | `mergeCatalogs` colapsa por `code` antes de pintar; el mapa se llena recorriendo las partes **en orden**, así que también absorbe una repetición dentro de un mismo plan | D5, D6 |
| Botón `+` | `PlanProvider.add()` rechaza un `code` que ya esté en la lista, venga del plan que venga | D7 |
| Mi semestre / Mi horario | Salen de `plan.items`, que ya no puede tener dos con el mismo `code` | D7 |
| Calendario y `.ics` | Salen de los mismos `items` | — |
| Créditos y facetas | Cuentan filas, y hay una sola por asignatura | D9 |
| Datos viejos en el navegador | `loadPlan()` deduplica por `code` al leer, igual que ya valida tipos | Fase 1 |

Las dos primeras filas son las que hacen el trabajo; las demás salen gratis de que las
dos primeras se cumplan. La última es cinturón: hoy no puede haber duplicados guardados
—había un solo plan— pero leer sin validar es exactamente cómo este repo se ha negado a
trabajar (`storage.ts:44-53`).

Y cuando hay una sola fila para dos planes, hay que decir de cuál es y dejar cambiarla:
eso es [D6](#d6--qué-plan-gana-cuando-un-código-está-en-los-dos) y la
[interfaz §6](#6-coursecard--de-qué-plan-es-dónde-más-está-y-cómo-cambiarla).

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
│ SIA Bridge      [2A74 · 2B10 🗑]         ▤  ☑  📅  ☕  ◐│  ← el mismo chip de hoy,
├────────────────────────────────────────────────────────┤     con los dos códigos
│  plan 2A74 · 2B10                                      │
│  Catálogo                                  988 asignat.│  ← la unión, deduplicada
│  [buscar…] [tipología ▾] [créditos ▾] [con cupo]       │  ← los mismos filtros
└────────────────────────────────────────────────────────┘
```

- **Un solo buscador** para las materias de los dos planes.
- **Un solo "Mi semestre"** y **un solo "Mi horario"**, como ya son hoy.
- Sin pestañas, sin plan activo, sin menús nuevos, sin cambiar de contexto.
- El chip de la barra hace **exactamente lo de hoy** —empezar de nuevo, con su
  confirmación—; lo único distinto es que lista los dos códigos.

### Declararse tarde: se empieza de cero

No hay puerta lateral. Quien ya venía con un plan y descubre que puede tener dos usa el
mismo camino que existe hoy para cambiar de plan: **empezar de nuevo** desde el chip de la
barra, que borra plan y semestre con su confirmación de siempre, y volver a elegir — ahora
marcando la casilla y eligiendo los dos.

Es deliberado, y es lo que mantiene la promesa de arriba:

- **No aparece ningún control nuevo** para la mayoría. Un menú de planes en la barra
  habría sido un elemento nuevo en la pantalla de todos para servir a unos pocos.
- **No hay un segundo camino** por el que un plan entre a la lista, así que no hay dos
  formas de llegar al mismo estado que puedan divergir.
- El semestre armado con un plan **no sirve tal cual** para dos: las materias que ya
  estaban se quedan igual, sí, pero la persona va a rehacer su selección con el doble de
  catálogo a la vista. Conservarlo a medias sería el peor de los dos mundos.

Costo: quien se declara tarde rearma su semestre. Es una acción de una vez por semestre,
sobre una lista de materias que se rehace en un par de minutos, y a cambio la app no
carga con un flujo entero —agregar y quitar planes en caliente— que solo existiría para
ese caso.

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

### D3 · Dos planes, **misma sede y mismo nivel**

Doble titulación son dos, y la casilla lo dice literalmente. Con dos elegidos, las filas
de la lista quedan deshabilitadas hasta que se suelte una — mismo patrón de botón apagado
+ tooltip que ya usa `AddButton` con `MAX_ITEMS`.

```ts
// ponytail: tope duro de 2, sube a N cambiando la constante si aparece el caso
export const MAX_PLANS = 2;
```

**Y los dos son de la misma sede y del mismo nivel**: la doble titulación no cruza sedes
ni mezcla pregrado con posgrado. No es una suposición nuestra, es cómo funciona, así que
se hace cumplir en vez de confiar:

- En el picker, elegido el primer plan, **la sede y el nivel quedan fijos** y sus chips se
  deshabilitan con una nota corta ("la doble titulación es dentro de una sede y un
  nivel"). Un estado imposible que no se puede tipear es mejor que uno validado después.
- `select()` rechaza —devuelve `false` y no toca nada— una lista de dos planes que no
  compartan sede y nivel. El guardia va en la función compartida, no en la pantalla.

No es solo higiene de dominio: **es lo que hace segura la deduplicación por `code`**. La
identidad de una asignatura en la base es `(campus_code, code)` (`DATA-MODEL.md`, tabla
`course`), así que dentro de una sede el código identifica y entre sedes no. Con los dos
planes en la misma sede, además, **`name` y `credits` de una asignatura compartida son
por definición idénticos** en los dos: viven en `course`, que es por sede, no en
`course_program`. Lo único que puede diferir es la tipología y qué grupos se ven — que es
exactamente lo que resuelve D6, y nada más.

### D4 · Los planes se eligen **de una sola vez**, y cambiarlos borra el semestre

No hay "agregar un segundo plan" ni "quitar uno" en caliente: el conjunto de planes se
fija al elegirlo y no se toca más. Es la regla de hoy, con "un plan" cambiado por "el
conjunto de planes":

| Acción | Efecto sobre `items` |
|---|---|
| Elegir el mismo conjunto otra vez | **ninguno** — igual que hoy al re-elegir el mismo plan |
| Elegir un conjunto distinto | borra todo, con la confirmación de siempre |
| Empezar de nuevo | borra todo, como hoy |

Así **la única operación sigue siendo `select()`**, ahora sobre una lista de 1 o 2. No
entran al modelo `addPlan`, `removePlan` ni `plansFull`: la pantalla que elige maneja su
propio borrador —el chip "1 de 2"— y recién al final llama a `select([a, b])` una vez.

> Descartado (era la propuesta anterior de este documento): agregar y quitar planes a
> mitad de semestre, con su menú en la barra. Metía un control nuevo en la pantalla de
> todos para servir a unos pocos, un segundo camino para llegar al mismo estado, y tres
> operaciones más en `PlanApi`. Quien se declara tarde empieza de nuevo, que es el camino
> que ya existe. Ver [Declararse tarde](#declararse-tarde-se-empieza-de-cero).

### D5 · El catálogo es la **unión** de los dos, deduplicada por código

Con dos planes, `Program` pide los dos catálogos (`useApi` acepta `null`, así que son dos
llamadas fijas sin hooks condicionales) y los fusiona en memoria. Cada fila recuerda de
qué plan salió, que es lo que después arma su `PlanItem`.

Los códigos que existen en los dos planes **aparecen una sola vez** — ver
[La invariante](#la-invariante-una-materia-una-sola-fila), que es lo primero que hay que
leer de este plan.

> Descartado: dos listas, una debajo de otra, con encabezado por plan. Rompe el orden,
> rompe el buscador y duplica los códigos compartidos, que es justo lo que hay que
> resolver.

### D6 · Qué plan gana cuando un código está en los dos: **el de mayor rango**

Que pase está confirmado: de 22 códigos compartidos entre planes de Bogotá, **8 divergen
en tipología** (`GOTCHAS.md` §17). Gana la tipología de mayor rango, y con ella su plan.
Empate → el primer plan elegido.

La letra entre paréntesis es la clave estable, no la frase (el SIA cambia de vocabulario
entre vistas, `GOTCHAS.md` §17): `FUND. OBLIGATORIA (B)` → `B`.

| Rango | Tipología (literal del SIA) | Letra |
|---:|---|---|
| 4 | `TRABAJO DE GRADO` | `P` |
| 3 | `NIVELACIÓN` | `E` |
| 2 | `FUND. OBLIGATORIA`, `DISCIPLINAR OBLIGATORIA` | `B`, `C` |
| 1 | `FUND. OPTATIVA`, `DISCIPLINAR OPTATIVA` | `O`, `T` |
| 0 | `LIBRE ELECCIÓN`, y cualquier letra desconocida | `L`, … |

> `NIVELACIÓN` por encima de las obligatorias es deliberado, no un descuido de
> ordenamiento: bloquea el avance del plan, así que es lo más urgente de inscribir. No lo
> "arregles" en un refactor.

**Por qué el rango y no "el plan que ve más grupos"**, que era la propuesta anterior de
este documento: porque no inscribimos a nadie. Un criterio que mira cuántos grupos ve
cada plan estaría optimizando una decisión —por cuál plan queda la materia— **que se toma
en el SIA, no acá**. El rango, en cambio, responde la única pregunta que este tablero sí
tiene que contestar bien: *qué es esta materia para vos, lo más exigente que sea en
alguno de tus dos planes*. Y de paso se ahorra el `?include=schedules` extra, un conteo
que a veces no existe, y un resultado que cambiaba entre visitas.

Consecuencias:

- **`PlanItem.typology` es el literal del plan ganador**, crudo, tal como lo manda el
  SIA. No se normaliza ni se traduce: es dato de ellos (convención de idioma,
  `CLAUDE.md`).
- **El desglose de créditos cuenta la materia una sola vez**, en la tipología del plan
  ganador.
- **Los grupos que se ven son los del plan ganador.** Los grupos visibles dependen del
  programa (subconjunto estricto, `CLAUDE.md`), así que el otro plan podría ver alguno
  más. No lo perseguimos: lo que se hace es **decir de qué plan estamos hablando** — en
  la ficha de la materia y en el hover de la tarjeta (interfaz §6 y §7). Ahí se acaba
  nuestro trabajo.
- Determinismo: el resultado depende solo de la tipología y del orden de elección de los
  planes, así que **es el mismo en cada carga**, sin importar qué respuesta llegó primero
  ni qué se midió antes.
- **Filtrar por `LIBRE ELECCIÓN (L)` ya no muestra las materias que el otro plan tiene
  como obligatorias.** Es correcto, no un efecto colateral: si es obligatoria de uno de
  tus planes, la vas a cursar como obligatoria, no como electiva. El filtro dice la
  verdad de lo que esa materia es *para vos*.

Y una nota de volumen: la unión **no es la suma**. La mitad de libre elección de cada
catálogo sale del buscador de electivas, que es por sede (`API.md`), así que los dos
planes comparten cientos de códigos —casi todos con la misma tipología en los dos, y por
eso empatados—. Dos planes de ~694 asignaturas no dan 1 388 filas: dan bastantes menos.

### D7 · Una asignatura, un plan: no se agrega dos veces el mismo `code`

La segunda mitad de [la invariante](#la-invariante-una-materia-una-sola-fila). La
deduplicación de D5 ya hace imposible agregarla dos veces desde el catálogo; el guardia va
igual **en `PlanProvider.add()`**, porque la ficha de la materia también agrega, porque
un `localStorage` viejo puede traer la lista ya duplicada, y porque es donde pasan todos
los caminos. Es una línea:

```ts
if (prev.some((i) => i.code === item.code)) return prev;
```

Por `code`, **no** por `itemId`: comparar `itemId` dejaría entrar la misma asignatura una
vez por cada plan, que es justo lo que hay que impedir.

### D8 · El tope de materias sube a **20**, para todos

`MAX_ITEMS` (`planContext.ts:6`) es un presupuesto de mediciones contra el SIA —una
petición de detalle por materia, pool de 4—, no una cuota académica. La lista es una
**preselección**: con 10 se queda sin espacio para comparar candidatas, que es para lo
que existe el tablero, y con dos planes se queda corta antes todavía.

**Un solo número, no uno por cardinalidad de planes**: nada en el costo de medir depende
de cuántos planes haya, y dos constantes serían dos cosas que mantener sincronizadas para
no ganar nada.

Y **es un límite nuestro, no de la universidad**: los estatutos ponen mínimos (6 y 10
créditos), no máximos. El texto que lo explica —el tooltip de `AddButton`— tiene que
sonar a límite de la app, nunca a regla académica.

```ts
/** Tope deliberado: 20. El techo real es la ronda de medición —una petición
 *  de detalle por materia, 4 en paralelo—, ~7 s con la barra de progreso a la
 *  vista. Es un planificador de semestre, no una lista de deseos.
 *  ponytail: si la ronda se siente lenta, este número es la perilla. */
export const MAX_ITEMS = 20;
```

**Hay tres sitios con el `10` escrito a mano** que pasan a leer la constante, o la
pantalla va a mentir: `Semester.tsx:49` (`{plan.full && ' de 10'}`), `AddButton.tsx:47`
("Hasta 10 materias a la vez") y el comentario de `planContext.ts:5`.

### D9 · Los créditos suman por **inscripción completa**, no por plan

Confirmado: los mínimos de los estatutos (6 para inscribir, 10 para cerrar,
`credits.ts:10,16`) se miden sobre la inscripción entera, no plan por plan. Así que
`CreditsBadge` **no cambia de lógica**: mismo total, mismo semáforo, mismos umbrales, con
las materias de los dos planes sumadas.

Lo único que gana, con dos planes, es un desglose por plan en el tooltip que ya despliega
el de tipología. Es informativo: **no** hay semáforo por plan, porque no hay regla por
plan que semaforear.

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
/** La clave vieja. Se lee para migrar y NO se borra: es el seguro de
 *  rollback. Ver "Compatibilidad" más abajo. */
const PICK_KEY_V1 = 'tablero.plan.v1';

export function loadPlans(): Selection[];        // migra de v1 si hace falta
export function savePlans(p: Selection[]): void; // vacío ⇒ borra las dos claves
```

Reglas de `loadPlans()`, en este orden:

1. **Si hay v2 válida, manda v2** —siempre, sin mirar la v1—; cada plan se valida campo
   por campo como ya hace `loadSelection` (`storage.ts:115-132`). Nunca confiar en lo
   guardado.
2. Se deduplica por `selectionId` y se recorta a `MAX_PLANS`.
3. Si no hay v2 pero sí v1: `[loadSelection()]` y se escribe la v2. **La v1 se deja donde
   está** (ver [Compatibilidad](#compatibilidad-con-lo-que-ya-hay-en-los-navegadores)).
   Esta migración es lo único que separa a un usuario actual de perder su plan al
   desplegar.
4. Sin nada: `[]`.

La regla 1 es la que hace que la 3 sea segura: con la v1 viva pero ignorada, nada puede
resucitar un plan viejo por encima del actual.

`clearStored()` (`storage.ts:158-168`) sí borra **las dos** claves: empezar de nuevo tiene
que dejar el navegador como estaba antes de la primera visita, y ahí no hay rollback que
proteger.

> **La clave del semestre —`tablero.semestre.v2`— no se toca.** `PlanItem` no cambia de
> forma, y bumpearla le borraría el semestre a todo el mundo por nada.

`loadPlan()` (la lista de materias, `storage.ts:38-57`) gana **una** línea: después de
filtrar por tipos, deduplica por `code` quedándose con la primera. Es el cinturón de
[la invariante](#la-invariante-una-materia-una-sola-fila) contra un `localStorage`
manipulado o venido de una versión futura; no debería disparar nunca.

### `web/src/state/planContext.ts`

```ts
export const MAX_PLANS = 2;
export const MAX_ITEMS = 20;  // uno solo, para uno y para dos planes (D8)

export type PlanApi = {
  // ── sin cambios ─────────────────────────────────────────────
  items: PlanItem[];
  has: (id: string) => boolean;
  add: (item: Omit<PlanItem, 'addedAt'>) => boolean;  // + guardia D7
  remove: (id: string) => void;
  clear: () => void;
  full: boolean;                    // items.length >= MAX_ITEMS (20, D8)
  /** El primer plan. Mismo significado de siempre para quien tiene uno. */
  selection: Selection | null;

  // ── nuevo: dos campos, y ninguna operación de más ────────────
  /** Mis planes, en orden de elección. 1 o 2 (o 0 antes de elegir). */
  plans: Selection[];
  owns: (s: Pick<Selection, 'level' | 'campus' | 'program'>) => boolean;
  /**
   * Fija el conjunto de planes. Uno o dos, de una sola vez (D4).
   *
   * Mismo conjunto que ya estaba ⇒ no borra nada (es volver al tablero).
   * Conjunto distinto ⇒ borra el semestre entero, como hoy; quien llama ya
   * confirmó. Devuelve false y no toca nada si los dos no comparten sede y
   * nivel (D3), o si son más de MAX_PLANS.
   */
  select: (next: Selection[]) => boolean;
};
```

`ScheduleProvider` (`ScheduleProvider.tsx:31-40`) **no se toca**: poda por `plan.items`,
así que al quitar un plan los grupos elegidos de sus materias se limpian solos.
Verificarlo es criterio de aceptación de la Fase 1, no código nuevo.

### `web/src/lib/typology.ts` (nuevo, ~15 líneas)

```ts
/** La letra entre paréntesis: 'FUND. OBLIGATORIA (B)' → 'B'. Es lo estable;
 *  la frase cambia de vocabulario entre vistas del SIA (GOTCHAS §17).
 *  Sin paréntesis o vacío → '' (rango 0, no tira). */
export function typologyLetter(raw: string): string;

/** Rango de exigencia (D6): P=4, E=3, B|C=2, O|T=1, todo lo demás 0. */
export function typologyRank(raw: string): number;
```

### `web/src/lib/catalog.ts` (nuevo, ~40 líneas)

```ts
export type MergedCourse = CourseSummary & {
  /** De qué plan salió esta fila: lo que arma su PlanItem y su itemId, y lo
   *  que se le dice a la persona (interfaz §6 y §7). */
  plan: Selection;
  /** El mismo código visto desde el otro plan, si estaba. Solo informativo:
   *  con qué tipología aparece allá. */
  alsoIn?: { plan: Selection; typology: string };
};

/** Une los catálogos de 1 o 2 planes. Dedup por `code` con la regla de D6.
 *  Con un solo plan es un map sobre la lista: mismo orden, mismo largo, sin
 *  `alsoIn`. */
export function mergeCatalogs(
  parts: { plan: Selection; courses: CourseSummary[] }[],
): MergedCourse[];
```

El desempate entero es esto (D6):

```ts
// `a` viene del plan elegido primero. En empate se queda `a`.
const wins = (a: CourseSummary, b: CourseSummary) =>
  typologyRank(a.typology) >= typologyRank(b.typology);
```

El orden de `parts` **es** el orden de elección de los planes, así que recorrer en orden y
no reemplazar en caso de empate ya da el desempate estable. Nada de `Math.random`, nada de
"el que llegó primero por la red": el resultado es el mismo en cada carga.

---

## Compatibilidad con lo que ya hay en los navegadores

Esto se despliega sobre gente que ya tiene su plan y su semestre guardados, y sobre
pestañas abiertas en ese momento. Nada de eso puede romperse.

### Las seis claves, y cuál se mueve

| Clave | ¿Cambia? | Qué ve un build viejo |
|---|---|---|
| `tablero.semestre.v2` (las materias) | **no**, ni la clave ni la forma | lo mismo de siempre |
| `tablero.plan.v1` (el plan) | se lee para migrar y **se deja**; ya no se escribe | su plan de siempre |
| `tablero.planes.v2` (los planes) | nueva | nada: no la conoce y la ignora |
| `tablero.horario.v1` (grupo elegido) | no | lo mismo |
| `tablero.orden.v1` (orden de tablas) | no | lo mismo |
| `tablero.horario.ancho.v1` | no | lo mismo |

**Una sola clave nueva y ninguna clave vieja rota.** `PlanItem` no cambia de forma, así
que el semestre —lo que de verdad duele perder— ni se toca.

### Caso 1 · Recarga normal después del deploy

Es lo que le pasa a todo el mundo. `loadPlans()` encuentra v1, escribe v2 y sigue. El
plan y las materias quedan donde estaban, y la persona no se entera de nada salvo por la
casilla nueva en la pantalla de elegir plan.

### Caso 2 · Una pestaña abierta durante el deploy

El bundle es **uno solo** (`dist/assets/index-*.js`, sin `import()` dinámicos) y **no hay
service worker**, así que una pestaña viva tiene todo el código en memoria y sigue
funcionando con el modelo viejo hasta que alguien la recargue. No hay chunks que se
pidan tarde y devuelvan 404 porque el `dist/` del servidor ya se reemplazó.

Lo que sí comparten una pestaña vieja y una nueva es `localStorage`:

- **Las materias**: misma clave, misma forma. La pestaña vieja puede terminar viendo
  materias de dos planes y no se rompe — su `+` deshabilita las que considera ajenas y su
  tope de 10 solo impide agregar, nunca esconde lo guardado.
- **El plan**: la vieja lee y escribe v1, la nueva v2. Cada una con su clave, sin
  pisarse, y la regla "si hay v2, manda v2" impide que una escritura tardía de la vieja
  resucite nada.
- Lo único que queda cojo: "empezar de nuevo" **desde la pestaña vieja** borra la v1 pero
  no la v2, así que el plan reaparece. Es una pestaña que quedó atrás; recargar lo
  arregla. No se hace nada por eso.

### Caso 3 · Rollback del deploy

El que obliga a **no borrar la v1**. Si volvemos al build anterior con la v1 borrada, ese
build no encuentra plan, muestra el onboarding, y al elegir uno cae en la rama de
"adoptar sin plan previo" (`PlanProvider.tsx:80-87`), que **filtra `items` y borra en
silencio las materias que no son de ese plan**. Es decir: el rollback le costaría a un
doble titulación la mitad de su semestre.

Con la v1 intacta, el build viejo se reencuentra con el plan de siempre, no filtra nada,
y lo peor que pasa es que el segundo plan queda invisible hasta que se vuelva a
desplegar.

Costo de dejarla: una clave muerta de ~200 bytes. **Se borra en un commit aparte
(`chore:`), un release después**, cuando el deploy nuevo esté firme — no antes, y no
"aprovechando" este PR.

### La API no entra en esto

No cambia el contrato, así que **no hay que coordinar el orden de los despliegues**: un
cliente viejo y uno nuevo le hablan igual al mismo servidor, y `web` y `api` son imágenes
separadas (`docs/PLAN-CI-CD.md`). Es la ventaja de que la feature sea 100% de front.

---

## La interfaz, pantalla por pantalla

### 1. `PlanPicker` · la casilla

Va debajo del párrafo de entrada (`PlanPicker.tsx:160-171`) y encima de "Nivel", como
`<input type="checkbox">` nativo con su `<label>` — no un toggle pintado:

> ☐ **Estudio doble titulación** — elige tus dos planes; el horario los junta.

Estado local (`useState`), **no** entra a `nav.ts` ni a `localStorage`: nace de lo que ya
hay (`plans.length > 1`) al montar, así que volver a esta pantalla la encuentra marcada
sola.

**Toda la elección de dos planes vive en un borrador local de esta pantalla**
(`const [draft, setDraft] = useState<Selection[]>([])`), y `plan.select()` se llama **una
sola vez**, con la lista completa. Es lo que evita que existan estados intermedios
guardados: mientras no haya dos, no se tocó nada de lo que hay en el navegador.

Con la casilla **sin marcar** (la mayoría): la pantalla es la de hoy, con `choose()`
llamando a `select([p])` — que reemplaza el plan único, con la confirmación de siempre si
hay materias guardadas. Ni un clic de diferencia.

Con la casilla **marcada**:

- El primer clic en un plan **no navega**: lo mete al borrador y lo muestra como chip con
  su `×`, con el contador "1 de 2".
- **Con el primero elegido, la sede y el nivel se congelan** (D3): sus chips quedan
  deshabilitados con la nota "la doble titulación es dentro de una sede y un nivel". El
  `×` del chip los descongela.
- El segundo clic llama a `select([a, b])` y navega al catálogo. Con los dos escalones
  fijos, está literalmente a un clic del primero.
- Los planes ya en el borrador salen marcados y deshabilitados en la lista
  (`PlanPicker.tsx:291-293`, `mine` mira el borrador y no solo `plans`).

**Marcarla o desmarcarla nunca borra nada por sí sola**: solo cambia cómo se comporta el
próximo clic en un plan. Quien tenía dos planes y desmarca, elige uno y ese `select([p])`
—un conjunto distinto— es el que borra, con la confirmación de siempre. La casilla no es
una acción, es un modo de elegir.

### 2. Catálogo (`views/Program.tsx`) · la unión

```tsx
const mine = plan.owns(sel) ? plan.plans : [sel];   // plan ajeno ⇒ solo ese

// `inc` no cambia: sigue siendo 'schedules' solo cuando hay horario armado
// contra el que chocar (Program.tsx:60-81). La fusión no lo necesita.
const a = useApi<CoursesResponse>(routes.courses(scope(mine[0]), mine[0].program, inc));
const b = useApi<CoursesResponse>(
  mine[1] ? routes.courses(scope(mine[1]), mine[1].program, inc) : null,
);

const courses = useMemo(() => mergeCatalogs([...]), [a.data, b.data, mine]);
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

### 3. La barra · el chip lista los dos, y hace lo mismo de siempre

**No hay menú.** El chip (`Topbar.tsx:104-112`) sigue siendo lo que es hoy: rótulo y
botón de "empezar de nuevo", con su caneca y su confirmación. Lo único que cambia es que
con dos planes muestra los dos códigos.

```
[2A74 · 2B10  Bogotá 🗑]
```

- Con un plan se ve **exactamente igual que en `main`**, hasta el ancho.
- Con dos, los códigos van juntos y el nombre largo del plan se cae: no caben dos y el
  código es lo que identifica. El nombre completo queda en el `title`/tooltip.
- El texto de la confirmación de "empezar de nuevo" (`Topbar.tsx:40-73`) menciona los dos
  planes y el total de materias — es la misma frase, en plural.
- Móvil: `.tabbar` (`components/TabBar.tsx`) **no cambia**.

> Descartado: el menú de planes con "agregar", "quitar" y "cambiar". Es el control nuevo
> que la mayoría no pidió, y con D4 no tiene nada que ofrecer: los planes se eligen de
> una sola vez. Sin él, esta rama no agrega **ni un elemento** a la barra.

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

### 5. Catálogo ajeno · igual que hoy, con `owns` en vez de igualdad

`foreign` (`Program.tsx:386`) pasa de "no es mi plan" a **"no es ninguno de mis planes"**
(`!plan.owns(sel)`). Ahí el catálogo se pinta solo (no unido) y el aviso es el de hoy,
palabra por palabra, con sus dos salidas: "volver al mío" y "cambiarme a este" — que
llama a `select([sel])`, borra el semestre y confirma antes, como siempre.

**No aparece un "agregar a mis planes"**: agregar un plan a mitad de sesión no existe
(D4).

### 6. `CourseCard` y las filas del catálogo · de qué plan es, al pasar el mouse

Con `plans.length > 1`, un chip con el código del plan al lado del código de la
asignatura (`.chip__code`, ya existe). Con un plan, nada de esto se dibuja.

El chip lleva `Tooltip` —el componente que ya existe— y ahí va la aclaración, que es
**todo** lo que se dice al respecto en una lista:

> **Se cuenta en 2A74** como `FUND. OBLIGATORIA (B)`
> También está en 2B10, como `LIBRE ELECCIÓN (L)`.

**La segunda línea solo cuando la tipología del otro plan es distinta**, no cada vez que
haya `alsoIn`. El motivo es de volumen: la mitad de libre elección del catálogo sale del
buscador de electivas, que es **por sede** (`API.md`, "sin filtro son dos POSTs"), así que
los dos planes comparten cientos de códigos con la **misma** tipología. Decir "también
está en 2B10, como `LIBRE ELECCIÓN (L)`" en cada uno de esos sería ruido puro: el chip ya
dice a qué plan se atribuye, y no hay ninguna diferencia que aclarar.

**Sin botones**: no hay "cambiar de plan", no hay acción. Somos informativos (D6); quien
decide por cuál plan queda la materia es el SIA al inscribir, y fingir lo contrario con un
botón sería peor que no decir nada.

### 7. `Course` (la ficha) · lo mismo, dicho entero

`views/Course.tsx` ya recibe el plan desde el que se abrió (`screen.selection`, que con la
unión es el plan ganador). Con dos planes, y solo con dos, una línea bajo el encabezado —
no un tooltip, que acá hay sitio de sobra:

> Esta asignatura se está contando en tu plan **2A74** (`FUND. OBLIGATORIA (B)`). En 2B10
> figura como `LIBRE ELECCIÓN (L)`. Los grupos de abajo son los que ve 2A74.

Es el lugar donde importa decirlo completo: la ficha es donde alguien mira los grupos uno
por uno antes de inscribirse, así que es donde tiene que quedar claro **desde qué plan se
está mirando** — sobre todo porque los grupos visibles dependen del programa (D6).

Un detalle de implementación que hay que aceptar en vez de pelear: **el "en 2B10 figura
como…" solo se sabe si se llegó desde el catálogo**, que es de donde sale `alsoIn`.
Abriendo la ficha desde Mi semestre o Mi horario, la pantalla solo tiene el `PlanItem` —
que lleva su plan y su tipología, no la del otro— y entonces la línea se queda en su
primera mitad, que es la que importa. **No se pide el otro catálogo para completarla**:
sería una petición de ~350 KB para una frase.

### 8. `CreditsBadge` · el desglose gana una sección

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

- [ ] Con `tablero.plan.v1` y **sin** v2: al cargar, el plan y las materias siguen ahí, y
      aparece `tablero.planes.v2`.
- [ ] La v1 **sigue existiendo** después de migrar (seguro de rollback), y con las dos
      claves presentes manda siempre la v2 — aunque la v1 diga otro plan.
- [ ] `select([a, b])` guarda los dos planes; llamarlo con el **mismo conjunto** no borra
      el semestre, y con un conjunto distinto lo borra entero (D4).
- [ ] `select()` devuelve `false` y no toca nada si los dos planes no comparten sede y
      nivel, o si son más de `MAX_PLANS` (D3).
- [ ] `add()` devuelve `false` si ya hay una materia con el mismo `code` **aunque sea de
      otro plan** (D7 — por `code`, no por `itemId`), y el tope son 20 materias con uno o
      con dos planes (D8).
- [ ] `loadPlan()` con dos materias del mismo `code` guardadas a mano devuelve una.
- [ ] Los tres `10` escritos a mano —`Semester.tsx:49`, `AddButton.tsx:47` y el comentario
      de `planContext.ts:5`— leen la constante: con 20 materias la pantalla dice 20.
- [ ] "Empezar de nuevo" deja el `localStorage` sin `tablero.plan.v1`,
      `tablero.planes.v2`, `tablero.semestre.v2`, `tablero.orden.v1`,
      `tablero.horario.v1` ni `tablero.horario.ancho.v1`.

```
feat(web): guardar varios planes de estudios en vez de uno
```

### Fase 2 · La casilla: declarar doble titulación y elegir dos

**Archivos**: `web/src/views/PlanPicker.tsx` (+ `.css`), `web/src/components/Topbar.tsx`
(+ `.css`).

Interfaz §1 y §3. `Topbar` entra solo para que el chip liste dos códigos: **no hay menú
nuevo**.

**Criterio de aceptación**

- [ ] Primera visita sin marcar la casilla: **un clic** de la lista al catálogo, igual que
      hoy. Lo único distinto en pantalla es la casilla sin marcar.
- [ ] Marcándola: el primer plan deja el chip "1 de 2" y **no** navega; el segundo entra
      al catálogo.
- [ ] Elegido el primer plan, **sede y nivel quedan congelados** y no hay forma de elegir
      un segundo plan de otra sede ni de otro nivel desde la interfaz (D3); el `×` del
      chip los descongela.
- [ ] Salir a mitad del borrador (atrás del navegador, cerrar la pestaña) **no deja nada
      guardado**: con un solo plan en el borrador, `localStorage` sigue como estaba.
- [ ] Marcar o desmarcar la casilla **no borra nada por sí sola**; lo que borra es elegir
      un conjunto de planes distinto, con su confirmación.
- [ ] Con un plan, la barra se ve idéntica a `main`; con dos, el chip lista los dos
      códigos y "empezar de nuevo" los nombra a los dos en la confirmación.
- [ ] En la barra **no hay ningún control nuevo**.

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
- [ ] **La invariante**: un código presente en los dos planes aparece **una sola vez** —
      buscándolo por código, por nombre, y con cualquier combinación de filtros— y se
      cuenta una sola vez en el total de la cabecera y en las facetas de tipología y de
      créditos.
- [ ] El ganador es el de **tipología de mayor rango** (D6), y en empate el primer plan
      elegido. Recargar la página da el mismo ganador: no depende de cuál respuesta llegó
      primero ni de qué se midió antes.
- [ ] `?include=schedules` se sigue pidiendo **solo** cuando hay grupos elegidos, igual
      que en `main`: la fusión no lo necesita.
- [ ] Si un catálogo falla y el otro no, se ve el que respondió y un `Fault` con
      reintento que vuelve a pedir los dos.
- [ ] `npm test` cubre D6: divergencia de tipología en los dos sentidos, el orden nuevo
      (`E` le gana a `C`, `P` le gana a todo), empate, letra desconocida, código en un
      solo plan.

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
- [ ] En un plan que no es mío, el aviso es el de hoy —"volver al mío" y "cambiarme a
      este", con su confirmación destructiva—, sin opciones nuevas.
- [ ] **La prueba que importa**: con un grupo elegido en una materia del plan A, las
      materias del plan B que chocan contra él salen marcadas en el catálogo, sin pedir
      nada nuevo al back.

```
feat(web): permitir materias de los dos planes en el mismo semestre
```

### Fase 5 · Decir a qué plan estamos atribuyendo cada materia

**Archivos**: `web/src/components/CourseCard.tsx` (+ `.css`), `web/src/views/Course.tsx`
(+ `.css`), `web/src/components/CreditsBadge.tsx`, `web/src/lib/credits.ts`.

**Criterio de aceptación**

- [ ] Con un plan, `CourseCard`, `Course` y `CreditsBadge` se ven **idénticos** a `main`.
- [ ] Con dos, cada fila y cada tarjeta llevan el código de su plan, y el hover dice en
      cuál se cuenta y con qué tipología —y, si estaba en los dos, cómo figura en el otro.
- [ ] La ficha de la materia lo dice entero en una línea, incluido que los grupos que se
      ven son los del plan que la gana (interfaz §7).
- [ ] **Ningún control para cambiar de plan una materia**: es informativo y nada más.
- [ ] El total de créditos y el semáforo cuentan las materias de los dos planes juntas
      (D9), y una materia compartida cuenta una sola vez, en la tipología ganadora.
- [ ] El calendario y el `.ics` salen bien con materias de los dos planes (colores por
      materia, sin eje nuevo).

```
feat(web): decir a qué plan se atribuye cada materia con dos titulaciones
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
- **No** borrar `tablero.plan.v1` en este PR: es el seguro de rollback. Queda anotado acá
  para el release siguiente, cuando el deploy esté firme.

```
docs(web): actualizar el porqué del estado del plan tras doble titulación
```

### Después, y no en este PR

Un release más tarde, con el deploy nuevo asentado, un commit de una línea que quita la
lectura de la v1 y la borra de `localStorage`:

```
chore(web): dejar de leer el plan guardado en el formato viejo
```

---

## Tests

El repo corre `vitest` (`web/package.json` → `npm test`) con una sola suite hoy:
`web/src/lib/conflicts.test.ts`. Se sigue esa forma —funciones puras, sin librería de
render, sin fixtures— con **dos** archivos nuevos:

**`web/src/lib/plans.test.ts`** (Fase 1), un caso por regla que puede romper datos:

1. v1 presente y v2 ausente → migra, conserva el plan, y **deja la v1 donde estaba**.
2. v1 y v2 presentes y distintas → manda la v2, la v1 ni se lee.
3. v2 con tres planes guardados a mano → se recorta a `MAX_PLANS`.
4. v2 con dos planes de igual `selectionId` → se deduplica.
5. Basura en la clave (`'{'`, `'[]'`, `null`) → `[]` sin tirar.
6. `select` con el **mismo** conjunto → no toca `items`; con uno **distinto** → los borra.
7. `select` con dos planes de distinta sede, o de distinto nivel → `false` y nada cambia
   (D3).
8. `add` con un `code` que ya está desde el otro plan → `false` (la invariante).
9. `loadPlan` con el mismo `code` dos veces guardado → una sola materia.

**`web/src/lib/catalog.test.ts`** (Fase 3), la regla de D6, que es la lógica no trivial de
esta rama:

1. `FUND. OBLIGATORIA (B)` en A contra `LIBRE ELECCIÓN (L)` en B → una fila, tipología
   `B`, plan A, y `alsoIn` apuntando a B con su literal.
2. Al revés —el obligatorio en el **segundo** plan— → gana igual el obligatorio, y ahora
   `alsoIn` apunta al primero. El orden de elección no puede ganarle al rango.
3. **El orden nuevo**: `NIVELACIÓN (E)` le gana a `DISCIPLINAR OBLIGATORIA (C)`, y
   `TRABAJO DE GRADO (P)` le gana a todo (D6).
4. Empate de rango (misma letra, o `B` contra `C`) → gana el primer plan elegido, con
   `alsoIn` puesto.
5. Letra desconocida o formato raro (`'RARO'`, `''`) → rango 0, no tira.
6. Códigos que están en un solo plan → pasan tal cual, sin `alsoIn`.
7. Una sola parte → salida de igual largo y orden que la entrada, sin `alsoIn`.
8. El resultado no depende de `section_schedules`: el mismo par con y sin horarios en la
   respuesta da el mismo ganador.

No se testea React: no hay entorno de render en el repo y montarlo sería traer
`@testing-library` entero por una casilla. Las fases 2, 4 y 5 se verifican a mano.

---

## Cómo usar los plugins

- **ponytail** (activo por hook, nivel `full`): la escalera manda. Antes de escribir un
  componente nuevo, buscar el que ya existe — `Confirm`, `Tooltip`, `IconButton`,
  `SearchInput`, `.chips`, `.chip.is-on`, `.btn` cubren **todo** lo de esta rama. La
  casilla es un `<input type="checkbox">` nativo. **Ninguna dependencia nueva y ningún
  componente nuevo**: si aparece uno, sobra. Al terminar, `/ponytail-review` (Fase 6).
- **frontend-design**: el alcance es chico a propósito — la casilla, la fila de chips
  "1 de 2" y el chip de plan en la tarjeta—, y va **con un guardarraíl**: este repo ya
  tiene identidad visual cerrada en `web/src/styles/tokens.css`, y la skill está pensada
  para *proponer* una. Se usa para jerarquía, espaciado y estados — **no** para elegir
  tipografías, paletas ni un lenguaje visual nuevo. Si el resultado no se puede pintar con
  los tokens que ya existen, está mal.
- **context7**: para dudas de API real —`<input type="checkbox">` controlado, React 19—
  antes que tirar de memoria. `resolve-library-id` → `query-docs`.
- **caveman**: solo estilo de conversación. Commits, cuerpo del PR y comentarios del
  código van en prosa normal, en español, como el resto del repo.

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| La migración v1→v2 falla y alguien pierde plan y semestre | Primer criterio de la Fase 1, con test. `loadPlans` nunca tira: ante la duda devuelve `[]`, y el peor caso es volver a elegir el plan — el semestre vive en otra clave que no se toca |
| **Hay que hacer rollback y el build viejo borra el semestre** al re-adoptar el plan (`PlanProvider.tsx:80-87`) | La v1 no se borra en este PR, así que el build viejo se reencuentra con su plan y no filtra nada. Ver [Compatibilidad](#compatibilidad-con-lo-que-ya-hay-en-los-navegadores), caso 3 |
| Alguien cree que el tablero decide por cuál plan se le cuenta una materia | Somos informativos: el chip y la ficha dicen a qué plan la estamos **atribuyendo** y con qué tipología, y no hay ningún control que sugiera que eso se puede cambiar desde acá (D6, interfaz §6 y §7) |
| Los grupos que se ven son los del plan ganador, y el otro plan podría ver alguno más | Se dice en la ficha, que es donde alguien elige grupo. Perseguirlo sería pedir el detalle a los dos planes: el doble de POSTs al SIA por materia compartida |
| Dos catálogos = ~700 KB y dos misses fríos la primera vez | Los dos van en paralelo y la pantalla de carga ya explica el costo. La segunda visita sale de Postgres |
| La casilla se lee como ruido para la mayoría | Es una casilla sin marcar, sin decisión forzada y sin desplazar la lista. Si molesta, baja al pie del bloque de "Nivel" |
| La mayoría de un solo plan nota el cambio | Criterio repetido en las fases 2, 3 y 5: con un plan, idéntico a `main` salvo la casilla y el tope de 20 |
| Quien se declara doble titulación tarde tiene que empezar de cero | Es la decisión (D4), no un efecto colateral: a cambio, la barra no gana ningún control y no hay dos caminos al mismo estado. La confirmación de "empezar de nuevo" ya dice exactamente qué se pierde |
| Medir 20 materias se siente lento | ~7 s con la barra de progreso a la vista, y el botón ya salta las que están dentro del cooldown (`useCourseDetails.ts:210-226`). `MAX_ITEMS` es la perilla |

---

## Decidido

Todas las preguntas de las versiones anteriores de este documento tienen respuesta.
Quedan acá para que nadie las reabra a mitad de la implementación:

| Pregunta | Respuesta |
|---|---|
| Orden de tipologías | `TRABAJO DE GRADO` > `NIVELACIÓN` > obligatorias > optativas > libre elección (D6). La nivelación arriba de las obligatorias es a propósito |
| Qué plan gana una materia compartida | El de **tipología de mayor rango**; empate → el primer plan elegido (D6) |
| ¿Y el plan que ve más grupos? | **Descartado.** Optimizaba una decisión que se toma en el SIA, no acá. Ver el porqué en D6 |
| ¿Se puede cambiar de plan una materia desde el tablero? | **No.** Somos informativos: se dice a qué plan se atribuye y con qué tipología, y ahí termina (D6, interfaz §6 y §7) |
| Los mínimos de créditos | Por **inscripción completa**, no por plan. `CreditsBadge` no cambia de lógica (D9) |
| Tope de materias | 20, para uno y para dos planes (D8) |
| ¿Cruza sedes o niveles? | **No.** Los dos planes son de la misma sede y del mismo nivel, y la interfaz lo impide en vez de confiar (D3) |
| ¿Hay tope académico de créditos? | **No.** Solo mínimos (6 y 10). El tope de 20 materias es nuestro, por el costo de la ronda de medición, y así se explica en la interfaz — nunca como si fuera regla de la universidad |
| Compatibilidad con lo ya guardado | La v1 se lee y **no** se borra: es el seguro de rollback. Se limpia un release después, en un commit aparte |
| ¿Se puede agregar un segundo plan a mitad de semestre? | **No.** Los dos se eligen al empezar; declararse tarde es empezar de nuevo, por el mismo botón que ya existe (D4) |
| ¿Cuántos controles nuevos ve la mayoría? | **Uno**: la casilla del picker. La barra, el catálogo y las listas no ganan ni un elemento |

Lo único que queda por decidir es lo que solo se puede decidir con uso real: si a alguien
le hace falta ver, en una materia compartida, los grupos que ve el **otro** plan. Costaría
pedir el detalle a los dos planes —el doble de POSTs al SIA por materia— así que no se
hace hasta que alguien lo pida.

---

## Checklist antes del PR

- [ ] `npx tsc -b --noEmit` limpio
- [ ] `npx oxlint` limpio
- [ ] `npm test` verde
- [ ] Probado a mano con **un** plan: las únicas diferencias contra `main` son las tres
      de la lista (la casilla y el tope de 20). Cualquier tercera es un bug
- [ ] Probado a mano con **dos** planes: elegirlos de una, buscar en el catálogo unido,
      agregar de los dos, choque cruzado, quitar uno, exportar `.ics`
- [ ] **La invariante, buscada a propósito**: elegir dos planes con carrera compartida
      (dos ingenierías de la misma sede sirven), buscar una materia común y confirmar que
      sale **una sola fila** en el catálogo, una sola en Mi semestre, un solo bloque en el
      calendario y una sola vez en los créditos
- [ ] No hay forma de elegir dos planes de sedes distintas desde la interfaz
- [ ] Probado con `localStorage` de un usuario viejo (v1) — la migración, y que la v1
      sigue ahí después
- [ ] **Probado el rollback**: con la rama desplegada y dos planes elegidos, servir el
      build de `main` y confirmar que vuelve el plan de siempre y que **no se borró
      ninguna materia**
- [ ] `/ponytail-review` pasado y aplicado
- [ ] Comentarios que decían "un solo plan" reescritos, no borrados

**Título del PR** (es lo que lee `semantic-release`):

```
feat(web): soporte para doble titulación
```
