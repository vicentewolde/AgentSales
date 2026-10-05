import type { Platform, PublicationFormat } from "../enums.js";
import type {
  PublishContext,
  Publisher,
  PublishInput,
  PublishIssue,
  PublishResult,
} from "../ports/publisher.js";
import { structuredCopy } from "./copy.js";

/**
 * Un paso guionado de `publish`: guarda `progress` (si viene) y después lanza `error` o devuelve
 * el resultado (por defecto, publicado con un id y un enlace falsos).
 */
export type FakePublishStep = {
  progress?: unknown;
  error?: Error;
  result?: { externalId: string; externalUrl: string | null };
};

export type FakePublisherOptions = {
  platform?: Platform;
  formats?: readonly PublicationFormat[];
  /** Motivos que devuelve `validate`: fijos o según el input. Sin motivos, es válido. */
  issues?: readonly PublishIssue[] | ((input: PublishInput) => readonly PublishIssue[]);
  /** Un paso por llamada a `publish`, en orden; sin pasos pendientes, publica. */
  steps?: readonly FakePublishStep[];
};

/** Una llamada a `publish`, sin las credenciales ni `saveProgress`. */
export type FakePublishCall = {
  input: PublishInput;
  accountId: string;
  progress: unknown | null;
};

export type FakePublisher = Publisher & {
  /** Los inputs que recibió `validate`, en orden. */
  validated: PublishInput[];
  /** Las llamadas a `publish`, en orden. */
  published: FakePublishCall[];
};

/**
 * Publisher falso para los tests de core (spec F3-T07): `validate` y `publish` guionados y
 * registrados. No es el de Instagram (`packages/publishers`): core no depende de los adaptadores.
 */
export function createFakePublisher(options: FakePublisherOptions = {}): FakePublisher {
  const steps = [...(options.steps ?? [])];
  const validated: PublishInput[] = [];
  const published: FakePublishCall[] = [];
  return {
    platform: options.platform ?? "instagram",
    formats: options.formats ?? ["post", "reel"],
    validated,
    published,
    validate(input) {
      validated.push(structuredCopy(input));
      const issues =
        typeof options.issues === "function" ? options.issues(input) : (options.issues ?? []);
      return issues.length === 0 ? { ok: true } : { ok: false, issues: [...issues] };
    },
    async publish(input: PublishInput, ctx: PublishContext): Promise<PublishResult> {
      published.push(
        structuredCopy({ input, accountId: ctx.account.id, progress: ctx.progress ?? null }),
      );
      const step = steps.shift() ?? {};
      if (step.progress !== undefined) await ctx.saveProgress(step.progress);
      if (step.error !== undefined) throw step.error;
      const result = step.result ?? {
        externalId: `fake-${input.publicationId}-${published.length}`,
        externalUrl: `https://example.test/p/${input.publicationId}`,
      };
      return { ...result, simulated: false };
    },
  };
}
