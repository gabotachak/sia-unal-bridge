# Plan del frontend

Qué construir, con qué, y **qué significa cada cosa**. Escrito para alguien que domina
el back y arranca el front desde cero: además de plan, es un curso mínimo.

Hermano de [`PLAN.md`](PLAN.md), mismo formato: pasos con criterio de aceptación.
Nada se implementa hasta que esté acordado.

> Las analogías con Go aparecen así a lo largo del documento. No son adornos: si algo
> del front te suena raro, casi siempre tiene un equivalente exacto en lo que ya sabés.

---

## Qué se construye

Una interfaz de lectura sobre la API. **No** es un sistema de inscripción: no escribe
nada, no autentica a nadie. Responde cuatro preguntas, en este orden:

1. ¿Qué planes hay en mi sede?
2. ¿Qué asignaturas tiene mi plan?
3. ¿Qué grupos tiene esta asignatura — profesor, horario, aula?
4. **¿Quedan cupos, y de cuándo es ese dato?**

La cuarta es la que importa. Las otras tres existen para llegar a ella.

---

# Parte I · Curso mínimo de front

Esta parte no es sobre el proyecto. Es el vocabulario que hace falta para leer el resto.
Si algo ya lo sabés, saltalo.

## 1. El navegador solo entiende tres cosas

**HTML** (la estructura), **CSS** (el aspecto) y **JavaScript** (el comportamiento).
Todo lo demás —React, TypeScript, Vite— existe para producir esos tres archivos. Nada
de lo que vamos a usar corre en el navegador tal como lo escribimos: se traduce antes.

> Como Go: escribís `.go` y el navegador… perdón, el sistema operativo, ejecuta un
> binario. Nunca ejecuta tu código fuente.

## 2. npm y `node_modules`

`npm` es el gestor de paquetes de JavaScript. Su equivalente exacto:

| Go | JavaScript |
|---|---|
| `go.mod` | `package.json` — qué dependencias querés |
| `go.sum` | `package-lock.json` — las versiones exactas, para builds reproducibles |
| `go mod download` | `npm install` |
| caché global en `~/go/pkg/mod` | **`node_modules/` dentro del proyecto** |

La diferencia que sorprende: las dependencias se copian **dentro** de tu carpeta, y son
muchas —cientos de paquetes, cientos de megas— porque el ecosistema JS favorece
paquetitos pequeños que dependen unos de otros. `node_modules/` **nunca** va a git: se
reconstruye con `npm install`, igual que no versionás `~/go/pkg/mod`.

## 3. Vite: el compilador

El navegador no entiende TypeScript ni JSX, y hasta hace poco tampoco los `import` entre
archivos. **Vite** es la herramienta que traduce todo eso a HTML/CSS/JS plano.

Hace dos trabajos:

- **`npm run dev`** — levanta un servidor de desarrollo. Guardás un archivo y el
  navegador refleja el cambio al instante, sin recargar ni perder el estado.
- **`npm run build`** — produce una carpeta `dist/` con archivos estáticos listos para
  servir. *Eso* es lo que va a producción.

> `go run` y `go build`. Igual.

## 4. React en una frase

**Una interfaz es una función de sus datos.** Vos escribís cómo se ve la pantalla *para
unos datos dados*; cuando los datos cambian, React vuelve a llamar tu función y actualiza
solo lo que cambió en la pantalla.

Sin React, tendrías que decirle al navegador paso a paso *"buscá el elemento con id
cupos, cambiale el texto, y ahora agregale la clase rojo"*. Con React describís el
resultado y él calcula los pasos.

### Componente = función

```tsx
// Un componente. Es literalmente una función que devuelve lo que se ve.
function Campus({ code, name }) {
  return <li>{code} — {name}</li>;
}
```

Convención universal: **los componentes van en mayúscula** (`Campus`), las funciones
normales en minúscula. React usa esa mayúscula para distinguirlos.

### JSX: HTML dentro de JavaScript

Eso de `<li>{code}</li>` en medio del código se llama **JSX**. No es una plantilla de
texto: es azúcar sintáctico que Vite convierte en llamadas a función. Las llaves `{}`
significan *"acá va JavaScript"*.

Dos diferencias con el HTML normal que se olvidan siempre:

- `class` se escribe `className` (porque `class` es palabra reservada en JS)
- los atributos van en `camelCase`: `onClick`, no `onclick`

### Props = parámetros

Lo que un componente recibe se llama **props**. Son los parámetros de la función, y son
de **solo lectura**: un componente nunca modifica lo que le pasaron.

