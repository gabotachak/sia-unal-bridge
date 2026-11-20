# Trabajo de Grado: plan

Plan para usar SIA Bridge como objeto de estudio del Trabajo de Grado (Ingeniería de
Sistemas y Computación, UNAL Bogotá, periodo 2027-1S). Este documento reúne qué pide la
norma, qué datos existen, qué se va a medir y qué hay que tocar en el código. No es
documentación del sistema: la arquitectura sigue en [ARCH.md](ARCH.md) y las constantes en
[CONSTANTS.md](CONSTANTS.md).

Estado al 2026-11-20: plan revisado, propuesta (formato de registro) **sin redactar**.

---

## Decisiones tomadas

- **Modalidad:** Trabajos investigativos, Proyecto final (Acuerdo 037 de 2017, Art. 2).
  Participación en proyecto de investigación no aplica: exige convocatoria UNAL o aval de
  la Dirección de Investigaciones.
- **SIA Bridge es trabajo previo.** Existe desde agosto de 2026 y se usó en la inscripción
  de 2026-2S. Se declara así en la propuesta. Lo nuevo del Trabajo de Grado es la
  evaluación.
- **Esfuerzo bajo.** El plan no construye infraestructura nueva para poder evaluar. Todo
  sale de datos que ya existen más una medición que se puede hacer cualquier día.
- **No es todo o nada.** El plan no depende de la inscripción de 2027-1S. Si esa ventana
  se usa, es un extra que va en metodología como validación condicional o en
  trabajo futuro, nunca en los objetivos.

---

## Lo que exige la norma

Acuerdo 037 de 2017 del Consejo de Facultad de Ingeniería, sede Bogotá. Texto leído
completo en el Régimen Legal de la UNAL (`legal.unal.edu.co/rlunal/home/doc.jsp?d_i=88861`).

| Artículo | Requisito |
|---|---|
| Art. 4 | Registro por el SIA ante el Comité Asesor **antes de que termine la semana 14 del periodo anterior**, con formato y soporte firmados por el estudiante y el director. Tarde o incompleto no se aprueba. |
| Art. 5 | Soporte mínimo: título y modalidad, nombres, introducción y justificación, objetivos, antecedentes, metodología, recursos, cronograma, presupuesto y fuentes, criterios de evaluación, resultados esperados, bibliografía, firmas. |
| Art. 8 | El director avala la propuesta, hace seguimiento, evalúa el informe y reporta la nota. |
| Art. 9 | Informe escrito al director **antes de que termine la semana 15**: título, nombres, objetivos, metodología, resultados alcanzados, análisis de resultados, trabajo futuro y conclusiones. Presentación pública solo si el director la pide antes de la semana 12. |

El formato oficial de registro (versión 2026, sitio de la Facultad) tiene las secciones 1 a
14. Para la modalidad I aplican 1 a 5 y 7 a 13.

Sin verificar: el texto del Acuerdo 026 de 2012 del Consejo Académico (el portal no lo
entrega sin navegador), los créditos de la asignatura en la malla 2A74 y la equivalencia en
horas de un crédito. Nada de lo leído prohíbe partir de un trabajo previo.

---

## Pregunta de investigación

> Durante un periodo de inscripción, ¿qué tan seguido cambian los cupos y qué compromiso
> hay entre la frescura del dato servido y el número de consultas al SIA según el tiempo de
> vida de la caché? ¿Cuánto mejora el tiempo de respuesta frente a consultar el SIA?

