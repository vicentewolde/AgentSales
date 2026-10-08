import { type Publisher, type PublishResult, platformContextOf } from "../ports/publisher.js";
import { checkPublishInput, publishInputInvalid } from "./input.js";

/** Id simulado de una publicación en `dry-run`. */
export const dryRunExternalId = (publicationId: string) => `dry-run:${publicationId}`;

/**
 * Envuelve un publisher para `dry-run` (ADR-0014, spec F3 §4.3; ADR-0016 y spec F4 §4.8):
 * 1. `publish` valida (`checkPublishInput`: un `PublishInput` inválido es `PUBLISH_INPUT_INVALID`
 *    con los motivos).
 * 2. Si el publisher tiene `preflight`, lo llama: solo lee y valida contra la plataforma (Mercado
 *    Libre: el catálogo y `POST /items/validate`). Un rechazo (`ok: false`) se trata como en `live`:
 *    `PUBLISH_INPUT_INVALID` con sus motivos (core no nombra códigos de la plataforma). Sus
 *    advertencias (`notes`) vuelven en el resultado, para la bitácora. Un error de `preflight`
 *    (red, token) sube tal cual, con su `retriable`.
 * 3. Devuelve un resultado simulado (`dry-run:<publicationId>`, sin enlace).
 * **Nunca** llama a `publish`, `pause`, `resume` ni `close` del envuelto (no los expone) ni guarda
 * progreso: no hay nada creado en la plataforma. Lo que se habría enviado lo registra quien llama,
 * igual que en `live` (`publishAttemptRecord`).
 */
export function withDryRun(publisher: Publisher): Publisher {
  const preflight = publisher.preflight?.bind(publisher);
  return {
    platform: publisher.platform,
    formats: publisher.formats,
    validate: (input) => publisher.validate(input),
    ...(preflight === undefined ? {} : { preflight }),
    async publish(input, ctx): Promise<PublishResult> {
      checkPublishInput(publisher, input);
      let notes: string[] = [];
      if (preflight !== undefined) {
        const validation = await preflight(input, platformContextOf(ctx));
        if (!validation.ok) throw publishInputInvalid(input.publicationId, validation.issues);
        notes = validation.notes ?? [];
      }
      return {
        externalId: dryRunExternalId(input.publicationId),
        externalUrl: null,
        simulated: true,
        ...(notes.length === 0 ? {} : { notes }),
      };
    },
  };
}
