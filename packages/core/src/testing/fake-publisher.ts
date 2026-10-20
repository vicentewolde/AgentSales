import type { Platform, PublicationFormat } from "../enums.js";
import type {
  PlatformContext,
  PublishContext,
  PublishedRef,
  Publisher,
  PublishInput,
  PublishIssue,
  PublishOutcome,
  PublishValidation,
  RemoteStatus,
} from "../ports/publisher.js";
import { sendOnce } from "../publish/outcome.js";
import { structuredCopy } from "./copy.js";

/**
 * Un paso guionado de `publish`: guarda `progress` (si viene) y después lanza `error` o devuelve
 * el resultado (por defecto, publicado con un id y un enlace falsos; con `manualConfirm`, el
 * formulario listo). `handoff` fuerza el formulario listo (también sin `manualConfirm`, para probar
 * que el intento lo rechaza).
 */
export type FakePublishStep = {
  progress?: unknown;
  error?: Error;
  handoff?: { notes?: string[] };
  result?: {
    externalId: string;
    externalUrl: string | null;
    simulated?: boolean;
    notes?: string[];
  };
};

export type FakePublisherOptions = {
  platform?: Platform;
  formats?: readonly PublicationFormat[];
  /** Como Marketplace (ADR-0017): `publish` deja el formulario listo para el clic del operador. */
  manualConfirm?: true;
  /** Motivos que devuelve `validate`: fijos o según el input. Sin motivos, es válido. */
  issues?: readonly PublishIssue[] | ((input: PublishInput) => readonly PublishIssue[]);
  /** Un paso por llamada a `publish`, en orden; sin pasos pendientes, publica. */
  steps?: readonly FakePublishStep[];
  /**
   * Con esto el falso tiene `preflight` (como Portal; sin esto, no, como Instagram): lo que
   * devuelve, o el error que lanza.
   */
  preflight?: PublishValidation | Error;
  /**
   * Con esto el falso tiene `pause`, `resume`, `close` y `getStatus` (como Portal): el estado que
   * devuelven (por defecto, el de cada operación), o el error que lanzan.
   */
  operations?: { status?: RemoteStatus; error?: Error };
};

/** Una operación sobre lo publicado, sin el token. */
export type FakeOperationCall = {
  operation: "pause" | "resume" | "close" | "getStatus";
  ref: PublishedRef;
  accountId: string;
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
  /** Los inputs que recibió `preflight`, en orden. */
  preflighted: PublishInput[];
  /** Las operaciones, en orden. */
  operated: FakeOperationCall[];
};

/** El estado que deja cada operación en el falso, como lo informaría Mercado Libre. */
const OPERATION_STATUS: Record<FakeOperationCall["operation"], string> = {
  pause: "paused",
  resume: "active",
  close: "closed",
  getStatus: "active",
};

/**
 * Publisher falso para los tests de core (spec F3-T07): `validate` y `publish` guionados y
 * registrados. No es el de Instagram (`packages/publishers`): core no depende de los adaptadores.
 */
