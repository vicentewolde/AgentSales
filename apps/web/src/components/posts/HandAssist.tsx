import type { ContentView } from "@agentsales/api/contracts";
import { useState } from "react";
import { Button } from "../ui/Button.js";
import { buttonClasses } from "../ui/styles.js";
import { HAND_LABEL, type HandPlatform, handOpenTarget, handSteps } from "./hand.js";
import { type LinkedInDownload, linkedinText } from "./linkedin.js";

type CopyState = "idle" | "copied" | "failed";

/**
 * «Copiar texto y abrir <red>» (F9.5-T27 para LinkedIn, F9.6-T03 para X e Instagram, ADR-0041): un
 * enlace normal que abre el editor de la red en otra pestaña con el texto ya puesto (LinkedIn
 * `?shareActive=true&text=…` y X `intent/post?text=…`, NO VERIFICADOS) y, además, copia el texto al
 * portapapeles como respaldo. Si el texto es muy largo para un enlace, el editor se abre vacío y el
 * texto va solo por el portapapeles. Instagram no deja precargar nada: solo copia el texto.
 * **No automatiza el navegador** ni toca la red: tú solo aprietas «Publicar» allá. Con medios, los
 * muestra para bajarlos y ponerlos a mano. Lo usan el post y la fila de «Hoy».
 */
export function HandOpenControl({
  platform,
  content,
  downloads = [],
}: {
  platform: HandPlatform;
  content: Pick<ContentView, "body" | "hashtags">;
  downloads?: readonly LinkedInDownload[];
}) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const label = HAND_LABEL[platform];
  const text = linkedinText(content);
  const target = handOpenTarget(platform, text);
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
        {target.href === null ? (
          <Button variant="primary" size="sm" onClick={() => void copyText()}>
            Copiar texto
          </Button>
        ) : (
          <>
            {/* Un enlace normal: el clic copia el texto y el navegador abre la red en otra pestaña. */}
            <a
              href={target.href}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => void copyText()}
              className={buttonClasses("primary", "sm")}
            >
              Copiar texto y abrir {label}
            </a>
            <Button variant="link" className="text-xs" onClick={() => void copyText()}>
              Solo copiar el texto
            </Button>
          </>
        )}
        <span role="status" className="text-xs text-fg-muted">
          {copy === "copied" &&
            (target.href === null
              ? `Texto copiado: pégalo en la descripción de ${label}`
              : target.withText
                ? `Texto copiado también por si ${label} no lo trae: pégalo si falta`
                : `Texto copiado: pégalo en el editor de ${label}`)}
          {copy === "failed" && "No se pudo copiar: selecciona el texto del post a mano"}
        </span>
      </div>
      {target.href !== null && !target.withText && (
        <p className="mt-2 text-xs text-warning-800">
          El texto es largo para ir en el enlace: {label} se abre con el editor vacío y el texto
          queda en el portapapeles. Pégalo allá.
        </p>
      )}
      {downloads.length > 0 && <HandDownloads platform={platform} downloads={downloads} />}
    </div>
  );
}

/**
 * Los medios de la publicación para bajarlos y ponerlos a mano en la red. Las fotos se pueden
 * arrastrar (la imagen es la misma que se enviaría). Cada enlace baja el archivo de inmediato: la URL
 * de descarga lleva `Content-Disposition: attachment` desde R2 (el `download` de un <a> no sirve en
 * otro origen), así que no se abre otra pestaña. La vista previa usa la URL normal.
 */
function HandDownloads({
  platform,
  downloads,
}: {
  platform: HandPlatform;
  downloads: readonly LinkedInDownload[];
}) {
  const label = HAND_LABEL[platform];
  const video = downloads[0]?.kind === "video";
  const single = downloads.length === 1;
  return (
    <fieldset aria-label="Descargar imágenes" className="mt-3 min-w-0">
      <p className="text-xs font-medium text-fg">
        {video ? "Descargar el video" : "Descargar imágenes"}
        <span className="font-normal text-fg-muted">
          {" "}
          · {label} no {video ? "lo trae solo" : "las trae solas"}:{" "}
          {video
            ? "descárgalo y súbelo al editor"
            : "descárgalas y súbelas al editor, o arrastra la foto"}
        </span>
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-3">
        {downloads.map((item, index) => (
          <li key={item.id} className="flex w-24 flex-col items-center gap-1.5 text-center">
            {item.kind === "image" && (
              <img
                src={item.url}
                alt={`Imagen ${index + 1} del post`}
                draggable
                className="size-24 rounded-xl object-cover"
              />
            )}
            <a
              href={item.downloadUrl}
              download
              className="text-xs font-semibold text-brand-800 underline underline-offset-2"
            >
              {item.kind === "video"
                ? "Descargar video"
                : single
                  ? "Descargar imagen"
                  : `Descargar imagen ${index + 1}`}
            </a>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/**
 * El asistente de una publicación a mano que espera tu confirmación, en el post: los tres pasos y
 * el botón de un clic. Se confirma abajo con «Ya lo publiqué».
 */
export function HandAssist({
  platform,
  content,
  downloads = [],
}: {
  platform: HandPlatform;
  content: Pick<ContentView, "body" | "hashtags"> | undefined;
  downloads?: readonly LinkedInDownload[];
}) {
  const label = HAND_LABEL[platform];
  if (content === undefined) {
    return (
      <p role="status" className="mt-3 text-sm text-warning-800">
        No encontré el texto aprobado de esta publicación: cópialo desde «Textos por red» y
        publícalo a mano en {label}.
      </p>
    );
  }
  return (
    <section
      aria-label={`Publicar en ${label} a mano`}
      className="mt-3 min-w-0 rounded-lg border border-info-200 bg-info-50 p-3 text-sm"
    >
      <p className="text-info-800">{handSteps(platform)}</p>
      <div className="mt-2">
        <HandOpenControl platform={platform} content={content} downloads={downloads} />
      </div>
    </section>
  );
}