```tsx
<Campus code="1101" name="SEDE BOGOTÁ" />
```

> Props son parámetros de función pasados por valor. Un componente que muta sus props
> es como una función que muta el struct que le pasaron: se puede, y está mal.

### Estado = lo que cambia

Una variable normal se pierde cada vez que React vuelve a llamar la función. El
**estado** es una variable que sobrevive, y cuyo cambio *provoca* que la pantalla se
vuelva a pintar.

```tsx
const [campuses, setCampuses] = useState(null);
//     ^ valor    ^ cómo cambiarlo        ^ valor inicial
```

Regla que rompe a todo el mundo al principio: **nunca asignes directamente**. `campuses
= algo` no hace nada. Siempre `setCampuses(algo)`, porque es esa llamada la que le avisa
a React que hay que repintar.

### Hooks

Las funciones que empiezan con `use` se llaman **hooks**. Son la forma de que un
componente tenga memoria o efectos. Solo vamos a necesitar dos de las de la librería:

| Hook | Para qué |
|---|---|
| `useState` | recordar un valor entre repintados |
| `useEffect` | hacer algo *después* de pintar: pedir datos, poner un temporizador |

Y **uno que escribimos nosotros**, `useApi`, que junta los dos para hablar con la API.
Un hook propio es solo una función que usa otros hooks: no hay magia.

> `useEffect` es el más resbaladizo del front. Se ejecuta después de pintar, y hay que
> declararle **de qué depende** para que no se repita infinitamente. En el Paso 1 lo
> encerramos en `useApi` justamente para escribirlo bien una sola vez.

## 5. Por qué TypeScript

JavaScript no tiene tipos. Para alguien que viene de Go eso no es libertad, es volar a
ciegas: `course.credits` podría ser `4`, `"4"` o `undefined` y solo te enterás cuando la
pantalla muestra `NaN`.

**TypeScript** es JavaScript con tipos, y se siente familiar:

```ts
type Campus = {
  code: string;   // '1101'
  name: string;   // 'SEDE BOGOTÁ'
};
```

Lo usamos de la forma más simple posible: describir lo que devuelve la API y nada más.
Sin genéricos raros, sin tipos condicionales. Si un tipo cuesta de leer, está mal escrito.

Ventaja concreta acá: los tipos son el reflejo de `openapi.yaml`. El día que cambies una
ruta del back —como cuando metimos la sede en la URL— el editor te marca en rojo cada
lugar del front que hay que tocar, en vez de descubrirlo en runtime.

---

# Parte II · El proyecto

## Separación de carpetas

El front **no se mezcla** con el back. Una sola carpeta nueva en la raíz:

```
sia-unal-bridge/
├── cmd/            ← Go. No se toca.
├── internal/       ← Go. No se toca.
├── migrations/     ← SQL. No se toca.
├── docs/  bruno/
├── docker-compose.yml
│
└── web/                     ← TODO el front vive aquí dentro
    ├── package.json         ← las dependencias (el go.mod del front)
    ├── vite.config.ts       ← configuración del compilador + proxy a la API
    ├── tsconfig.json        ← configuración de TypeScript
    ├── index.html           ← la única página; React la llena
    ├── Dockerfile           ← build + nginx, para compose
    ├── nginx.conf
    ├── README.md
    └── src/
        ├── main.tsx         ← punto de entrada: engancha React a la página
        ├── App.tsx          ← el mapa de rutas
        ├── api/
        │   ├── client.ts    ← ÚNICA puerta a la API. Nadie más hace fetch
        │   └── types.ts     ← los tipos que devuelve la API
        ├── hooks/
        │   └── useApi.ts    ← el hook propio: cargando / error / datos
        ├── views/           ← una pantalla por archivo
        │   ├── Campuses.tsx
        │   ├── Campus.tsx
        │   ├── Program.tsx
        │   └── Course.tsx
        ├── components/      ← piezas reutilizables
        │   ├── Seats.tsx       ← el contador de cupos
        │   ├── Freshness.tsx   ← la insignia de edad del dato
        │   └── Loading.tsx
        └── styles/
```

Go ignora `web/` por completo: no hay archivos `.go` ahí. En sentido contrario, la regla
que hay que escribir en `CLAUDE.md` el día que exista:

> **El front solo habla HTTP contra `/v1`.** Nunca toca Postgres, nunca importa nada de
> `internal/`. Si necesita un dato que la API no da, se agrega el endpoint — no un atajo.

Esa regla es lo que mantiene la separación real y no solo visual. El back ya tiene su
equivalente probado: `go list -deps ./internal/catalog` no puede contener gin ni pgx.

