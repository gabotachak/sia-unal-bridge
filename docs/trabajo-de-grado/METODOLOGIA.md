# Trabajo de Grado: metodología detallada

El formato de registro lleva la metodología resumida. Este documento guarda el detalle que
no cabe ahí: qué se mide en cada actividad, con qué criterio se juzga, qué modela el
simulador y qué límites se declaran. El contexto y las decisiones están en
[README.md](./README.md); el plan de la fase 0, en [PLAN-2027-1S.md](./PLAN-2027-1S.md).

Las cifras del sistema se nombran por su constante, como en el resto de la documentación:
sus valores están en [CONSTANTS.md](../CONSTANTS.md) y en `.env.example`. Las cifras de
este documento son datos del Trabajo de Grado: conteos, fechas, pisos y umbrales.

Semanas de cada actividad (las del cronograma del registro):

| Actividad | Semanas | Objetivo |
|---|---|---|
| Fase 0. Instrumentación | antes de la inscripción de 2027-1S | 5 |
| 1. Respaldo de datos y verificación de la instrumentación | 1 a 3 | 5; apoya 2 y 3 |
| 2. Análisis de diseño | 1 a 4 | 1 |
| 3. Evaluación de usabilidad | 3 a 5 | 4 |
| 4. Desempeño, fiabilidad y corrección | 5 a 8 | 2 |
| 5. Simulación de tiempos de vida de la caché | 7 a 10 | 3 |
| 6. Implementación de mejoras | 10 a 12 | 5 |
| 7. Verificación de mejoras | 11 a 13 | 5 |
| 8. Informe final | 12 a 16 | todos |

---

## Fase 0. Instrumentación

Se ejecuta después del registro de la propuesta y antes de la inscripción de 2027-1S. Se
califica en la actividad 1 con su evidencia: los cambios desplegados y los datos
recogidos. El paso a paso está en [PLAN-2027-1S.md](./PLAN-2027-1S.md).

- **Migración.** El 24 de septiembre de 2026 el sistema dejó de responder por una falla de
  la infraestructura de alojamiento, ajena al código. Para no depender de un servidor
  personal, se migra a una plataforma de despliegue en la nube. Antes de migrar se
  verifica desde la plataforma el flujo completo contra el SIA.
- **Respaldo.** El corte de 2026-2S ya existe: se tomó el 20 de noviembre de 2026, con
  suma de verificación, y se conserva fuera del servidor. Antes de migrar se toma otro.
- **Registro de cada medición de cupos**, haya cambiado o no, con su hora.
- **Registro de acceso persistente** con la hora, la ruta (plan y asignatura), el
  `max_age` pedido, si la petición es de segundo plano, la duración y el resultado de
  caché. Sin IP ni identificador persistente.
- **Corrección del error de identificación de grupos**, con su evidencia documentada en
  el repositorio.
- **Enlace al cuestionario SUS** en la interfaz. Recoge respuestas desde que se publica.

Todas las mediciones del trabajo se hacen después de migrar.

**Contingencia.** Lo que no quede desplegado antes de la inscripción pasa a la actividad 6.
En ese caso el objetivo 2 se reporta solo con mediciones controladas, el SUS solo con las
tareas guiadas, y la recomendación de configuración queda como preliminar. Si el SIA no
responde igual desde la plataforma en la nube, la migración se pospone y las mediciones se
hacen desde el servidor actual.

## Consultas al SIA

Las mediciones que involucran al SIA consultan solo el catálogo público, sin
autenticación, a baja tasa y fuera de las franjas de mayor uso. No se hacen pruebas de
carga contra el SIA. El director avala el protocolo de medición antes de ejecutarlo.

Si el SIA cambia su página o bloquea el acceso, las condiciones (b), (c) y (d) y la
comparación de corrección se reportan con lo medido hasta esa fecha; los objetivos 1, 3 y
4 no dependen del SIA en vivo. Si la Universidad pide suspender las consultas, se
suspenden.

---

## Actividad 1. Respaldo de datos y verificación de la instrumentación

- Se verifican los cortes fechados previos y la evidencia de la fase 0, que se entrega al
  director en la semana 1. Se toman los cortes de 2027-1S. El análisis se hace siempre
  sobre los cortes, nunca sobre la base en producción.
- Se describen la distribución de cambios por grupo y la fracción de la demanda que
  concentran los grupos con más cambios. Cada grupo conserva la hora de su última
  medición (`section.seats_checked_at`), lo que acota la censura.
