import { useState } from "react";
import { ArrowLeft, Check, Copy, HeartHandshake } from "lucide-react";
import { Layout } from "../components/Layout";
import { AppLink } from "../components/AppLink";
import { usePlan } from "../hooks/usePlan";
import "./Donate.css";

const BRE_B_KEY = "@NEQUIGAB107";

/**
 * "Invítame un café". Una sola pantalla, sin formulario y sin pasarela: el
 * QR y la llave Bre-B son la donación entera. Nada de esto toca `Selection`
 * ni `plan.items` — a propósito, para que sea la única pantalla de la app
 * que se puede abrir sin haber elegido plan todavía (ver el botón en
 * `Topbar`, que no lleva `iconbtn--dest`).
 */
export function Donate() {
  const plan = usePlan();
  const sel = plan.selection;
  const [copied, setCopied] = useState(false);

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(BRE_B_KEY);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Sin permiso de portapapeles (Safari en algún contexto, http sin
      // TLS): la llave ya está escrita en pantalla, seleccionable a mano.
    }
  }

  return (
    <Layout>
      <div className="donate">
        <AppLink
          to={
            sel ? { name: "program", selection: sel } : { name: "plan-picker" }
          }
          className="btn donate__back"
        >
          <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
          volver
        </AppLink>

        <div className="donate__content">
          <div className="donate__text">
            <HeartHandshake
              className="donate__icon"
              size={32}
              strokeWidth={1.5}
              aria-hidden="true"
            />

            <p className="eyebrow rise">gracias</p>
            <h1
              className="donate__title rise"
              style={{ animationDelay: "60ms" }}
            >
              Si esto te <em>sirvió</em>
            </h1>
            <p
              className="donate__lead rise"
              style={{ animationDelay: "120ms" }}
            >
              SIA Bridge es gratis, sin cuentas y sin anuncios. Vive en un
              servidor que alguien tiene en la sala de su casa. Si facilité la
              tarde de inscripción, puedes invitarme un café aquí. <span className="emoji-mobile">👇</span><span className="emoji-desktop">👉</span>
            </p>
          </div>

          <div
            className="donate__card rise"
            style={{ animationDelay: "180ms" }}
          >
            <img
              className="donate__qr"
              src="/donate-qr.webp"
              width={723}
              height={881}
              alt="Código QR Bre-B para donar a NEQUIGAB107"
            />

            <div className="donate__key">
              <span className="donate__key-label">o con tu llave Bre-B</span>
              <button
                type="button"
                className="donate__key-value tnum"
                onClick={copyKey}
              >
                <span>{BRE_B_KEY}</span>
                {copied ? (
                  <Check size={15} strokeWidth={2} aria-hidden="true" />
                ) : (
                  <Copy size={15} strokeWidth={1.75} aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