## Cómo se sirve

Hay un problema que conviene entender antes, porque decide la forma del compose.

**El problema.** Si la página se carga desde `localhost:5173` y hace
`fetch("http://localhost:8080/v1/campuses")`, el navegador **bloquea la respuesta**. Se
llama *same-origin policy*: origen = esquema + host + **puerto**, y `5173 ≠ 8080`. No es
un error de la API — la petición llega y se responde; es el navegador el que se niega a
entregársela al JavaScript.

**La solución, en los dos entornos: un proxy.** El front nunca pide a `localhost:8080`,
pide a `/v1/...` — sin host. Para el navegador es el mismo origen, así que no hay nada
que bloquear. Quien está detrás reenvía al back:

| | Quién hace de proxy | Cómo se levanta |
|---|---|---|
| **Desarrollo** | Vite, con tres líneas en `vite.config.ts` | `npm run dev` → `localhost:5173` |
| **Compose** | nginx, que además sirve el `dist/` ya compilado | `docker compose up` → `localhost:8081` |

La API no se entera ni cambia. Y `localhost:8080` sigue siendo la API cruda con su
Swagger, como toda esta sesión.

## Stack

| Pieza | Qué es | Por qué esta |
|---|---|---|
| **React** | la librería de interfaz | Lo pedido. Estándar de facto: lo que aprendas se transfiere |
| **Vite** | compilador y servidor de desarrollo | Lo que recomienda React hoy. Config mínima y trae el proxy resuelto |
| **TypeScript** | JS con tipos | Venís de Go. Sin tipos el front se depura a ciegas |
| **React Router** | qué vista mostrar según la URL | Estándar. Permite que `/sede/1101/plan/2A74` se pueda compartir y recargar |
| **CSS plano** | los estilos | Ver abajo |

**Lo que deliberadamente NO usamos**, y por qué — esto importa tanto como lo que sí:

| | Por qué no |
|---|---|
| **Tailwind** | Es popular, pero llena el JSX de `class="flex items-center gap-2 …"`. Para alguien que arranca, esconde lo que hace el CSS detrás de un idioma nuevo. Usamos CSS normal con variables |
| **Redux / Zustand** | Gestores de estado global. Resuelven un problema que aquí no existe: cada pantalla pide sus datos y ya |
| **TanStack Query** | Excelente librería de caché de datos. Pero *nuestro* `useApi` son 40 líneas que vas a entender enteras, y la caché de verdad ya vive en Postgres |
| **MUI / shadcn / Chakra** | Librerías de componentes. Traen su propia estética, y acá la estética es el punto |

Total de dependencias directas: **cuatro**. Es deliberado.

## Convenciones

Las que vas a ver en cualquier proyecto React, para que el código no te resulte ajeno:

| Regla | Ejemplo |
|---|---|
| Un componente por archivo, y el archivo se llama como él | `Seats.tsx` exporta `Seats` |
| Componentes en `PascalCase`, todo lo demás en `camelCase` | `<Seats />`, `formatAge()` |
| Extensión `.tsx` si el archivo tiene JSX, `.ts` si no | `Course.tsx`, `client.ts` |
| Las vistas (pantallas completas) van en `views/`, las piezas en `components/` | — |
| Nada de lógica de red fuera de `api/client.ts` | una sola puerta, como los puertos del back |

Código en inglés, como el resto del repo. Interfaz en español.

## Dirección visual

Comprometerse antes de codear, si no sale gris por defecto.

**Concepto: tablero de salidas.** La tesis de esta API es que **todo dato declara su
edad** — `Age`, `X-Cache`, `age_seconds`. Un tablero de estación es exactamente ese
lenguaje: información viva que envejece a la vista de todos. La interfaz no esconde la
latencia ni la antigüedad: las exhibe.

| | |
|---|---|
| **Fondo** | Negro cálido, no gris azulado. Textura de grano sutil |
| **Tipografía** | Serif editorial de alto contraste para títulos y cifras; monoespaciada técnica para datos. Nada de Inter ni Roboto |
| **Color** | Crema sobre negro. **Un** acento: ámbar fósforo para lo recién medido. Óxido solo para alarma: sin cupos, dato viejo, error |
| **Momento memorable** | El contador de cupos gira como un tablero de aeropuerto cuando cambia, y la insignia de frescura se apaga a medida que el dato envejece |
| **Densidad** | Tabla editorial, filetes finos, mucho aire — el catálogo tiene 694 filas y hay que poder leerlas |