- **Grupos excluidos.** En 214 grupos (44.019 registros) dos grupos distintos de una
  misma asignatura se guardaron como uno solo, porque la respuesta del SIA repetía la
  clave del grupo dentro de un mismo detalle. Sus cupos alternan entre dos valores en un
  solo historial. Esos grupos se excluyen: de 117.316 registros en 11.819 grupos quedan
  73.297 registros en 11.605 grupos, es decir, a lo sumo 61.692 cambios, porque la
  primera medición de cada grupo también es un registro. Se reporta qué asignaturas son y
  qué fracción de la demanda representan, para acotar el sesgo de excluirlas.
- Cada cifra del informe sale de un script que queda en el repositorio.

## Actividad 2. Análisis de diseño

La documentación técnica existente ([ARCH.md](../ARCH.md), [DIAGRAMS.md](../DIAGRAMS.md),
[GOTCHAS.md](../GOTCHAS.md)) es trabajo previo y es el punto de partida, no el resultado.
Lo nuevo es, para cada decisión, la alternativa descartada y su costo.

| Decisión | Cómo se cuantifica el costo de la alternativa |
|---|---|
| Caché de lectura directa (read-through) | mediciones de la actividad 4 |
| Catálogo servido con dato vencido y actualizado en segundo plano | mediciones de la actividad 4 |
| Conjunto de sesiones con una operación a la vez en cada una | mediciones de la actividad 4 |
| Arquitectura hexagonal | medidas estáticas del código (puertos, adaptadores, prueba de dependencias), sin evaluarlo |

Para cada decisión se expone también la restricción del SIA que la motiva. No se
implementan alternativas. Como la actividad 4 termina después, el costo se cierra en la
actividad 8. La mantenibilidad se describe; no se evalúa.

## Actividad 3. Evaluación de usabilidad

- **Tareas guiadas.** Al menos cinco estudiantes (Nielsen, 2000, con base en el modelo de
  Nielsen y Landauer, 1993) realizan tres tareas en la interfaz: buscar una asignatura,
  consultar los cupos de un grupo y armar un horario con asignaturas dadas. Se registran
  tarea completada, tiempo y problemas observados. Al final cada participante responde el
  SUS en su versión en español validada (Sevilla-Gonzalez et al., 2020) y deja sugerencias.
- **SUS por enlace.** Las respuestas se recogen desde la fase 0 y el enlace cierra en la
  semana 5. Se espera reunir al menos 30; con menos se reportan sin intervalo de
  confianza.
- **Reporte.** Las sesiones guiadas y las respuestas del enlace se reportan por separado.
  Los problemas se listan por frecuencia.
- **Participantes y datos.** Se convocan por los canales en que se difundió la
  herramienta. No se recogen datos que identifiquen a los participantes; se pide
  consentimiento informado sobre el uso de las respuestas (Ley 1581 de 2012).

## Actividad 4. Desempeño, fiabilidad y corrección

### Tiempo de respuesta

Un script toma al menos 100 mediciones por condición en total, repartidas en varias
franjas horarias y en orden aleatorio, desde la misma región y red que SIA Bridge.

| Condición | Qué mide | Precisiones |
|---|---|---|
| (a) | dato en caché | |
| (b) | dato fuera de caché, a través de SIA Bridge | sobre asignaturas distintas, porque `FETCH_COOLDOWN` impide repetir la misma; se precalienta con una petición al mismo plan, para que la sesión ya esté posicionada; se reporta también el tiempo de consulta al SIA que devuelve la API (`X-SIA-Fetch-Ms`) |
| (c) | flujo completo contra el SIA sin sesión previa | apertura de la sesión, secuencia de formularios, listado y detalle |
| (d) | flujo directo contra el SIA con la sesión ya posicionada | |

Se reportan la mediana y las razones (a)/(c), (b)/(c) y (b)/(d), con intervalo de
confianza por remuestreo (Efron y Tibshirani, 1993), y el percentil 90 (Jain, 1991). Las
medidas previas `SIA_DETAIL_WARM` y `SIA_DETAIL_COLD` son el antecedente de las
condiciones (d) y (c); estas mediciones las reemplazan.

Con el registro de acceso de la fase 0 se reportan además los tiempos y la tasa de
aciertos de caché en producción. Los tiempos controlados se miden sobre la instancia base
del presupuesto; la tasa de aciertos de la inscripción corresponde a la instancia de
mayor capacidad.

### Fiabilidad

