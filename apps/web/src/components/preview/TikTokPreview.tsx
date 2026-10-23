import { Avatar, PreviewFrame, PreviewVideoBox } from "./parts.js";
import type { PreviewVideo } from "./preview.js";

/**
 * TikTok: el video vertical con la cuenta encima, **sin texto propio**: el video llega como
 * borrador a la bandeja de la app (modo *Upload*) y el texto lo pegas tú antes de publicar. Por eso
 * el texto va aparte, debajo, como lo que hay que pegar.
 */
export function TikTokPreview({
  label,
  accountName,
  text,
  video,
  draft = false,
}: {
  label: string;
  accountName: string;
  text: string;
  video: PreviewVideo | null;
  draft?: boolean;
}) {
  return (
    <PreviewFrame label={label} network="TikTok" draft={draft}>
      {video === null ? (
        <p className="flex aspect-[9/16] w-52 items-center justify-center rounded-lg bg-sand p-4 text-center text-sm text-fg-subtle">
          Sin video todavía.
        </p>
      ) : (
        <PreviewVideoBox
          video={video}
          label="Video para TikTok"
          className="aspect-[9/16] w-52 rounded-lg"
        >
          <p className="pointer-events-none absolute inset-x-0 bottom-3 flex items-center gap-2 px-3 text-sm font-semibold text-surface drop-shadow">
            <Avatar name={accountName} className="size-6 text-xs" />
            <span className="truncate">{accountName}</span>
          </p>
        </PreviewVideoBox>
      )}
      <p className="mt-2 max-w-sm text-xs text-fg-muted">
        TikTok no recibe el texto: el video llega como borrador a la bandeja de la app y ahí pegas
        este texto antes de publicar.
      </p>
      <div className="mt-1 max-w-sm rounded-md border border-dashed border-line-soft p-2">
        <p className="text-xs font-medium text-fg-subtle">Texto para pegar en la app</p>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg">{text}</p>
      </div>
    </PreviewFrame>
  );
}
