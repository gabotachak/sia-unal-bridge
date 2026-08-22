-- +goose Up
-- disabled_at marca las filas que la última reconciliación con el SIA
-- confirmó ausentes. NULL = activa. Los datos existentes quedan activos y la
-- primera pasada del Refresher hace la limpieza.
--
-- Solo cinco tablas. `course` y `section` NO la llevan: son derivables de
-- course_program y section_program respectivamente, y almacenarlas sería caro
-- (course) o incorrecto (section — la visibilidad de grupos es por programa,
-- DATA-MODEL.md §2).

ALTER TABLE level           ADD COLUMN disabled_at timestamptz;
ALTER TABLE campus          ADD COLUMN disabled_at timestamptz;
ALTER TABLE program         ADD COLUMN disabled_at timestamptz;
ALTER TABLE course_program  ADD COLUMN disabled_at timestamptz;
ALTER TABLE section_program ADD COLUMN disabled_at timestamptz;

-- El EXISTS que reemplaza a course.disabled_at entra por acá. El índice no es
-- deuda nueva: CoursesNeedingDetail y SeatsHotSet (store/refresh.go) ya
-- escanean course_program por (campus_code, code) sin índice.
CREATE INDEX course_program_campus_code_idx ON course_program (campus_code, code);

-- +goose Down
DROP INDEX course_program_campus_code_idx;
ALTER TABLE section_program DROP COLUMN disabled_at;
ALTER TABLE course_program  DROP COLUMN disabled_at;
ALTER TABLE program         DROP COLUMN disabled_at;
ALTER TABLE campus          DROP COLUMN disabled_at;
ALTER TABLE level           DROP COLUMN disabled_at;