- **Inventario.** Las pruebas existentes sobre fallos del SIA son trabajo previo:
  `internal/sia/pool_recovery_test.go`, `internal/sia/noop_test.go` e
  `internal/catalog/service_test.go`.
- **Pruebas nuevas.** Pruebas de integración con un SIA simulado por HTTP detrás de la
  API completa. Comprueban código de estado, tiempo máximo de respuesta y marca de dato
  desactualizado en tres casos: latencia alta, SIA sin respuesta y respuesta truncada.
  Cada caso se ejecuta en lecturas forzadas (`max_age=0`) y no forzadas, y en el servicio
  de cupos por grupo, que no tiene respaldo con dato almacenado.
- **Respaldo con dato almacenado.** Aplica solo al detalle de asignatura, cuando la
  lectura no pide `max_age=0`, existe copia de ese plan y el fallo no agota el límite de
  la petición (`SIA_ACQUIRE_TIMEOUT_SECONDS`). Por eso el resultado esperado de cada
  prueba se define antes de ejecutarla, y se reporta el resultado de la primera
  ejecución, antes de cualquier corrección.
- **Recuperabilidad.** Un caso más: restablecido el SIA simulado, la siguiente petición
  obtiene dato nuevo sin reiniciar el proceso.
- **Incidentes de operación de 2026-2S.** Son dos y se analizan como evidencia
  cualitativa de recuperabilidad, sin estimar disponibilidad: causa, duración
  aproximada, detección y corrección. La evidencia es la documentación del repositorio,
  el historial de cambios y el recuerdo del autor.

  | Fecha | Qué pasó | Corrección |
  |---|---|---|
  | 20 de septiembre de 2026 | el conjunto de sesiones quedó inservible; diagnosticado en [GOTCHAS.md §41](../GOTCHAS.md) | cada reapertura de sesión parte de un almacén de cookies vacío |
  | 24 de septiembre de 2026 | el sistema dejó de responder por una falla de la infraestructura de alojamiento, ajena al código; la duración no quedó registrada | la migración de la fase 0 |

### Corrección funcional

- Se comparan a mano con la interfaz del SIA al menos 20 asignaturas, campo por campo:
  grupos, horarios, cupos y profesores, que son datos públicos del SIA.
- La muestra tiene al menos una asignatura de cada sede y al menos una de cada nivel,
  elegidas al azar por estrato con la semilla registrada, más los casos límite
  documentados en [GOTCHAS.md](../GOTCHAS.md): asignaturas sin grupos, grupos PEAMA y
  cabeceras atípicas.
- Cada comparación fuerza la medición y registra la hora de ambas lecturas.
- Se añade una comprobación automática de invariantes sobre toda la base: claves de grupo
  repetidas y series que alternan entre dos valores.

## Actividad 5. Simulación de tiempos de vida de la caché

