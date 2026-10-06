import {
  type AbortSignalLike,
  AppError,
  isAppError,
  type JobQueue,
  type RefreshAccountTokensDeps,
  refreshAccountTokens,
} from "@agentsales/core";
import { defineJob, type Job, type JobSchedule, type QueuePolicy } from "./define.js";

/**
 * Clave fija de `tokens.refresh`: con la cola `exclusive`, el job del arranque y el del cron nunca
 * corren a la vez ni se acumulan (spec F3-T14).
 */
export const TOKENS_REFRESH_KEY = "tokens.refresh";

/**
 * Política de `tokens.refresh` (spec F3 §4.6, `docs/01-arquitectura.md` → Cola de trabajos):
 * `exclusive` con `singletonKey` fijo (la política no se puede cambiar después de crear la cola),
 * 3 reintentos con backoff desde 60 s y expiración a los 5 min (cada llamada a Instagram tiene su
 * tope de 30 s, y en F3 hay una cuenta por corredor).
 */
export const TOKENS_REFRESH_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 5 * 60,
};

/**
 * Una vez al día, a mediodía de Chile: el worker corre solo con `pnpm dev` (ADR-0007), así que se
 * elige una hora de trabajo. Si el worker estaba apagado, el cron perdido no se repite
 * (`missed: "skip"`): lo cubre el refresco del arranque.
 */
export const TOKENS_REFRESH_SCHEDULE: JobSchedule<"tokens.refresh"> = {
  cron: "0 12 * * *",
  tz: "America/Santiago",
  data: {},
  singletonKey: TOKENS_REFRESH_KEY,
};

export type TokensRefreshJobDeps = {
  platformAccounts: RefreshAccountTokensDeps["platformAccounts"];
  /**
   * Instagram Login. El refresco solo usa el token (no el par de la app), así que el worker lo arma
   * siempre, como la API: una cuenta conectada con el token del panel no vence por falta del par.
   */
  instagram: RefreshAccountTokensDeps["instagram"];
  /** Se dispara al apagar el worker: no se empieza otra cuenta y se corta la llamada en curso. */
  signal: AbortSignalLike;
  now?: () => Date;
};

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/**
 * Job `tokens.refresh`: corre el lote `refreshAccountTokens` de core. El log lleva solo ids de
 * cuentas y códigos, nunca tokens (la URL del refresco lleva el token y no sale del cliente de
 * Instagram). Si alguna cuenta falló por algo pasajero (red, cupo, base), el job falla con
 * `TOKENS_REFRESH_INCOMPLETE` y pg-boss lo reintenta: las que ya se refrescaron quedan fuera por
 * las 24 h, así que repetir el lote no las refresca de nuevo.
 */
export function tokensRefreshJob(deps: TokensRefreshJobDeps): Job {
  return defineJob({
    name: "tokens.refresh",
    queue: TOKENS_REFRESH_QUEUE,
    schedule: TOKENS_REFRESH_SCHEDULE,
    errorLogFields: (error) => ({
      code: codeOf(error),
      retriable: !isAppError(error) || error.retriable,
      ...(isAppError(error) && error.details?.accountIds !== undefined
        ? { accountIds: error.details.accountIds }
        : {}),
    }),
    handler: async (_data, { logger }) => {
      const report = await refreshAccountTokens(
        {
          platformAccounts: deps.platformAccounts,
          instagram: deps.instagram,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          onWarning: ({ accountId, code }) =>
            logger.warn({ accountId, code }, "aviso del refresco de tokens"),
        },
        { signal: deps.signal },
      );
      logger.info(
        {
          refreshed: report.refreshed,
          expired: report.expired,
          skipped: report.skipped,
          failed: report.failed,
        },
        "tokens revisados",
      );
      if (report.expired.length > 0) {
        logger.warn(
          { accountIds: report.expired },
          "cuentas con el acceso vencido: hay que reconectarlas",
        );
      }
      const pending = report.failed.filter((failure) => failure.retriable);
      if (pending.length > 0) {
        throw new AppError(
          "TOKENS_REFRESH_INCOMPLETE",
          "No se pudieron refrescar algunos tokens: se reintenta",
          { retriable: true, details: { accountIds: pending.map((failure) => failure.accountId) } },
        );
      }
    },
  });
}

/** Encola el refresco del arranque; si ya hay uno en cola o en curso, `singletonKey` no lo repite. */
export const enqueueTokensRefresh = (queue: JobQueue) =>
  queue.enqueue("tokens.refresh", {}, { singletonKey: TOKENS_REFRESH_KEY });
