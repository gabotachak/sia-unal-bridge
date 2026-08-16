import { useCallback, useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import './Confirm.css';

/**
 * La confirmación de la casa, en vez del `window.confirm` del navegador.
 *
 * El nativo funciona pero no es nuestro: trae la tipografía del sistema, dice
 * "localhost:5173 says", pone Cancel/OK en inglés y congela la pestaña entera
 * mientras está abierto. Encima aparece de golpe, sin transición.
 *
 * Lo que NO se cambia es el elemento: esto es un `<dialog>` de verdad, no un
 * `<div>` con `position: fixed`. El navegador ya sabe hacer bien lo difícil —
 * atrapar el foco adentro, cerrar con Escape, pintar en la capa superior por
 * encima de cualquier z-index, dejar el fondo inerte, anunciarlo como diálogo
 * modal a un lector de pantalla. Reimplementar eso a mano es de donde salen
 * los modales que se navegan con Tab por detrás.
 */
export type ConfirmOpts = {
  title: string;
  /** El cuerpo. Párrafos sueltos, no un bloque con `\n` adentro. */
  body: React.ReactNode;
  /** El botón que confirma. Dice lo que va a pasar —"Empezar de nuevo"—, no
   *  "OK": alguien que lee solo los botones tiene que entender qué eligió. */
  confirmLabel: string;
  cancelLabel?: string;
  /** Rojo en el botón de confirmar. Para lo que borra sin deshacer. */
  danger?: boolean;
};

/**
 * Devuelve `[ask, dialog]`: la función que pregunta y el nodo que hay que
 * pintar. El nodo va una vez en la pantalla que pregunta, en cualquier lado —
 * el navegador lo saca de su sitio y lo pinta en la capa superior igual.
 *
 * `ask` devuelve una promesa, así que los sitios que llamaban a window.confirm
 * cambian de `const ok = window.confirm(...)` a `const ok = await ask(...)` y
 * el resto de la función queda igual.
 */
export function useConfirm() {
  // Dos estados y no uno: `opts` sobrevive al cierre a propósito. Si el texto
  // se borrara junto con `open`, la caja se vaciaría mientras todavía se está
  // desvaneciendo y se vería el parpadeo.
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const [open, setOpen] = useState(false);
  const resolve = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback(
    (o: ConfirmOpts) =>
      new Promise<boolean>((res) => {
        resolve.current = res;
        setOpts(o);
        setOpen(true);
      }),
    [],
  );

  /** Un solo camino de salida, lo cierre quien lo cierre: el botón, Escape, el
   *  fondo. La promesa se contesta UNA vez —se limpia la referencia antes de
   *  llamarla— porque cerrar con el botón también dispara el `close` nativo. */
  const done = useCallback((ok: boolean) => {
    const r = resolve.current;
    resolve.current = null;
    setOpen(false);
    r?.(ok);
  }, []);

  // El estado manda sobre el elemento, nunca al revés. showModal() y close()
  // son imperativos —no hay forma declarativa de abrir un modal nativo— así
  // que este efecto es el único sitio donde se tocan.
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // El diálogo se devuelve armado en vez de exportar un componente aparte: son
  // una sola cosa —la pregunta y su caja— y partirlas obligaría a pasarse tres
  // props de ida y vuelta para nada.
  const dialog = (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="modal-title"
      // Escape lo cierra solo: el navegador dispara `close` y acá se contesta
      // que no. Sin esto, cerrar con la tecla dejaría la promesa colgada para
      // siempre y quien esperaba nunca seguiría.
      onClose={() => done(false)}
      // Clic en el fondo. El backdrop no es un elemento aparte: los clics
      // caen sobre el <dialog>, y el contenido está en un <div> que los para.
      onClick={(e) => {
        if (e.target === ref.current) done(false);
      }}
    >
      {opts && (
        <div className="modal__box">
          <h2 className="modal__title" id="modal-title">
            {opts.danger && (
              <TriangleAlert className="modal__warn" size={18} strokeWidth={2} aria-hidden="true" />
            )}
            {opts.title}
          </h2>

          <div className="modal__body">{opts.body}</div>

          <div className="modal__actions">
            {/* El foco arranca en cancelar, no en confirmar: quien llegó acá
                por accidente y aporrea Enter no debería borrar nada. */}
            <button type="button" className="btn" autoFocus onClick={() => done(false)}>
              {opts.cancelLabel ?? 'Cancelar'}
            </button>
            <button
              type="button"
              className={opts.danger ? 'btn btn--danger-solid' : 'btn btn--primary'}
              onClick={() => done(true)}
            >
              {opts.confirmLabel}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );

  return [ask, dialog] as const;
}
