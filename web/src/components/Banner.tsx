import './Banner.css';

/**
 * El aviso rojo de arriba de todo.
 *
 * Temporal por definición: existe mientras la actualización de datos esté
 * fallando y se borra —el componente entero, no una bandera— cuando deje de
 * fallar. Por eso no tiene props, ni estado, ni botón de cerrar: mientras el
 * dato de abajo pueda estar viejo, el aviso no debería poder esconderse.
 *
 * `role="status"`: es información sobre el estado de la app, no una alerta
 * que interrumpa lo que el lector esté haciendo.
 */
export function Banner() {
  return (
    <div className="banner" role="status">
      <p>
        Estamos experimentando problemas temporales actualizando la información, trabajamos
        para solucionarlos.
      </p>
    </div>
  );
}
