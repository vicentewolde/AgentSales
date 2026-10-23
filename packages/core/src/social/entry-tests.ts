import type { PostPlatform } from "../enums.js";

// Las pruebas de entrada de las redes de los posts (spec F9 §4.8): cada red publica de verdad solo
// después de la suya, que hace el operador a mano con su cuenta. El resultado se anota en la nota
// de la red (`docs/integraciones/`), con una línea legible por máquina
// (`<!-- entry-test: S4 passed 2026-10-21 -->` o `<!-- entry-test: S2 pending -->`); este registro
// repite **solo lo anotado ahí**. La lista «Lista para publicar a diario» (F9.5-T27) lo muestra;
// nunca lo deduce de otra cosa. Un test lee esas líneas y falla si el registro no dice lo mismo.

/** Una prueba de entrada: sus códigos, la nota donde se anota y el día en que pasó (o `null`). */
export type EntryTest = {
  /** `S1` a `S6` (LinkedIn tiene dos: S2 y S3). */
  codes: readonly string[];
  /** La nota de la red, desde la raíz del repositorio. */
  doc: string;
  /** El día (`AAAA-MM-DD`) en que la nota la da por pasada; `null` mientras siga pendiente. */
  passedOn: string | null;
  /**
   * Si la prueba solo hace falta para publicar **por la API**: una cuenta a mano (LinkedIn) no
   * llama a la red, así que no la necesita.
   */
  onlyForApi: boolean;
  /** Lo que la nota deja pendiente aun con la prueba pasada (en palabras), o `null`. */
  pendingNote: string | null;
};

/** Lo anotado en las notas de cada red (revisado el 2026-10-22). */
export const ENTRY_TESTS: Readonly<Record<PostPlatform, EntryTest>> = {
  instagram: {
    codes: ["S1"],
    doc: "docs/integraciones/instagram-contenido-propio.md",
    passedOn: "2026-10-21",
    onlyForApi: false,
    pendingNote: null,
  },
  x: {
    codes: ["S4"],
    doc: "docs/integraciones/x.md",
    passedOn: "2026-10-21",
    onlyForApi: false,
    pendingNote: "el hilo (no lo hace AgentSales) y si un error 4xx cobra",
  },
  linkedin: {
    codes: ["S2", "S3"],
    doc: "docs/integraciones/linkedin.md",
    passedOn: null,
    onlyForApi: true,
    pendingNote: null,
  },
  discord: {
    codes: ["S5"],
    doc: "docs/integraciones/discord.md",
    passedOn: "2026-10-21",
    onlyForApi: false,
    pendingNote: null,
  },
  tiktok: {
    codes: ["S6"],
    doc: "docs/integraciones/tiktok.md",
    passedOn: "2026-10-21",
    onlyForApi: false,
    pendingNote: null,
  },
};

/** `S2 y S3`, `S4`: los códigos de una prueba en palabras. */
export const entryTestCodesText = (test: Pick<EntryTest, "codes">): string =>
  test.codes.length <= 1
    ? (test.codes[0] ?? "")
    : `${test.codes.slice(0, -1).join(", ")} y ${test.codes.at(-1)}`;
