<div align="center">

# SIA Bridge · web app

**A semester planner for the Universidad Nacional de Colombia, built on a public JSON API
instead of the university's legacy portal.**

**English** · [Español](README.es.md)

**[sia.gabotachak.dev](https://sia.gabotachak.dev)**

[![React](https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev)
[![Vitest](https://img.shields.io/badge/Vitest-tested-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev)
[![oxlint](https://img.shields.io/badge/lint-oxlint-2C3E50?style=flat-square)](https://oxc.rs)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-3-brightgreen?style=flat-square)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](../LICENSE)

</div>

---

<div align="center">
  <img src="../docs/assets/catalog.png" alt="Catalog of a degree program in the web app: some 300 courses, seat counts with their age and selection state." width="900">
</div>

## What this is

Every semester, students at the Universidad Nacional de Colombia (UNAL) build their
timetable out of the same raw material: which courses their degree program offers,
which sections (*grupos*) each course has, when they meet, and how many seats are left.
The official source for all of that is the SIA, a legacy web portal with no API, where
answering those questions for a single course takes several clicks and several seconds.

This app is the student-facing half of [SIA Bridge](../README.md). It talks only to the
project's public JSON API, which does the hard work of scraping and caching the SIA, and
turns that data into a planner:

- **Catalog**: every course in a degree program, searchable and filterable by course
  type, credits and the days and hours you are free.
- **Course page**: sections, schedules, instructors and seats for one course.
- **Mi semestre** (*my semester*): collect up to twenty candidate courses and measure the
  seats of all of them with one button.
- **Mi horario** (*my timetable*): pick one section per course, see clashes on a weekly
  calendar and export the result to any calendar app as an `.ics` file.
- **Double degree**: choose two programs and plan both in a single timetable.

No account and no server-side user data: your selection lives in the browser's
`localStorage`.

## Design principles

**Every piece of data states its age.** The API never serves a seat count without saying
when it was measured, and the client keeps that promise: `src/api/client.ts` returns
`{ data, freshness }` together, never the data alone. That is what lets a seat count from
four minutes ago and one from four hours ago look different on screen.

**Loading is explained, not hidden.** A cold cache miss against the SIA takes 3 to 8
seconds, because it is up to 15 chained requests. Instead of a silent spinner there is a
stopwatch and an explanation. The contrast with the second visit (milliseconds) is the
product's whole argument.

**No state or data library.** Each screen fetches what it needs, and the real cache
lives in Postgres behind the API. There are three runtime dependencies, on purpose.

**One "measure" button per course, not per section.** The SIA returns every section of a
course, with its seats, in the same response, so measuring a single section is no
cheaper. Verified: sections of the same course always come back with identical age.

**Double degree means two sources for one timetable, not two catalogs.** There is no
"active program" and no tabs: with two programs chosen, the catalog is their union,
deduplicated by course code, and a shared course takes the higher-ranked course type
(decision D6 in
[`docs/PLAN-DOUBLE-TITULATION.md`](../docs/PLAN-DOUBLE-TITULATION.md)). That is what
makes cross-program clash detection free, and it made the feature smaller than the tabbed
alternative, not bigger.

**The address bar stays at `/`.** Screens depend on a program chosen in this browser, not
on a public resource with its own address, so there is nothing a pasted link could
reopen. Navigation still pushes history entries, so the browser's back and forward
buttons work as expected.

## Getting started

```bash
cp ../.env.example ../.env    # once, from the repo root's example
npm install
npm run dev                   # → http://localhost:3000
```

The dev server reads the root `.env`. With the values in
[`.env.example`](../.env.example), `/v1` is proxied to the **production API**
(`VITE_API_TARGET`), so you can work on the UI without running the backend. To use a
local API instead, start it from the repo root with `docker compose up -d` and point
`VITE_API_TARGET` at `http://localhost:18080`, which is also the fallback when the
variable is unset.

| Command | What it does |
|---|---|
| `npm run dev` | development server with hot reload |
| `npm run build` | type-checks and compiles to `dist/`, which is what production serves |
| `npm run preview` | serves the compiled `dist/` to try it out |
| `npm test` | unit tests (Vitest) |
| `npm run lint` | linter (oxlint) |

In production, nginx serves the static files and proxies `/v1` to the API container
(see [`nginx.conf`](nginx.conf)); from the repo root, `docker compose up -d --build web`.

## Why there are no CORS problems

The app **never** calls the API by absolute URL. It requests relative paths (`/v1/...`)
and the dev server forwards them to the backend (see [`vite.config.ts`](vite.config.ts));
in production nginx does the same. To the browser everything comes from one origin, so
there is nothing to block.

If you ever see a CORS error in the console, someone wrote a `fetch` with an absolute
host. The rule: everything goes through `src/api/client.ts`.

## Dependencies

| Package | Why |
|---|---|
| `react`, `react-dom` | the UI |
| `lucide-react` | icons |

Everything else is a dev dependency: Vite and its React plugin to build, TypeScript,
Vitest, oxlint, and `qrcode`, used once to generate the donation QR code as an inline SVG
path.

## Map

```
src/
├── main.tsx          entry point: mounts React on index.html
├── App.tsx           picks the screen to render
├── api/
│   ├── client.ts     the ONLY door to the API; nobody else calls fetch
│   └── types.ts      what the API returns, as types
├── views/            one screen per file: plan picker, catalog, course,
│                     my semester, my timetable, donate
├── components/       reusable pieces (seat counter, week calendar, table, …)
├── hooks/            data fetching, table sorting, theme, viewport fitting, …
├── state/            shared state: chosen programs, selected courses,
│                     filters, navigation
├── lib/              pure functions: clash detection, .ics export, storage,
│                     formatting; the ones with logic have *.test.ts beside them
└── styles/           tokens.css is the entire visual identity
```

## More

- [`docs/PLAN-FRONTEND.md`](../docs/PLAN-FRONTEND.md): the web app's plan, including a
  crash course in frontend for reading this code (in Spanish).
- [`../README.md`](../README.md): the whole project, the API and how it talks to the
  SIA.

Identifiers are in English; comments and the rest of the documentation are in Spanish,
the project's working language.
