/** Una línea de log: datos estructurados y mensaje. */
export type AppLogFn = (data: Record<string, unknown>, message: string) => void;

/**
 * Lo que la API usa del logger; el de `@agentsales/config` (pino) lo cumple. Es un tipo mínimo a
 * propósito: `AppType` arrastra la firma de `createApp`, y usar el `Logger` de pino metería los
 * tipos de Node en el panel web, que importa `AppType` (spec F0, T08).
 */
export type AppLogger = { debug: AppLogFn; info: AppLogFn; warn: AppLogFn; error: AppLogFn };
