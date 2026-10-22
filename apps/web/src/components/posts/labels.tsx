import type { ContentView } from "@agentsales/api/contracts";
import {
  type Platform,
  POST_KIND_TEXT,
  POST_PLATFORMS,
  POST_STATUS_TEXT,
  type PostKind,
  type PostPlatform,
  type PostStatus,
} from "@agentsales/core";
import { Badge } from "../ui/Badge.js";
import type { BadgeTone } from "../ui/styles.js";

// Los colores de los posts en el panel (F9-T17). Los textos de su estado y su tipo viven en core
// (F9.5-T02: los comparte la CLI); aquí van con mayúscula inicial, como etiqueta.

/** Si una red es de las que publican posts (`POST_PLATFORMS`): el contrato tipa `Platform`. */
export const isPostPlatform = (platform: Platform): platform is PostPlatform =>
  (POST_PLATFORMS as readonly Platform[]).includes(platform);

/** El texto de un post: su red es siempre una de `POST_PLATFORMS`. */
export type PostContentView = ContentView & { platform: PostPlatform };

/**
 * Los textos de un post con su red ya acotada. La API solo entrega redes de posts en un post; si
 * llegara otra (un servidor distinto), se deja fuera en vez de mandarla a una ruta que la rechaza.
 */
export const postContents = (contents: readonly ContentView[]): PostContentView[] =>
  contents.filter((content): content is PostContentView => isPostPlatform(content.platform));

/** «borrador» → «Borrador». */
const capitalized = <K extends string>(
  texts: Readonly<Record<K, string>>,
): Readonly<Record<K, string>> =>
  Object.fromEntries(
    Object.entries<string>(texts).map(([key, text]) => [
      key,
      text.charAt(0).toUpperCase() + text.slice(1),
    ]),
  ) as Record<K, string>;

export const POST_STATUS_LABEL: Readonly<Record<PostStatus, string>> =
  capitalized(POST_STATUS_TEXT);

export const POST_STATUS_TONE: Readonly<Record<PostStatus, BadgeTone>> = {
  idea: "accent",
  draft: "neutral",
  ready: "success",
  archived: "muted",
};

export const POST_KIND_LABEL: Readonly<Record<PostKind, string>> = capitalized(POST_KIND_TEXT);

export function PostStatusBadge({ status }: { status: PostStatus }) {
  return <Badge tone={POST_STATUS_TONE[status]}>{POST_STATUS_LABEL[status]}</Badge>;
}
