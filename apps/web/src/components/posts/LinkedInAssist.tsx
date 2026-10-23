import type { ContentView } from "@agentsales/api/contracts";
import { joinedPostText } from "@agentsales/core";
import { useState } from "react";
import { Button } from "../ui/Button.js";
import { buttonClasses } from "../ui/styles.js";

/** La página de LinkedIn que se abre: el inicio, donde está «Crear una publicación». */
export const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";

type CopyState = "idle" | "copied" | "failed";

/**
 * «Copiar texto y abrir LinkedIn» (F9.5-T27): para una publicación de LinkedIn a mano que espera tu
 * confirmación. Copia el texto aprobado (con sus hashtags) al portapapeles con un botón y abre
 * linkedin.com en otra pestaña con un enlace normal: **no automatiza el navegador** ni toca LinkedIn.
 * Tú pegas el texto, adjuntas los medios del post, publicas y confirmas abajo con el enlace del post.
 */
export function LinkedInAssist({
  content,
}: {
  content: Pick<ContentView, "body" | "hashtags"> | undefined;
}) {
  const [copy, setCopy] = useState<CopyState>("idle");
  if (content === undefined) return null;
  const text = joinedPostText(content);
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <fieldset
      aria-label="Publicar en LinkedIn a mano"
      className="mt-3 min-w-0 rounded-lg border border-info-200 bg-info-50 p-3 text-sm"
    >
      <p className="text-info-800">
        1. «Copiar texto y abrir LinkedIn» copia el texto aprobado y abre LinkedIn en otra pestaña.
        2. Crea una publicación y pega el texto (con las imágenes del post, si tiene). 3. Publica,
        copia el enlace del post y confírmalo aquí abajo.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* Un enlace normal: el clic copia el texto y el navegador abre LinkedIn en otra pestaña. */}
        <a
          href={LINKEDIN_FEED_URL}
          target="_blank"
          rel="noreferrer noopener"
          onClick={() => void copyText()}
          className={buttonClasses("primary", "sm")}
        >
          Copiar texto y abrir LinkedIn
        </a>
        <Button variant="link" className="text-xs" onClick={() => void copyText()}>
          Solo copiar el texto
        </Button>
        <span role="status" className="text-xs text-fg-muted">
          {copy === "copied" && "Texto copiado: pégalo en LinkedIn"}
          {copy === "failed" && "No se pudo copiar: selecciona el texto del post a mano"}
        </span>
      </div>
    </fieldset>
  );
}