Explícitamente evitado: tarjetas redondeadas con sombra suave, degradados morados,
íconos genéricos. Es un tablero institucional, no un dashboard de SaaS.

## Los dos problemas que la API impone

No son detalles de estilo: condicionan la arquitectura del front.

**1 · Un miss frío tarda segundos.** Medido: 8 s la primera vez que se pide una sede,
7 s el catálogo de un plan. La mayoría de las interfaces esconden eso tras un spinner y
el usuario asume que está rota. Acá se hace lo contrario: **se explica**. Cronómetro a la
vista y una línea que dice qué está pasando —*"consultando al SIA: son 15 peticiones
encadenadas"*—. La segunda vez la misma pantalla abre en milisegundos, y ese contraste
**se muestra**. Es el argumento del producto, no un defecto que tapar.

**2 · Ningún dato se sirve sin su edad.** Eso se refleja en pantalla siempre, no en un
tooltip escondido: un cupo de hace 4 minutos y uno de hace 4 horas **no se ven igual**.

---

# Parte III · Pasos

Cada paso agrega una pantalla **y** enseña un concepto. Si un paso te deja con dudas,
no seguimos al siguiente.

### Paso 0 · Andamiaje

Crear `web/` con Vite, arrancar el servidor de desarrollo, configurar el proxy a la API.
Nada de diseño todavía: una lista fea de sedes.

**Aprendés:** qué genera `npm create vite`, para qué es cada archivo de configuración,
cómo React se engancha a `index.html`.

**Hecho cuando:** `npm run dev` y `localhost:5173` muestra las 9 sedes reales traídas de
la API, sin error de CORS en la consola.

### Paso 1 · La puerta a la API

`api/client.ts` y el hook `useApi`. Toda la app pide datos por acá y por ningún otro
lado. Devuelve los datos **y** los metadatos de frescura (`X-Cache`, `Age`,
`X-SIA-Fetch-Ms`) juntos, y traduce los errores de la API: `300` ambiguo, `404`,
`502 sia_noop`, `503 busy`.

**Aprendés:** `useState`, `useEffect`, y por qué se encierran en un hook propio.

**Hecho cuando:** pedir dos veces la misma sede reporta `miss` y luego `hit`, y apagar
la API muestra un error legible en vez de una pantalla en blanco.

### Paso 2 · Rutas y navegación

Sede → facultades → planes. La URL es la que manda: `/sede/1101/plan/2A74` se puede
pegar en el chat y abre ahí.

**Aprendés:** React Router, y por qué la URL es estado y no decoración.

**Hecho cuando:** se llega a un plan de Medellín y a uno de Amazonia solo haciendo clic,
y recargar la página mantiene el sitio.

### Paso 3 · Catálogo del plan

Las asignaturas con filtro por nombre, créditos y tipología. Hasta ~700 filas.

**Aprendés:** listas y la prop `key`; estado que vive en un formulario; por qué filtrar
en memoria acá está bien.

**Hecho cuando:** el catálogo de Medellín (694 filas) se filtra sin lag perceptible, y
se distingue de un vistazo la libre elección de la obligatoria.

### Paso 4 · Detalle y grupos

Grupos con profesor, jornada, horario por día y aula. Casos que **deben** verse bien:

- una asignatura sin oferta este semestre → *"sin grupos este semestre"*, no un error
- un grupo sin horario informado
- grupos PEAMA, donde cinco se llaman "Grupo 1" y lo que los distingue es la clave

**Aprendés:** componer componentes pequeños; renderizado condicional sin ensuciar.

**Hecho cuando:** `1000004-B` muestra sus 32 grupos sin que dos se vean iguales, y
`2027641` (0 grupos) no parece una pantalla rota.

### Paso 5 · Cupos

El momento estrella. Cifra grande, edad siempre visible, botón que fuerza `?max_age=0`,
y la animación de tablero cuando el número cambia.

**Aprendés:** animación en CSS disparada por cambios de estado; `prefers-reduced-motion`.

**Hecho cuando:** refrescar un grupo muestra la cifra girando y la edad volviendo a
cero, y un dato de más de 5 minutos se ve distinto de uno recién medido.

### Paso 6 · Estados honestos

Carga con cronómetro, vacíos con explicación, errores con significado — incluido el
`300`, que debe ofrecer los candidatos como enlaces, no como texto.

**Hecho cuando:** desconectar la API y navegar no produce ni una pantalla en blanco ni
un error de consola sin manejar.

### Paso 7 · Accesibilidad y móvil

Navegable con teclado, foco visible, contraste real, tablas que no rompen en pantalla
angosta.

