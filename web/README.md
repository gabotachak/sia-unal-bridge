# web · la interfaz

React + TypeScript + Vite. Consume la API de este mismo repo por HTTP y nada más:
**nunca toca Postgres ni importa nada de `internal/`.**

El plan, con el curso mínimo de front para leer todo esto, está en
[`../docs/PLAN-FRONTEND.md`](../docs/PLAN-FRONTEND.md).

## Arrancar

Necesita la API corriendo en el 8080:

```bash
docker compose up -d          # desde la raíz: db + api
cd web && npm install         # solo la primera vez
npm run dev                   # → http://localhost:5173
```

| Comando | Qué hace |
|---|---|
| `npm run dev` | servidor de desarrollo, recarga al guardar |
| `npm run build` | compila a `dist/` — eso es lo que va a producción |
| `npm run preview` | sirve el `dist/` ya compilado, para probarlo |
| `npx oxlint` | linter |
| `npx tsc -b --noEmit` | solo revisar tipos |

## Por qué no hay problema de CORS

El front **nunca** pide a `http://localhost:8080`. Pide a rutas relativas — `/v1/...` —
y Vite las reenvía al back (ver `vite.config.ts`). Para el navegador todo salió del mismo
origen, así que no hay nada que bloquear. En producción el mismo papel lo hace nginx.

Si algún día ves un error de CORS en la consola, es que alguien escribió un `fetch` con
host absoluto. La regla: todo pasa por `src/api/client.ts`.

## Mapa

```
src/
├── main.tsx          punto de entrada: engancha React a index.html
├── App.tsx           el mapa de rutas
├── api/
│   ├── client.ts     ÚNICA puerta a la API. Nadie más hace fetch
│   └── types.ts      lo que devuelve la API, como tipos
├── hooks/            useApi (pedir datos), usePlan (la lista del semestre)
├── state/            el único estado compartido: las materias apartadas
├── lib/format.ts     funciones sueltas (formatear edad, comparar sin tildes)
├── views/            una pantalla por archivo
├── components/       piezas reutilizables
└── styles/           tokens.css es la identidad visual entera
```

## Decisiones que conviene no deshacer sin pensarlo

**Los datos viajan con su frescura.** `client.ts` devuelve `{ data, freshness }` juntos,
nunca solo los datos. La API se esfuerza en no servir nada sin decir de cuándo es;
separarlos acá tiraría ese trabajo. Es lo que hace posible que un cupo de hace 4 minutos
y uno de hace 4 horas no se vean igual.

**La carga se explica, no se esconde.** Un miss frío contra el SIA tarda entre 3 y 8
segundos — son hasta 15 POSTs encadenados. En vez de un spinner mudo hay un cronómetro y
una explicación. El contraste con la segunda visita (milisegundos) es el argumento del
producto.

**La URL es estado.** `/sede/1101/plan/2A74/asignatura/1000003-B` se puede pegar en un
chat y abre ahí. Nada de estado de navegación escondido en memoria.

**Sin librería de estado ni de datos.** No hace falta: cada pantalla pide lo suyo y la
caché de verdad vive en Postgres. Las dependencias directas son cuatro, y es deliberado.

**Un botón de medir por MATERIA, no por grupo.** El POST del detalle trae todos los
grupos con sus cupos en la misma respuesta — medir uno solo no es más barato. Verificado:
los grupos de una misma materia vuelven siempre con la edad idéntica.

**La sede va primero, siempre.** No es capricho de diseño: `program.code` se repite entre
sedes (136 de 852), así que una ruta sin sede no identifica nada. La forma de las URLs
del front imita la de la API por esa razón.

**Doble titulación: dos planes son dos fuentes para el mismo horario, no dos catálogos.**
No hay "plan activo" ni pestañas: con dos planes elegidos el catálogo es la unión,
deduplicada por `code`, y el código compartido gana la tipología de mayor rango (D6,
`docs/PLAN-DOUBLE-TITULATION.md`). Es lo que hace que el choque de horario cruzado salga
gratis —`computeConflicts` ya compara por `itemId`, que lleva el plan adentro— y que la
feature entera sea más chica que la alternativa de pestañas, no más grande.
