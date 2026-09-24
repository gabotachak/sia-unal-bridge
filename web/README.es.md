<div align="center">

# SIA Bridge · la interfaz

**Un planeador de semestre para la Universidad Nacional de Colombia, construido sobre una
API JSON pública en vez del portal heredado de la universidad.**

[English](README.md) · **Español**

**[sia.gabotachak.dev](https://sia.gabotachak.dev)**

[![React](https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev)
[![Vitest](https://img.shields.io/badge/Vitest-tests-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev)
[![oxlint](https://img.shields.io/badge/lint-oxlint-2C3E50?style=flat-square)](https://oxc.rs)
[![Dependencias](https://img.shields.io/badge/dependencias%20de%20runtime-3-brightgreen?style=flat-square)](package.json)
[![Licencia](https://img.shields.io/badge/licencia-MIT-green?style=flat-square)](../LICENSE)

</div>

---

<div align="center">
  <img src="../docs/assets/catalog.png" alt="Catálogo de un plan en la interfaz: unas 300 asignaturas, cupos con su edad y estado de selección." width="900">
</div>

## Qué es esto

Cada semestre, los estudiantes de la Universidad Nacional de Colombia (UNAL) arman su
horario con la misma materia prima: qué asignaturas ofrece su plan, qué grupos tiene
cada una, en qué horario y cuántos cupos quedan. La fuente oficial es el SIA, un portal
heredado sin API, donde responder eso para una sola materia cuesta varios clics y varios
segundos.

Esta app es la mitad de [SIA Bridge](../README.es.md) que ve el estudiante. Habla solo con
la API JSON pública del proyecto —que hace el trabajo pesado de scrapear y cachear el
SIA— y convierte esos datos en un planeador:

- **Catálogo**: todas las asignaturas de un plan, con búsqueda y filtros por tipología,
  créditos y los días y horas en que tenés tiempo.
- **Ficha de asignatura**: grupos, horarios, profesores y cupos de una materia.
- **Mi semestre**: juntá hasta veinte materias candidatas y medí los cupos de todas con
  un solo botón.
- **Mi horario**: elegí un grupo por materia, mirá los choques en un calendario semanal
  y exportá el resultado a cualquier app de calendario como `.ics`.
- **Doble titulación**: elegí dos planes y armá los dos en un solo horario.

Sin cuentas ni datos de usuario en el servidor: tu selección vive en el `localStorage`
del navegador.

## Principios de diseño

**Todo dato declara su edad.** La API nunca sirve un cupo sin decir de cuándo es, y el
cliente respeta esa promesa: `src/api/client.ts` devuelve `{ data, freshness }` juntos,
nunca solo los datos. Es lo que hace que un cupo de hace 4 minutos y uno de hace 4 horas
no se vean igual.

**La carga se explica, no se esconde.** Un miss frío contra el SIA tarda entre 3 y 8
segundos: son hasta 15 POSTs encadenados. En vez de un spinner mudo hay un cronómetro y
una explicación. El contraste con la segunda visita (milisegundos) es el argumento del
producto.

**Sin librería de estado ni de datos.** No hace falta: cada pantalla pide lo suyo y la
caché de verdad vive en Postgres, detrás de la API. Las dependencias de runtime son tres,
y es deliberado.

**Un botón de medir por MATERIA, no por grupo.** El SIA trae todos los grupos de una
materia, con sus cupos, en la misma respuesta: medir uno solo no es más barato.
Verificado: los grupos de una misma materia vuelven siempre con la edad idéntica.

**Doble titulación: dos planes son dos fuentes para el mismo horario, no dos catálogos.**
No hay "plan activo" ni pestañas: con dos planes elegidos el catálogo es la unión,
deduplicada por `code`, y el código compartido gana la tipología de mayor rango (D6,
[`docs/PLAN-DOUBLE-TITULATION.md`](../docs/PLAN-DOUBLE-TITULATION.md)). Es lo que hace
que el choque de horario cruzado salga gratis, y que la feature entera sea más chica que
la alternativa de pestañas, no más grande.

**La barra de direcciones se queda en `/`.** Las pantallas dependen de un plan elegido en
este navegador, no de un recurso público con dirección propia, así que no hay nada que
un link pegado pueda reabrir. Cada cambio de pantalla igual empuja una entrada al
historial, así que atrás y adelante funcionan como se espera.

## Arrancar

```bash
cp ../.env.example ../.env    # una vez, desde el ejemplo de la raíz
npm install
npm run dev                   # → http://localhost:3000
```

El dev server lee el `.env` de la raíz. Con los valores de
[`.env.example`](../.env.example), `/v1` se reenvía a la **API de producción**
(`VITE_API_TARGET`), así que se puede trabajar en la interfaz sin levantar el backend.
Para usar una API local, levantala desde la raíz con `docker compose up -d` y apuntá
`VITE_API_TARGET` a `http://localhost:18080`, que es además el valor por defecto si la
variable no está.

| Comando | Qué hace |
|---|---|
| `npm run dev` | servidor de desarrollo, recarga al guardar |
| `npm run build` | revisa tipos y compila a `dist/`, que es lo que sirve producción |
| `npm run preview` | sirve el `dist/` ya compilado, para probarlo |
| `npm test` | tests unitarios (Vitest) |
| `npm run lint` | linter (oxlint) |

En producción, nginx sirve los estáticos y reenvía `/v1` al contenedor de la API (ver
[`nginx.conf`](nginx.conf)); desde la raíz, `docker compose up -d --build web`.

## Por qué no hay problema de CORS

La app **nunca** llama a la API con URL absoluta. Pide rutas relativas (`/v1/...`) y el
dev server las reenvía al back (ver [`vite.config.ts`](vite.config.ts)); en producción
lo hace nginx. Para el navegador todo sale del mismo origen, así que no hay nada que
bloquear.

Si algún día ves un error de CORS en la consola, es que alguien escribió un `fetch` con
host absoluto. La regla: todo pasa por `src/api/client.ts`.

## Dependencias

| Paquete | Para qué |
|---|---|
| `react`, `react-dom` | la interfaz |
| `lucide-react` | íconos |

Todo lo demás es de desarrollo: Vite y su plugin de React para compilar, TypeScript,
Vitest, oxlint, y `qrcode`, que se usó una sola vez para generar el QR de donación como
path SVG embebido.

## Mapa

```
src/
├── main.tsx          punto de entrada: engancha React a index.html
├── App.tsx           elige qué pantalla pintar
├── api/
│   ├── client.ts     ÚNICA puerta a la API; nadie más hace fetch
│   └── types.ts      lo que devuelve la API, como tipos
├── views/            una pantalla por archivo: elegir plan, catálogo, ficha,
│                     mi semestre, mi horario, donar
├── components/       piezas reutilizables (contador de cupos, calendario, tabla, …)
├── hooks/            pedir datos, ordenar tablas, tema, ajuste al viewport, …
├── state/            estado compartido: planes elegidos, materias apartadas,
│                     filtros, navegación
├── lib/              funciones puras: choques, exportar .ics, storage, formato;
│                     las que tienen lógica llevan su *.test.ts al lado
└── styles/           tokens.css es la identidad visual entera
```

## Más

- [`docs/PLAN-FRONTEND.md`](../docs/PLAN-FRONTEND.md): el plan de la interfaz, con el
  curso mínimo de front para leer este código.
- [`../README.es.md`](../README.es.md): el proyecto entero, la API y cómo habla con el
  SIA.

Los identificadores están en inglés; los comentarios y el resto de la documentación, en
español.
