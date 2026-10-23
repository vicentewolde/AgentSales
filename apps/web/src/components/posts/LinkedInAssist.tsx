import type { ContentView } from "@agentsales/api/contracts";
import { useState } from "react";
import { Button } from "../ui/Button.js";
import { buttonClasses } from "../ui/styles.js";
import { type LinkedInDownload, linkedinOpenTarget, linkedinText } from "./linkedin.js";

type CopyState = "idle" | "copied" | "failed";

/**
 * «Copiar texto y abrir LinkedIn» (F9.5-T27, al mínimo trabajo): un enlace normal que abre el editor
 * de LinkedIn en otra pestaña con el texto ya puesto (`?shareActive=true&text=…`, NO VERIFICADO:
 * `docs/integraciones/linkedin.md`) y, además, copia el texto al portapapeles como respaldo. Si el
 * texto es muy largo para un enlace, el editor se abre vacío y el texto va solo por el portapapeles.
 * **No automatiza el navegador** ni toca LinkedIn: tú solo aprietas «Publicar» allá. Con medios, los
 * muestra para bajarlos y ponerlos a mano en el editor. Lo usan el post y la fila de «Hoy».
 */
export function LinkedInOpenControl({
  content,
  downloads = [],
}: {
  content: Pick<ContentView, "body" | "hashtags">;
  downloads?: readonly LinkedInDownload[];
}) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const text = linkedinText(content);
  const target = linkedinOpenTarget(text);
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {/* Un enlace normal: el clic copia el texto y el navegador abre LinkedIn en otra pestaña. */}
        <a
          href={target.href}
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
          {copy === "copied" &&
            (target.withText
              ? "Texto copiado también por si LinkedIn no lo trae: pégalo si falta"
              : "Texto copiado: pégalo en el editor de LinkedIn")}
          {copy === "failed" && "No se pudo copiar: selecciona el texto del post a mano"}
        </span>
      </div>
      {!target.withText && (
        <p className="mt-2 text-xs text-warning-800">
          El texto es largo para ir en el enlace: LinkedIn se abre con el editor vacío y el texto
          queda en el portapapeles. Pégalo allá.
        </p>
      )}
      {downloads.length > 0 && <LinkedInDownloads downloads={downloads} />}
    </div>
  );
}

/** Los medios del post para bajar (o arrastrar) y ponerlos a mano en el editor de LinkedIn. */
function LinkedInDownloads({ downloads }: { downloads: readonly LinkedInDownload[] }) {
  const single = downloads.length === 1;
  return (
    <fieldset aria-label="Descargar imágenes" className="mt-3 min-w-0">
      <p className="text-xs font-medium text-fg">
        {downloads[0]?.kind === "video" ? "Descargar el video" : "Descargar imágenes"}
        <span className="font-normal text-fg-muted">
          {" "}
          · LinkedIn no {downloads[0]?.kind === "video" ? "lo trae solo" : "las trae solas"}:{" "}
          {downloads[0]?.kind === "video" ? "súbelo" : "súbelas"} o arrastra la miniatura al editor
        </span>
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-3">
        {downloads.map((item, index) => {
          const name =
            item.kind === "video"
              ? "Descargar video"
              : single
                ? "Descargar imagen"
                : `Descargar imagen ${index + 1}`;
          return (
            <li key={item.id} className="flex w-24 flex-col items-center gap-1.5 text-center">
              {item.thumbUrl !== null && (
                <img
                  src={item.thumbUrl}
                  alt={item.kind === "video" ? "Video del post" : `Imagen ${index + 1} del post`}
                  draggable
                  className="size-24 rounded-xl object-cover"
                />
              )}
              <a
                href={item.url}
                download
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs font-semibold text-brand-800 underline underline-offset-2"
              >
                {name}
              </a>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/**
 * El asistente de una publicación de LinkedIn que espera tu confirmación, en el post: los tres
 * pasos y el botón de un clic. Se confirma abajo con «Ya lo publiqué».
 */
export function LinkedInAssist({
  content,
  downloads = [],
}: {
  content: Pick<ContentView, "body" | "hashtags"> | undefined;
  downloads?: readonly LinkedInDownload[];
}) {
  if (content === undefined) {
    return (
      <p role="status" className="mt-3 text-sm text-warning-800">
        No encontré el texto aprobado de esta publicación: cópialo desde «Textos por red» y
        publícalo a mano en LinkedIn.
      </p>
    );
  }
  return (
    <section
      aria-label="Publicar en LinkedIn a mano"
      className="mt-3 min-w-0 rounded-lg border border-info-200 bg-info-50 p-3 text-sm"
    >
      <p className="text-info-800">
        1. Toca «Copiar texto y abrir LinkedIn»: se abre el editor con el texto puesto. 2. Aprieta
        «Publicar» en LinkedIn (con las imágenes del post, si tiene). 3. Vuelve y toca «Ya lo
        publiqué».
      </p>
      <div className="mt-2">
        <LinkedInOpenControl content={content} downloads={downloads} />
      </div>
    </section>
  );
}