Motivación ya escrita en el repo: [ARCH.md, "Lo que no sabemos"](ARCH.md#lo-que-no-sabemos)
dice que `FreshnessSeats` "es una elección, no una medición". El Trabajo de Grado la mide.

El eje es cuantitativo: una caché con tiempo de vida (TTL) sobre un proceso estocástico de
cambios, estimado con observaciones censuradas. SIA Bridge es el instrumento que generó los
datos.

---

## Datos disponibles (inscripción 2026-2S)

Están en la base de producción, del 2026-08-17 al 2026-09-24. Consultas de solo lectura del
2026-11-20.

| Tabla | Qué tiene | Qué no tiene |
|---|---|---|
| `seat_snapshot` | 117 316 filas en 11 819 grupos. Una fila cada vez que el número de cupos **cambió** respecto a lo guardado, con su hora | Las observaciones sin cambio: solo `section.seats_checked_at` guarda la última |
| `course_demand` | Consultas acumuladas por asignatura (4 808 asignaturas, 3 297 819 en total) | Hora de cada consulta. Además, hasta el 2026-09-20 contaba las mediciones automáticas del frontend |
| `refresh_run` | 400 corridas del `Refresher` entre el 17 y el 24 de agosto, con POSTs y asignaturas por corrida | Qué asignaturas midió cada corrida |

Los logs por petición se perdieron: cada despliegue recrea el contenedor.

### Limitaciones que se declaran en el informe

1. **Censura.** Solo se ve un cambio cuando alguien miró. Dos cambios entre dos miradas
   cuentan como uno. Las tasas que salgan de aquí son **cotas inferiores**.
2. **Artefacto de 214 grupos.** En esos grupos el número de cupos alterna entre dos valores
   escritos con milisegundos de diferencia. Suman 44 019 filas, que se excluyen completas.
   Quedan **73 297 filas en 11 605 grupos**. La causa está en
   [Mejoras de código](#mejoras-de-código).
3. **Demanda sin serie temporal.** La carga sobre el SIA solo puede presentarse como curvas
   en función de la tasa de peticiones, no como un número observado.
4. **Autoevaluación.** El autor evalúa su propio sistema, y el sistema cambió durante la
   ventana. Se mitiga con protocolo fijado en la propuesta, datos congelados con hash y
   scripts reproducibles.

---

## Metodología (cinco pasos)

1. **Respaldo.** Dump completo privado con sha256 y una exportación por `\copy` sin la
   columna `instructor` para el análisis. Se prueba la restauración y se analiza siempre
   sobre la copia. Se filtran las filas que escribieron los tests en producción
   (ver `deploy/initdb/01-test-database.sql`).
2. **Análisis retrospectivo.** Frecuencia de cambio por grupo y por franja horaria, tamaño
   de los cambios, transiciones a cero cupos. Como cota más ajustada que el conteo de filas
   se usa la suma de |Δ| por intervalo. La semana del `Refresher` (17 al 24 de agosto) tiene
   observación casi periódica del conjunto más pedido y sirve de submuestra mejor observada.
3. **Modelo y simulación.** Cambios Poisson por franja, con prueba de dispersión (la
   inscripción por citas probablemente da sobredispersión). Con peticiones Poisson de tasa
   ρ, cambios de tasa λ y TTL τ:
   - consultas al SIA por unidad de tiempo: ρ/(1+ρτ)
   - fracción de aciertos con al menos un cambio desde la medición: 1 − (1 − e^(−λτ))/(λτ)

   La segunda es la frescura de Cho y García-Molina; hay que rederivar las dos en el
   informe. Métricas separadas: al menos un cambio desde la medición, valor distinto y
   **falso cupo** (se muestra cupo cuando ya no hay). Se compara también reproduciendo la
   traza real, que no depende del supuesto Poisson. Alcance: 3 o 4 valores de τ y 2 o 3
   escenarios de ρ. La traza no resuelve τ menores a `FreshnessSeats`: por debajo es
   extrapolación del modelo.
4. **Benchmark de latencia.** Acierto de caché, fallo que va al SIA y SIA directo, con el
   commit fijado, repeticiones, orden aleatorio, mediana y p95. Se mide desde el cliente
   porque `dur_ms` del log es entero y un acierto dura pocos milisegundos. El brazo "SIA
   directo" va con muestra pequeña y espaciada. No hay pruebas de carga contra el SIA.
5. **Informe** con la estructura del Art. 9.

### Lo que no se afirma

- "SIA Bridge reduce la carga del SIA" no es medible: no hay contrafactual, y la demanda la
  induce la propia herramienta. Lo que sí se reporta es POSTs al SIA por petición servida
  según τ, frente a τ = 0 (sin caché), con el `Refresher` como sobrecosto aparte.
- La cifra "de ~2 s a ~1 ms" que circuló antes no tiene estudio detrás. El benchmark la
  reemplaza. Piloto local del 2026-11-20 (una corrida, loopback, **no es resultado**):
  detalle 2 a 3 ms en acierto y 0,78 s en fallo; catálogo de 2A74 5,5 a 6,5 ms en acierto y
  4,2 s en fallo.

---

## Mejoras de código

Ninguna es requisito del Trabajo de Grado. Las dos primeras corrigen defectos y las demás
dejan datos mejores si se usa 2027-1S.

| | Qué | Dónde | Esfuerzo (estimado) |
|---|---|---|---|
| c | **Claves de grupo repetidas en un detalle** | `internal/sia/parse_detail.go`, fixture y test | 2 a 4 h |
| b | `SIA_TERM=2027-1` en producción | `.env` del servidor | 15 min |
| e | Tabla `seat_measurement`: cada medición de cupos, cambie o no. Elimina la censura | migración `00006` e insert junto a `UpsertDetail` en `internal/store/section.go` | 2 a 3 h |
| d | Log de acceso en Caddy, sin `remote_ip`. Sobrevive a los despliegues y ya trae URI, duración, `X-Cache`, `Age` y `X-SIA-Fetch-Ms` | bloque `log` del sitio `sia-api` | 1 h, sin Go |
| f | Foto de `/v1/status` por minuto a un JSONL | cron con `curl` en el servidor | 15 min |
| a | Republicar el dominio. La causa de la caída no está diagnosticada | Caddy y DNS del servidor | 1 a 3 h, incierto |

### Causa del artefacto (c)

Confirmado en código: `ParseDetail` valida que haya tantos `Profesor:` como grupos, pero no
que las claves sean únicas. Si dos grupos de una respuesta comparten `key`, `UpsertDetail`
los escribe sobre el mismo `section_id` en una transacción: el segundo pisa profesor y
horario, y como el primero ya cambió `current_seats`, el segundo inserta otro snapshot. Los
milisegundos de diferencia son el `time.Now()` de `parseSection` entre los dos bloques.

Sin confirmar: qué forma del SIA lo produce. Ningún fixture tiene claves repetidas. Dos
hipótesis: dos componentes de la asignatura (teórico y práctico) con su propio `Grupo 1`, o
el SIA reutilizando un token de sede (`MED-01`) para dos grupos. Se confirma capturando el
detalle de `1101/1000001-B` como fixture con `SIA_LIVE=1` desde un plan que vea `MED-01`.
El arreglo propuesto (sufijar la clave repetida por orden de página y avisar en el log)
sirve para las dos. La historia de 2026-2S de esos grupos no se repara: se excluye.

### Cambio de periodo: lo que puede dañar los datos de 2026-2S

- No se borra nada: `term` está en la clave única y 2027-1 crea filas nuevas.
- **Riesgo real:** `term` sale de `SIA_TERM`, no del SIA. Un fetch con `SIA_TERM=2026-2`
  cuando el SIA ya muestre 2027-1 escribe sobre las filas de 2026-2S y mezcla cupos de dos
  periodos. Antes de cambiarlo, comprobar a mano que un detalle traiga fechas de 2027. Y no
  republicar el dominio antes de cambiarlo.
- `course_demand` no tiene periodo: el tráfico nuevo se suma al de 2026-2S.
- Nunca correr `make migrate-down` en producción: la bajada de `00002` borra
  `course_demand` y `refresh_run`.

---

## Cronograma

Horas estimadas, no medidas.

**Antes del registro (2 de diciembre de 2026), unas 8 a 10 h:**

| Fecha | Qué |
|---|---|
| 20 al 22 nov | Respaldo con hash y restauración de prueba. No mergear a `main` cambios de código hasta tenerlo (un merge que toque `internal/**` despliega solo). |
| 21 al 23 nov | Recuento limpio con el artefacto excluido. Fixture de `1000001-B` si el SIA aún muestra 2026-2S. Confirmar créditos y requisitos con la coordinación. |
| 23 al 26 nov | Redactar el formato y enviarlo al director. |
| 30 nov a 1 dic | Firmas y registro en el SIA. |

**Antes de 2027-1S (diciembre a enero), opcional, unas 10 a 14 h:** mejoras c y e, log de
Caddy, cron de estado, segundo respaldo, cambio de periodo, republicar el dominio. Lo que no
esté desplegado una semana antes de la inscripción se descarta.

**Durante el semestre (16 semanas), unas 60 a 80 h:**

| Semanas | Qué |
|---|---|
| 1 a 3 | Congelar datos de 2027-1S si los hay. Limpieza y análisis descriptivo de 2026-2S. |
| 4 a 7 | Modelo, prueba de ajuste, simulación y reproducción de la traza. |
| 8 a 10 | Benchmark. Preguntar al director si quiere presentación pública. |
| 11 a 14 | Informe, borrador al director en la semana 14. |
| 15 | Entrega (Art. 9). |

---

## Riesgos

1. Que algo toque los datos antes del respaldo: un despliegue, un fetch con el periodo
   equivocado o el disco del servidor.
2. Que las cifras de la propuesta salgan del conteo crudo. Con el artefacto excluido
   cambian de forma material.
3. Que el resultado (cotas y curvas paramétricas) le parezca delgado al director. Se mitiga
   con rigor en el modelo y, si se puede, con datos de 2027-1S.
4. Institucional: el trabajo documenta consultas automatizadas al SIA. No se hacen pruebas
   de carga nuevas y se consulta con el director.
5. Que el SIA cambie su página durante 2027-1S y el extra cueste horas no previstas.

## Preguntas abiertas

**Para el estudiante**

- ¿Cuántos créditos tiene el Trabajo de Grado en 2A74 y qué avance exige inscribirlo?
- ¿Cuándo es la inscripción de 2027-1S?
- ¿El catálogo del SIA muestra hoy 2026-2S?
- ¿Por qué dejó de responder el dominio el 2026-09-24?
- Costos reales del servidor y del dominio, para el presupuesto.

**Para el director**

- ¿Acepta "retrospectivo + modelo + benchmark" como alcance, con 2027-1S opcional?
- ¿Qué peso le da al modelo frente al benchmark?
- ¿Quiere presentación pública?
- ¿Hay que avisar a alguna dependencia porque el objeto de estudio es el SIA?

## Referencias candidatas (todas por verificar)

- A. Cockburn, "Hexagonal architecture", 2005.
- J. Cho y H. García-Molina, "Synchronizing a database to improve freshness", SIGMOD 2000.
- J. Cho y H. García-Molina, "Estimating frequency of change", ACM TOIT, 2003.
- S. Kaul, R. Yates y M. Gruteser, "Real-time status: How often should one update?",
  INFOCOM 2012.
- M. Nottingham, RFC 5861, "HTTP Cache-Control Extensions for Stale Content", 2010.
- R. Jain, *The Art of Computer Systems Performance Analysis*, Wiley, 1991.
