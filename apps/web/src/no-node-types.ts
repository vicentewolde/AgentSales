// Guardia: el panel no debe ver tipos de Node (spec F0, T08). Si algo alcanzable desde `AppType`
// arrastra pino, drizzle, pg-boss o @types/node, `process` pasa a existir, esta directiva queda
// sin error que esperar y `tsc -b` falla. Regla en docs/01-arquitectura.md (Tipos alcanzables
// desde `AppType`). Los tests quedan fuera de este programa (`tsconfig.test.json`): Vitest trae
// los tipos de Node.
// @ts-expect-error la web no ve tipos de Node
export type NoNodeTypes = typeof process;