export function createFakePublisher(options: FakePublisherOptions = {}): FakePublisher {
  const steps = [...(options.steps ?? [])];
  const validated: PublishInput[] = [];
  const published: FakePublishCall[] = [];
  const preflighted: PublishInput[] = [];
  const operated: FakeOperationCall[] = [];
  const preflightResult = options.preflight;
  const operations = options.operations;
  const operation =
    (name: FakeOperationCall["operation"]) =>
    async (ref: PublishedRef, ctx: PlatformContext): Promise<RemoteStatus> => {
      operated.push(structuredCopy({ operation: name, ref, accountId: ctx.account.id }));
      if (operations?.error !== undefined) throw operations.error;
      return (
        operations?.status ?? {
          status: OPERATION_STATUS[name],
          subStatus: [],
          stopTime: null,
          expirationTime: null,
        }
      );
    };
  return {
    platform: options.platform ?? "instagram",
    formats: options.formats ?? ["post", "reel"],
    ...(options.manualConfirm === true ? { manualConfirm: true as const } : {}),
    validated,
    published,
    preflighted,
    operated,
    ...(preflightResult === undefined
      ? {}
      : {
          async preflight(input: PublishInput): Promise<PublishValidation> {
            preflighted.push(structuredCopy(input));
            if (preflightResult instanceof Error) throw preflightResult;
            return structuredCopy(preflightResult);
          },
        }),
    ...(operations === undefined
      ? {}
      : {
          pause: operation("pause"),
          resume: operation("resume"),
          close: operation("close"),
          getStatus: operation("getStatus"),
        }),
    validate(input) {
      validated.push(structuredCopy(input));
      const issues =
        typeof options.issues === "function" ? options.issues(input) : (options.issues ?? []);
      return issues.length === 0 ? { ok: true } : { ok: false, issues: [...issues] };
    },
    async publish(input: PublishInput, ctx: PublishContext): Promise<PublishOutcome> {
      published.push(
        structuredCopy({ input, accountId: ctx.account.id, progress: ctx.progress ?? null }),
      );
      const step = steps.shift() ?? {};
      if (step.progress !== undefined) await ctx.saveProgress(step.progress);
      if (step.error !== undefined) throw step.error;
      if (
        step.handoff !== undefined ||
        (options.manualConfirm === true && step.result === undefined)
      ) {
        const notes = step.handoff?.notes;
        return {
          handoff: "manual_confirm",
          simulated: false,
          ...(notes === undefined ? {} : { notes: [...notes] }),
        };
      }
      const result = step.result ?? {
        externalId: `fake-${input.publicationId}-${published.length}`,
        externalUrl: `https://example.test/p/${input.publicationId}`,
      };
      return { simulated: false, ...result };
    },
  };
}

/** Lo que hace la llamada que publica de `createSendOncePublisher`, en orden. */
export type FakeSendStep =
  /** Publica: devuelve un id y un enlace. */
  | "ok"
  /** Falla sin certeza (un corte de red): `sendOnce` lo vuelve `OUTCOME_UNKNOWN`. */
  | "cut"
  /** Dispara `abort` (el apagado del worker) y falla: el intento queda en `publishing`. */
  | { abort: { abort(): void } }
  /** Falla con un error que prueba que no salió (`notSent`): se borra el "enviando". */
  | { notSent: Error };

export type SendOncePublisher = Publisher & {
  /** Los inputs de cada llamada que publica (las que llegaron a la red), en orden. */
  sends: PublishInput[];
  /** Los tokens que pidió al proveedor del contexto, en orden. */
  tokens: string[];
};

/**
 * Publisher falso de una red sin idempotencia (Discord, X) que usa `sendOnce` (ADR-0029 punto 8),
 * para los tests del resultado dudoso: registra solo las llamadas que publican. Con
 * `useAccessToken`, pide el token al contexto antes de enviar (X: `ensureRotatingAccessToken`).
 */
export function createSendOncePublisher(
  platform: Platform,
  {
    steps = [],
    useAccessToken = false,
    now,
  }: { steps?: FakeSendStep[]; useAccessToken?: boolean; now?: () => Date } = {},
): SendOncePublisher {
  const pending = [...steps];
  const sends: PublishInput[] = [];
  const tokens: string[] = [];
  const notSentErrors = new Set<unknown>();
  return {
    platform,
    formats: ["post"],
    sends,
    tokens,
    validate: () => ({ ok: true }),
    async publish(input: PublishInput, ctx: PublishContext): Promise<PublishOutcome> {
      if (useAccessToken) {
        if (ctx.accessToken === undefined) throw new Error("el intento no armó el proveedor");
        tokens.push(await ctx.accessToken());
      }
      const result = await sendOnce(ctx, {
        ...(now === undefined ? {} : { now }),
        notSent: (error) => notSentErrors.has(error),
        send: async () => {
          sends.push(structuredCopy(input));
          const step = pending.shift() ?? "ok";
          if (step === "ok") {
            return {
              externalId: `msg-${sends.length}`,
              externalUrl: `https://example.test/${platform}/${sends.length}`,
            };
          }
          if (step === "cut") throw new Error("se cortó la conexión");
          if ("abort" in step) {
            step.abort.abort();
            throw new Error("se cortó la llamada");
          }
          notSentErrors.add(step.notSent);
          throw step.notSent;
        },
      });
      return { ...result, simulated: false };
    },
  };
}