**Hecho cuando:** se recorre el flujo completo sin tocar el ratón, y a 380 px de ancho
no hay scroll horizontal.

### Paso 9 · Mi semestre · **hecho**

Un `+` en el catálogo y en la ficha aparta hasta **10 materias**. La pantalla
`/semestre` muestra los grupos de todas con sus cupos, y **un botón los mide todos**.

**La decisión que trajo:** esto es el disparador que este mismo plan anticipaba —
*"estado compartido entre vistas"*. Se resolvió con **Context de React**, no con una
librería: la lista se agrega desde dos pantallas, se cuenta en el raíl y se lee en una
tercera, y eso son ~60 líneas legibles (`src/state/`). Redux o Zustand resolverían un
problema de escala que esta app no tiene. Persiste en `localStorage`, con la clave
versionada y validando lo que lee: nunca se confía en lo guardado.

**Dos cosas que salieron de cómo funciona el SIA, no del diseño:**

- **Un botón por materia, no por grupo.** El POST del detalle trae TODOS los grupos con
  sus cupos en la misma respuesta. Un botón por grupo insinuaría que medir uno solo es
  más barato —no lo es— y dos clics costarían dos consultas idénticas. Medido: los dos
  grupos de `2015705` vuelven con la misma edad exacta, porque son la misma medición.
- **De a 4 materias a la vez.** El pool del back son 4 sesiones ADF, cada una
  estrictamente secuencial. Disparar 10 juntas no acelera nada —se encolan igual— y deja
  la API sin conexiones para cualquier otra pestaña.

**Hecho cuando:** con 3 materias agregadas, un clic devuelve los cupos de todos sus
grupos, cada uno con su edad, y la lista sobrevive a recargar la página. ✓

### Paso 8 · Empaquetar

`web/Dockerfile` (build con Node, servir con nginx) y el servicio `web` en compose.

**Aprendés:** la diferencia entre el servidor de desarrollo y los estáticos de producción.

**Hecho cuando:** `docker compose up -d --build` levanta db + api + web, y
`localhost:8081` funciona en una máquina sin Node instalado.

---

## Lo que NO se hace en esta fase

Para que quede escrito y no se cuele:

- **Detección de choques de horario** entre las materias del semestre. Ahora que la
  lista existe, es lo siguiente natural: cruzar los `class_session` de los grupos
  elegidos. No necesita nada del back.
- **Alertas de cupo.** `seat_snapshot` es append-only y ya guarda el histórico, así que
  el dato existe; faltan el endpoint y una forma de notificar.
- Login, favoritos, cualquier cosa que escriba.
- Tests de front. Se agregan cuando haya lógica que probar; hoy sería ceremonia.
- Búsqueda global entre sedes: la API la restringe a una sede a propósito.

---

## Glosario

| Término | Qué es |
|---|---|
| **npm** | gestor de paquetes. `go mod` del front |
| **`node_modules/`** | las dependencias, copiadas dentro del proyecto. Nunca a git |
| **Vite** | compila y sirve. `go build` + `go run` |
| **JSX** | HTML dentro de JavaScript. `<li>{code}</li>` |
| **Componente** | función que devuelve lo que se ve. Siempre en mayúscula |
| **Props** | los parámetros de un componente. Solo lectura |
| **Estado** | valor que sobrevive al repintado y que, al cambiar, lo dispara |
| **Hook** | función que empieza con `use`. Da memoria o efectos a un componente |
| **`useState`** | recordar un valor |
| **`useEffect`** | hacer algo después de pintar: pedir datos, temporizadores |
| **Renderizar** | pintar. React lo hace solo cuando cambia el estado |
| **`key`** | identificador que React pide al pintar listas, para saber qué fila es cuál |
| **Bundle** | el JS final, ya compilado y unido, que se descarga el navegador |
| **CORS** | la regla del navegador que bloquea pedir a otro origen. La esquivamos con proxy |

---

## Decisiones abiertas

1. **Puerto del front**: 8081 con la API en 8080 (recomendado, no cambia nada de lo que
   ya tenés), o todo por 8080 con la API detrás del proxy.
2. **Fuentes**: desde Google Fonts (una línea, requiere internet) o descargadas al repo
   (funciona sin red, pesa ~200 KB). Recomiendo descargarlas: el resto del proyecto no
   depende de terceros en runtime.
3. **Alcance de la primera entrega**: ¿los 8 pasos de una, o cortamos en el 5 —que ya es
   la app completa y útil— y dejamos empaquetado y accesibilidad para después?
