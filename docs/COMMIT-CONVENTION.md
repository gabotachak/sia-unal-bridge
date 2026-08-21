# Convención de commits y PRs

**Toda IA que haga commits o abra PRs en este repo debe leer esto antes de escribir
el mensaje.** No es estilo — `semantic-release` (ver [`PLAN-CI-CD.md`](PLAN-CI-CD.md),
Fase 2) lee el mensaje que queda en `main` para decidir la versión (`vX.Y.Z`). Un
mensaje fuera de formato no rompe el build, simplemente **no genera Release**: el
deploy corre igual, pero queda sin versión ni changelog asociado.

El cuerpo del PR tiene plantilla: [`.github/pull_request_template.md`](../.github/pull_request_template.md),
que GitHub rellena solo al abrirlo. Su sección de **Verificación** no es burocracia:
el CI de este repo solo lintea el título y los commits —no corre tests ni build— y
mergear a `main` despliega, así que el PR es el único sitio donde queda constancia de
qué se probó.

**El título del PR sigue el mismo formato que un commit.** Si el merge es por
squash (habilitado en este repo), GitHub aplasta todos los commits del PR en uno
solo y usa **el título del PR** como mensaje final en `main` — ahí es lo único que
`semantic-release` va a leer, los commits individuales del PR desaparecen. Con
merge-commit o rebase sí sobreviven los commits individuales, pero el título igual
se chequea siempre (ver "Filtro automático" abajo), así que hacerlo bien una vez
cubre los tres métodos.

## Formato

```
<tipo>(<alcance opcional>): <resumen en imperativo, minúscula, sin punto final>

<cuerpo opcional — el porqué, no el qué>

<footer opcional>
```

## Tipos y qué versión disparan

| Tipo | Bump | Ejemplo |
|---|---|---|
| `fix:` | patch (`0.0.X`) | `fix: liberar sesión ADF al expirar el pool` |
| `feat:` | minor (`0.X.0`) | `feat: agregar endpoint de cupos por sección` |
| `refactor:`, `perf:`, `docs:`, `test:`, `build:`, `ci:`, `chore:`, `style:` | **ninguno** — no generan Release | `refactor: unificar headers de Course y Semester` |
| footer `BREAKING CHANGE: <descripción>` | major (`X.0.0`) | rompe un endpoint público o cambia un contrato de `docs/API.md` |

Si un PR mezcla varios commits, `semantic-release` toma el bump más alto de todos
los commits del push. Un solo `feat:` entre diez `fix:` produce minor, no patch.

## Reglas duras

- **El tipo va siempre en inglés y en minúscula**, exacto como en la tabla — no
  `Fix:`, no `Feature:`, no `arreglo:`. `commit-analyzer` matchea el string literal.
- El resumen puede estar en español (este repo documenta en español) — solo el
  prefijo `tipo:` es fijo.
- `BREAKING CHANGE:` va en el footer, no en el resumen, y en mayúsculas exactas —
  es lo único que dispara major.
- Si el cambio no debe versionarse (un typo en un comentario, un ajuste de CI que
  no afecta el comportamiento del bridge), usar `chore:` o `ci:` — no forzar `fix:`
  para que "se vea que hizo algo".
- No mezclar un cambio de comportamiento real con un `chore:` solo para evitar el
  bump — si toca código de `internal/` o `web/`, es `fix:`/`feat:`/`refactor:` según
  corresponda, no `chore:`.

## Cadencia: commits por hito, no un solo commit gigante

Al implementar una feature con varios pasos lógicos (p. ej. "agregar rate
limiting" = middleware + wiring + config + docker-compose + docs), commitear
**cada hito por separado** a medida que queda funcionando, no acumular todo en
un commit único al final. Excepción: si la feature en sí es chica (un fix de
una línea, un solo archivo), un commit está bien.

Esto no es solo estilo — un historial partido por hito es más fácil de
revisar, de revertir parcialmente, y deja claro qué `tipo:` corresponde a cada
pedazo (un `refactor:` no debería ir mezclado en el mismo commit que un
`feat:`, ver "Reglas duras" arriba).

## Ejemplos de este repo

Los commits recientes ya siguen esto sin que nadie lo forzara — son el estándar de
facto, esta guía solo lo hace explícito:

```
feat: add sortable table headers with stateful column ordering to catalog and semester views
refactor: simplify UI messaging and documentation regarding SIA vacancy refresh behavior
refactor: unify Course and Semester UI by aligning headers, toolbars, and seat status components
refactor: centralize table styles, implement countdown timer, and fix layout overflow issues
```

Nota: estos ejemplos están en inglés en el resumen (código en inglés, ver
[`CLAUDE.md`](../CLAUDE.md) § Convención de idioma) — ambos idiomas en el resumen son
válidos para `semantic-release`, lo único que importa es el prefijo `tipo:`.

## Filtro automático

`main` está protegida — un PR no mergea si no pasan estos dos checks
(`.github/workflows/`):

- **`commitlint`** — cada commit del PR sigue el formato de este documento.
- **`pr-title-lint`** — el título del PR también, cubre el caso squash-merge.

Ambos rechazan (no solo avisan) — el botón de merge queda bloqueado hasta que el
mensaje esté bien. No hay bypass salvo que seas admin del repo y fuerces el merge
igual (`enforce_admins: false` en la branch protection, a propósito, para no
trabar un merge de emergencia).