El detalle está en [El simulador](#el-simulador). En resumen:

- Un programa reproduce la secuencia de cupos registrada de cada grupo y simula la caché
  con varios tiempos de vida, incluidos los tres actuales, sin bajar de `FETCH_COOLDOWN`.
- Por tiempo de vida se calculan la fracción de respuestas desactualizadas, la del caso
  crítico y las consultas al SIA por respuesta.
- Las fracciones de 2026-2S son estimaciones con sesgo probable a la baja; no son cotas:
  los cambios no observados las reducen y el retraso en detectarlos puede aumentarlas.
  Solo descartan tiempos de vida con un margen amplio sobre el umbral.
- Se entregan las curvas, el intervalo admisible o, si los datos no lo permiten, el
  límite de resolución alcanzado, y una recomendación de configuración si las mediciones
  de 2027-1S la respaldan.

## Actividad 6. Implementación de mejoras

Se empieza por los hallazgos de las actividades 3 y 4, que ya están disponibles en la
semana 10; los tiempos de vida se abordan al terminar la simulación, esa misma semana.

Mínimo comprometido:

- corregir hasta los tres problemas de usabilidad más frecuentes;
- ajustar o confirmar la configuración de tiempos de vida según la simulación;
- aplicar las correcciones que salgan de las pruebas de fallo, de la comparación con el
  SIA y del análisis de incidentes.

Si la simulación se atrasa, la configuración se confirma y el ajuste pasa a trabajo
futuro. El tiempo de vida adaptativo y las pruebas de capacidad son trabajo futuro.

## Actividad 7. Verificación de mejoras

- Las mejoras de usabilidad se verifican con una segunda ronda de tareas guiadas, con al
  menos tres participantes. Es una verificación cualitativa.
- Las demás se verifican con pruebas automatizadas que pasan en la integración continua
  del repositorio. Si una mejora afecta una medición de la actividad 4, esa medición se
  repite.

## Actividad 8. Informe final

Sigue la estructura del Art. 9 del Acuerdo 037 de 2017 y se entrega al director antes de
terminar la semana 15; la semana 16 queda para ajustes. Si el director la solicita antes
de la semana 12, se hace una presentación pública.

Anexos: el uso del asistente de inteligencia artificial (en qué partes se usó y cómo se
verificó) y el extracto del registro de ejecuciones (`refresh_run`) que respalda los
regímenes de muestreo.

---

## Medidas y criterios de juicio

Las medidas son propias, no las de ISO/IEC 25023.

| Característica | Medida | Criterio de juicio |
|---|---|---|
| Comportamiento temporal (eficiencia de desempeño, ISO/IEC 25010) | mediana y percentil 90 por condición | razones entre condiciones, con su intervalo de confianza |
| Tolerancia a fallos y recuperabilidad (fiabilidad, ISO/IEC 25010) | casos de fallo simulado que responden como se definió de antemano, dentro del límite por petición del servidor (`SIA_ACQUIRE_TIMEOUT_SECONDS`) | se espera que pasen todos; se reporta la primera ejecución, antes de cualquier corrección |
| Corrección funcional (adecuación funcional, ISO/IEC 25010) | campos que coinciden con el SIA | toda diferencia se explica o se corrige |
| Usabilidad (capacidad de interacción, ISO/IEC 25010; eficacia, eficiencia y satisfacción, ISO 9241-11) | tareas completadas, tiempo y puntaje SUS | escala de adjetivos de Bangor, Kortum y Miller (2009), como interpretación y no como criterio de aprobación |
| Actualidad (ISO/IEC 25012) | fracción del caso crítico | umbral tentativo del 5 % |

Quedan fuera del alcance la utilización de recursos, la capacidad y la disponibilidad.

**Caso crítico.** Mostrar cupos en un grupo que ya no tiene. Se mide así: de las
respuestas simuladas en cuyo instante el valor de referencia del grupo (la medición más
reciente del historial hasta ese instante) es 0, fracción en que la caché sirvió un valor
mayor que 0. La consulta es por asignatura y plan, y el caso crítico se cuenta por grupo.

El umbral tentativo es el 5 % de esas respuestas, elegido como referencia convencional, y
se fija con el director antes de simular. Se reportan también la curva completa, de
modo que el resultado no dependa del umbral, y la fracción sobre el total de respuestas.

---

## El simulador

### Tiempos de vida actuales

| Dónde | Tiempo de vida de los cupos |
|---|---|
| Vistas de asignatura y de programa | `VITE_STALE_SEATS_SECONDS`, que la interfaz envía como `max_age` |
| Asignaturas de Mi semestre, en cualquier vista | `FreshnessDetail`, el valor por defecto del detalle, salvo que el usuario fuerce la medición o haya un reintento automático tras un error transitorio |
| Servicio de cupos por grupo, que la interfaz no usa | `FreshnessSeats` |

Además, la API frena los refrescos de una misma pareja de plan y asignatura: con
cualquier `max_age` menor que `FETCH_COOLDOWN`, no vuelve al SIA si ya lo hizo hace menos
de ese lapso. Ninguno de estos valores se fijó con mediciones.

### Qué modela

- La secuencia de cupos registrada de cada grupo.
- Varios tiempos de vida, incluidos los tres actuales. `FETCH_COOLDOWN` es el piso: no se
  simula por debajo.
- La regla de vigencia del sistema: una asignatura está vigente si cualquier plan la
  midió dentro de la antigüedad pedida y el plan conoce sus grupos visibles hace menos de
  `FreshnessDetail`.

### Qué deja fuera

- Los cupos que acompañan al listado del catálogo, que se sirven con la edad que tengan.
- Los detalles que la interfaz guarda en memoria durante la sesión.

### Llegadas

- **Con 2026-2S.** De la demanda solo existe el total acumulado por sede y asignatura
  (`course_demand`), sin la hora de cada consulta. Las llegadas se generan como proceso
  de Poisson por asignatura, con el volumen total observado, repartido en proporción a la
  demanda acumulada, y dos perfiles horarios: plano y concentrado en la apertura de la
  inscripción. Se reporta la sensibilidad del resultado a la tasa.
- **Asignación a planes.** Como la demanda de 2026-2S no distingue plan, cada llegada se
  asigna a un plan en proporción a los planes en que la asignatura es visible, y se
  reporta la sensibilidad a ese supuesto.
- **Sesgo de la demanda.** El contador incluye las cargas pasivas de Mi semestre y, hasta
  el 20 de septiembre de 2026, las mediciones de fondo de la vista de programa. Por eso
  sobrestima las asignaturas que aparecían en los listados.
- **Con 2027-1S.** Se usan las horas reales de petición del registro de acceso. La
  frecuencia de cambio se estima por franjas, porque la tasa de cambio no es
  estacionaria, con el estimador para intervalos de acceso irregulares de Cho y
  Garcia-Molina (2003).

### Resolución

- Los tiempos de vida menores que el intervalo mediano entre mediciones de un grupo no
  son distinguibles. El intervalo admisible se reporta solo por encima de esa resolución.
- Como las vistas de asignatura y de programa piden `VITE_STALE_SEATS_SECONDS`, los
  intervalos entre mediciones de un grupo rara vez bajan de ese valor. Solo los refrescos
  forzados y las consultas desde planes distintos dan resolución más fina.
- Las mediciones de 2027-1S contrastan la estimación de 2026-2S para tiempos de vida
  iguales o mayores que `VITE_STALE_SEATS_SECONDS`. Por debajo, la pregunta puede quedar
  sin respuesta empírica, y ese resultado se reporta como tal. Los tiempos de vida
  cercanos a `FETCH_COOLDOWN` se simulan con 2026-2S bajo esta advertencia.
- El periodo del 17 al 23 de agosto sirve solo para comprobar que el simulador reproduce
  un régimen de muestreo conocido. Al ser anterior a la inscripción, no informa la tasa
  de cambio en el periodo de interés.

---

## Regímenes de muestreo de 2026-2S

El historial (`seat_snapshot`) guarda un registro solo cuando una consulta encontró un
número de cupos distinto del almacenado, así que la frecuencia de cambio que se obtiene
de él es una cota inferior. Mezcla tres regímenes. La inscripción abrió el 24 de agosto.

| Periodo | Cómo se midieron los cupos |
|---|---|
| 17 al 23 de agosto | actualizaciones periódicas del detalle de todas las asignaturas y de los cupos de las más consultadas, según el registro de ejecuciones (`refresh_run`) |
| 24 de agosto al 20 de septiembre | todas las asignaturas de un plan, cada vez que un usuario lo abría |
| desde el 20 de septiembre | las filas visibles y lo que el usuario abre |

Del 24 de septiembre en adelante no hay registros de 2026-2S.

---

## Límites y amenazas a la validez

- **Líneas base.** Las condiciones (c) y (d) las ejecuta un script, no una persona en un
  navegador.
- **Fuera del pico.** Los tiempos de la actividad 4 se miden fuera de la inscripción, así
  que no representan el momento de mayor uso.
- **Resolución temporal.** Ver [Resolución](#resolución).
- **Observación sesgada.** Las mediciones de cupos dependen de la demanda: se observa más
  lo más consultado.
- **Simplificación del simulador.** Ver [Qué deja fuera](#qué-deja-fuera) y los supuestos
  de [Llegadas](#llegadas).
- **Grupos excluidos.** Los 214 grupos con error de identificación no entran al
  análisis; se reporta qué demanda representan.
- **Usabilidad.** El autor modera las pruebas. Los participantes se convocan por los
  canales de la herramienta, de modo que el SUS mide sobre todo a usuarios existentes, y
  las respuestas por el enlace tienen sesgo de autoselección.
- **Autoevaluación.** El autor evalúa su propio sistema. Se mitiga con el protocolo
  fijado en la propuesta, los cortes fechados con suma de verificación y los scripts del
  repositorio.

## Referencias citadas aquí

La bibliografía completa está en el formato de registro. Aquí se citan: Bangor, Kortum y
Miller (2009); Cho y Garcia-Molina (2003); Efron y Tibshirani (1993); Jain (1991);
Nielsen (2000); Nielsen y Landauer (1993); ISO/IEC 25010:2023; ISO/IEC 25012:2008; ISO
9241-11:2018; Ley 1581 de 2012; Sevilla-Gonzalez et al. (2020). El Acuerdo 037 de 2017
del Consejo de Facultad de Ingeniería, sede Bogotá, es la norma de la asignatura y no
va en la bibliografía.
