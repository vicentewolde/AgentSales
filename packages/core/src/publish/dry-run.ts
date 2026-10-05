import type { Publisher, PublishResult } from "../ports/publisher.js";
import { checkPublishInput } from "./input.js";

/** Id simulado de una publicación en `dry-run`. */
export const dryRunExternalId = (publicationId: string) => `dry-run:${publicationId}`;

/**
 * Envuelve un publisher para `dry-run` (ADR-0014, spec F3 §4.3): `publish` valida
 * (`checkPublishInput`: un `PublishInput` inválido es `PUBLISH_INPUT_INVALID` con los motivos) y
 * devuelve un resultado simulado (`dry-run:<publicationId>`, sin enlace). **Nunca** llama a
 * `publish` del envuelto ni guarda progreso: no hay nada creado en la plataforma. Lo que se habría
 * enviado lo registra quien llama, igual que en `live` (`publishAttemptRecord`).
 */
export function withDryRun(publisher: Publisher): Publisher {
  return {
    platform: publisher.platform,
    formats: publisher.formats,
    validate: (input) => publisher.validate(input),
    async publish(input): Promise<PublishResult> {
      checkPublishInput(publisher, input);
      return {
        externalId: dryRunExternalId(input.publicationId),
        externalUrl: null,
        simulated: true,
      };
    },
  };
}
