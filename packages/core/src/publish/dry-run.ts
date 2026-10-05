import type { MediaKind, Platform, PublicationFormat } from "../enums.js";
import type { PlatformAccount } from "../platform-account.js";
import type { Publisher, PublishInput, PublishResult } from "../ports/publisher.js";
import { checkPublishInput } from "./input.js";

/**
 * Lo que se habría enviado en `dry-run` (spec F3 §4.3): formato, caption completo, medios (rutas
 * de R2, tipo, tamaño y medidas) y la cuenta. Va a la bitácora (`publish_attempt`), nunca al log
 * (el caption trae datos del aviso). **Nunca** lleva URLs firmadas ni credenciales: se arma
 * campo por campo, no copiando el `PublishInput`.
 */
export type DryRunRecord = {
  platform: Platform;
  format: PublicationFormat;
  title: string | null;
  caption: string;
  media: {
    mediaId: string;
    storagePath: string;
    kind: MediaKind;
    mime: string;
    bytes: number;
    width: number | null;
    height: number | null;
    durationS: number | null;
  }[];
  account: { id: string; displayName: string };
};

/** Arma el registro de `dry-run` de un intento, sin URLs firmadas ni credenciales. */
export function dryRunRecord(
  input: PublishInput,
  account: Pick<PlatformAccount, "id" | "displayName">,
): DryRunRecord {
  return {
    platform: input.platform,
    format: input.format,
    title: input.title,
    caption: input.caption,
    media: input.media.map((item) => ({
      mediaId: item.mediaId,
      storagePath: item.storagePath,
      kind: item.kind,
      mime: item.mime,
      bytes: item.bytes,
      width: item.width,
      height: item.height,
      durationS: item.durationS,
    })),
    account: { id: account.id, displayName: account.displayName },
  };
}

/** Id simulado de una publicación en `dry-run`. */
export const dryRunExternalId = (publicationId: string) => `dry-run:${publicationId}`;

export type DryRunOptions = {
  /** Recibe lo que se habría enviado, para la bitácora del intento (T11). */
  onRecord?: (record: DryRunRecord) => void | Promise<void>;
};

/**
 * Envuelve un publisher para `dry-run` (ADR-0014, spec F3 §4.3): `publish` valida
 * (`checkPublishInput`: un `PublishInput` inválido es `PUBLISH_INPUT_INVALID` con los motivos),
 * entrega a `onRecord` lo que se habría enviado y devuelve un resultado simulado
 * (`dry-run:<publicationId>`, sin enlace). **Nunca** llama a `publish` del envuelto ni guarda
 * progreso: no hay nada creado en la plataforma.
 */
export function withDryRun(publisher: Publisher, options: DryRunOptions = {}): Publisher {
  return {
    platform: publisher.platform,
    formats: publisher.formats,
    validate: (input) => publisher.validate(input),
    async publish(input, ctx): Promise<PublishResult> {
      checkPublishInput(publisher, input);
      await options.onRecord?.(dryRunRecord(input, ctx.account));
      return {
        externalId: dryRunExternalId(input.publicationId),
        externalUrl: null,
        simulated: true,
      };
    },
  };
}
