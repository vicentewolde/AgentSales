import type { PostKind, PostStatus } from "@agentsales/core";

// Los textos y colores de los posts en el panel (F9-T17). Los de la CLI viven en sus comandos; los
// estados de las publicaciones y las redes, en core.

export const POST_STATUS_LABEL: Readonly<Record<PostStatus, string>> = {
  idea: "Idea",
  draft: "Borrador",
  ready: "Listo",
  archived: "Archivado",
};

export const POST_STATUS_TONE: Readonly<Record<PostStatus, string>> = {
  idea: "bg-violet-100 text-violet-800",
  draft: "bg-slate-100 text-slate-700",
  ready: "bg-emerald-100 text-emerald-800",
  archived: "bg-slate-200 text-slate-600",
};

export const POST_KIND_LABEL: Readonly<Record<PostKind, string>> = {
  text: "Solo texto",
  image: "Imagen",
  carousel: "Carrusel",
  video: "Video",
};

export function PostStatusBadge({ status }: { status: PostStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${POST_STATUS_TONE[status]}`}
    >
      {POST_STATUS_LABEL[status]}
    </span>
  );
}
