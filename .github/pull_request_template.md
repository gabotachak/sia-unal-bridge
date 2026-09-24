<!--
El TÍTULO de este PR es el mensaje de commit: `tipo(alcance): resumen en
imperativo, minúscula, sin punto final`.

Con squash merge —que es como se mergea acá— el título es lo ÚNICO que queda
en `main`, y lo único que `semantic-release` lee para decidir la versión. Los
commits del PR desaparecen. Ver docs/COMMIT-CONVENTION.md.
-->

## Qué cambia y por qué

<!-- El porqué. El qué ya lo dice el diff. -->

## Verificación

<!--
El CI (.github/workflows/ci.yml) corre gofmt, vet, tests con Postgres, y lint,
tests y build del front. Pero no corre las pruebas contra el SIA real (SIA_LIVE=1)
ni mira la interfaz, y mergear a `main` despliega. Así que esto de acá abajo es el
registro de qué se probó — marca solo lo que corriste de verdad, y si algo
quedó sin probar, dilo en vez de dejarlo en blanco.
-->

- [ ] `go test ./...` <!-- los del Store se saltan solos sin TEST_DATABASE_URL: si tocaste SQL, levanta la base -->
- [ ] `go vet ./...`
- [ ] `cd web && npm run test`
- [ ] `cd web && npm run build`
- [ ] `cd web && npm run lint`
- [ ] A mano, contra datos reales <!-- ¿qué sede, qué plan, qué miraste? -->

## Riesgo

<!--
Lo que este proyecto se toma en serio no es el error ruidoso: son las 39 trampas
de docs/GOTCHAS.md, varias de las cuales devuelven datos plausibles y
equivocados sin que nadie se entere.

Si el cambio toca el protocolo ADF, el parseo, la frescura, el pool de sesiones
o el modelado: ¿cómo te enterarías de que se rompió? ¿Qué lo cubre?

Si el cambio no puede fallar en silencio, dilo en una línea y sigue.
-->

## Contrato

<!-- Marca lo que aplique. Si no aplica ninguno, borra la sección entera. -->

- [ ] Cambia una respuesta de la API → `docs/API.md` y `internal/httpapi/openapi.yaml` al día
- [ ] Cambia el esquema → migración nueva en `migrations/`, nunca editar una ya aplicada
- [ ] Rompe algo público → el commit lleva `BREAKING CHANGE:` en el footer
- [ ] Lo que se verificó contra el SIA y lo que se asumió quedó en `docs/OPEN-QUESTIONS.md`

Closes #
