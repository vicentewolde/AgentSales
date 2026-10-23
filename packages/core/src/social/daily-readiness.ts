import type { PlatformAccountStatus, PostPlatform, PublishMode } from "../enums.js";
import { PLATFORM_TEXT } from "../labels.js";
import { formatUsd, roundUsd } from "../llm-usage.js";
import { workerScheduleText } from "../worker-schedule.js";
import { ENTRY_TESTS, entryTestCodesText } from "./entry-tests.js";
import { X_LINK_POST_COST_USD, X_POST_COST_USD } from "./networks.js";

// «Lista para publicar a diario» (F9.5-T27): lo que necesita una marca para que sus posts salgan
// solos, cada día, en sus redes. Cada ítem dice qué falta y cómo resolverlo (un comando de la CLI o
// una página del panel). La lista **no decide nada**: no publica, no cambia el modo ni la cuenta, y
// lo que el sistema no sabe (una prueba de entrada sin anotar, el horario que solo ve el
// administrador) lo dice como «lo marca el operador», sin inventar un estado.

/**
 * - `ok`: listo;
 * - `missing`: falta algo que se resuelve con el paso del ítem;
 * - `operator`: el sistema no lo sabe o lo hace el operador a mano (una prueba de entrada, revisar
 *   la primera publicación de verdad); cuenta como pendiente;
 * - `info`: algo que conviene saber, que no bloquea.
 */
export const READINESS_STATES = ["ok", "missing", "operator", "info"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const READINESS_KEYS = [
  "mode",
  "worker",
  "ai_cap",
  "image_ai_cap",
  "account",
  "entry_test",
  "x_spend",
  "x_media",
  "x_link",
  "linkedin_manual",
  "tiktok_draft",
  "discord_video",
] as const;
export type ReadinessKey = (typeof READINESS_KEYS)[number];

/** El nombre de cada ítem en la lista. */
export const READINESS_LABEL: Readonly<Record<ReadinessKey, string>> = {
  mode: "Modo de la marca",
  worker: "El worker",
  ai_cap: "Tope de IA del mes",
  image_ai_cap: "Tope de imágenes con IA",
  account: "Cuenta conectada",
  entry_test: "Prueba de entrada",
  x_spend: "Tope de gasto de X",
  x_media: "Imágenes y video en X",
  x_link: "Enlace en X",
  linkedin_manual: "LinkedIn a mano",
  tiktok_draft: "Borrador en TikTok",
  discord_video: "Video en Discord",
};

/** Cómo se resuelve un ítem: en palabras y, si hay, un comando o una página del panel. */
export type ReadinessFix = {
  text: string;
  /** El comando de la CLI (se copia; nunca lleva un secreto). */
  command?: string;
  /** Una ruta del panel (`/cuentas`), para un botón. */
  page?: string;
};

export type ReadinessItem = {
  key: ReadinessKey;
  label: string;
  state: ReadinessState;
  detail: string;
  /** Solo en `missing` y `operator`. */
  fix: ReadinessFix | null;
};

export type NetworkReadiness = {
  platform: PostPlatform;
  /** Sin nada `missing` ni `operator`. */
  ready: boolean;
  items: ReadinessItem[];
};

export type DailyReadiness = {
  brokerId: string;
  slug: string;
  /** La marca y todas sus redes listas. */
  ready: boolean;
  /** Cuántos ítems faltan (`missing` u `operator`). */
  pending: number;
  /** Lo de la marca: modo, worker y tope de IA. */
  brand: ReadinessItem[];
  /** Un grupo por red de la marca, en el orden de `POST_PLATFORMS`. */
  networks: NetworkReadiness[];
};

/** Lo que la lista mira de una cuenta de la marca. */
export type ReadinessAccount = {
  id: string;
  platform: PostPlatform;
  displayName: string;
  status: PlatformAccountStatus;
  /** LinkedIn, X, Discord y TikTok: a mano o por la API; `null` en Instagram. */
  publishingMode: "api" | "manual" | null;
  /** X: el tope del mes (`xSpendLimitOf`) y lo gastado este mes de Chile; `null` en las demás. */
  spendLimitUsd: number | null;
  spentUsd: number | null;
};

export type DailyReadinessInput = {
  broker: {
    id: string;
    slug: string;
    llmMonthlyCapUsd: number | null;
    operatorOwned: boolean;
  };
  /**
   * El modo con que saldría hoy lo de la marca. Lo calcula quien llama con la única fuente del modo
   * (ADR-0036); la lista solo lo muestra. Con el servidor en vivo y la marca en simulación, es que
   * la marca está apagada (o no es propia).
   */
  effectiveMode: PublishMode;
  /** El modo del servidor, solo para explicar por qué la marca está en simulación. */
  server: PublishMode;
  /** Las redes de la marca (`postPlatforms`), en el orden de `POST_PLATFORMS`. */
  networks: readonly PostPlatform[];
  /** Las cuentas de la marca en esas redes (la más nueva primero si hay varias). */
  accounts: readonly ReadinessAccount[];
  /** Si el worker se enciende solo (`/health.workerSchedule`, ADR-0037); `null` si no se sabe. */
  workerSchedule: boolean | null;
  /** Si el worker tiene un latido reciente (`workerStatusOf`); `null` si no se sabe. */
  workerRunning: boolean | null;
  /**
   * Las imágenes con IA (F9.5-T25): lo gastado y el tope del mes, o `null` si la IA de imágenes no
   * está configurada (sin `GEMINI_API_KEY`).
   */
  imageAi: { spentUsd: number; capUsd: number; capReached: boolean } | null;
  /** Lo gastado en IA este mes de Chile por la marca. */
  llmSpentUsd: number;
};

const pendingState = (state: ReadinessState) => state === "missing" || state === "operator";

function item(
  key: ReadinessKey,
  state: ReadinessState,
  detail: string,
  fix: ReadinessFix | null = null,
): ReadinessItem {
  return { key, label: READINESS_LABEL[key], state, detail, fix: pendingState(state) ? fix : null };
}

/** El comando para conectar una red (el mismo que muestra `accounts`). */
export function connectCommand(platform: PostPlatform, slug: string): string {
  if (platform === "instagram") {
    return `pbpaste | pnpm -s cli accounts connect instagram --broker ${slug} --token-stdin`;
  }
  if (platform === "discord") {
    return `pbpaste | pnpm -s cli accounts connect discord --broker ${slug} --webhook-stdin`;
  }
  return `pnpm -s cli accounts connect ${platform} --broker ${slug}`;
}

const CONNECT_TEXT: Readonly<Record<PostPlatform, string>> = {
  instagram: "Conéctala en Cuentas (Conectar Instagram) o pega el token de Generate token",
  x: "Conéctala en Cuentas (Conectar X) o con el comando, con el panel abierto en el mismo host",
  linkedin: "Conéctala en Cuentas (Conectar LinkedIn) o con el comando; nace a mano",
  discord:
    "Copia la URL del webhook del canal y conéctala desde la terminal (la URL nunca se pega en el panel)",
  tiktok: "Conéctala en Cuentas (Conectar TikTok), solo desde el servidor (TikTok exige https)",
};

function modeItem(input: DailyReadinessInput): ReadinessItem {
  const { broker } = input;
  if (input.effectiveMode === "live") {
    return item("mode", "ok", "En vivo: lo programado de la marca sale de verdad a su hora.");
  }
  if (input.server !== "live") {
    return item(
      "mode",
      "missing",
      "Simulación: el servidor está en simulación (PUBLISH_MODE=dry-run), así que nada sale de verdad.",
      {
        text: "Lo decide el operador: el servidor en vivo y la marca encendida (docs/10-despliegue.md).",
      },
    );
  }
  if (!broker.operatorOwned) {
    return item(
      "mode",
      "missing",
      "Simulación: la marca no es del operador, y una marca ajena no se enciende (ADR-0036).",
      { text: "Márcala como propia solo si lo es (administrador): brokers edit --own." },
    );
  }
  return item(
    "mode",
    "missing",
    "Simulación: el servidor está en vivo, pero la marca está apagada.",
    {
      text: "Lo decide el operador: enciende la marca en su ficha (Corredores) o con el comando.",
      command: `pnpm -s cli brokers live ${broker.slug} on`,
    },
  );
}

/**
 * El worker (ADR-0037). Solo el administrador lo ve: para los demás, `null` («no se sabe»).
 * - Con horario (`WORKER_IDLE_EXIT_MINUTES` > 0), el worker se apaga solo y lo enciende el workflow:
 *   la API no sabe si ese workflow tiene su secreto, así que lo revisa el operador.
 * - Sin horario, el worker nunca se apaga solo: sirve si está encendido (un latido reciente).
 */
function workerItem(schedule: boolean | null, running: boolean | null): ReadinessItem {
  if (schedule === null) {
    return item("worker", "operator", "No se sabe: solo el administrador ve el worker.", {
      text: "Lo revisa el operador con doctor.",
      command: "pnpm -s cli doctor",
    });
  }
  if (schedule) {
    return item(
      "worker",
      "operator",
      `El worker se apaga solo y lo enciende el horario (${workerScheduleText()}).`,
      {
        text: "Revisa que el workflow «Encender el worker» tenga su secreto (docs/10-despliegue.md, paso 8): sin él, nada lo enciende.",
      },
    );
  }
  if (running === true) {
    return item(
      "worker",
      "info",
      "Sin horario y encendido (latido reciente): lo programado sale mientras siga encendido.",
    );
  }
  return item(
    "worker",
    "missing",
    running === false
      ? "Sin horario y apagado: lo programado no sale hasta que se encienda."
      : "Sin horario, y no se sabe si el worker está encendido (no se pudo leer su latido).",
    {
      text: "Enciende el worker (en el Mac, pnpm dev; en el servidor, docs/10-despliegue.md, paso 8) o activa el horario (lo hace el operador).",
      command: "pnpm -s cli doctor",
    },
  );
}

/** El tope de las imágenes con IA (F9.5-T25, ADR-0038): sin la clave, solo tarjetas y biblioteca. */
function imageAiItem(imageAi: DailyReadinessInput["imageAi"]): ReadinessItem {
  if (imageAi === null) {
    return item(
      "image_ai_cap",
      "info",
      "La IA de imágenes no está configurada en el servidor: «Conseguir imagen» ofrece tarjetas y la biblioteca.",
    );
  }
  const spent = roundUsd(imageAi.spentUsd);
  const text = `${formatUsd(spent)} de ${formatUsd(imageAi.capUsd)} este mes`;
  return imageAi.capReached
    ? item(
        "image_ai_cap",
        "info",
        `${text}: llegaste al tope; hasta el mes siguiente, usa tarjetas o la biblioteca.`,
      )
    : item("image_ai_cap", "ok", `${text}.`);
}

function aiCapItem(input: DailyReadinessInput): ReadinessItem {
  const cap = input.broker.llmMonthlyCapUsd;
  const spent = roundUsd(input.llmSpentUsd);
  const command = `pnpm -s cli brokers edit ${input.broker.slug} --cap <dólares>`;
  if (cap === null) {
    return item(
      "ai_cap",
      "info",
      `Sin tope: el plan y los textos de la IA gastan sin freno (este mes, ${formatUsd(spent)}).`,
    );
  }
  if (spent >= cap) {
    return item(
      "ai_cap",
      "missing",
      `Llegaste al tope (${formatUsd(spent)} de ${formatUsd(cap)}): no se piden planes ni textos hasta el mes siguiente.`,
      { text: "Súbelo (administrador) o espera al mes siguiente.", command },
    );
  }
  return item("ai_cap", "ok", `${formatUsd(spent)} de ${formatUsd(cap)} este mes.`);
}

function accountItem(
  platform: PostPlatform,
  account: ReadinessAccount | undefined,
  slug: string,
): ReadinessItem {
  const fix = {
    text: CONNECT_TEXT[platform],
    command: connectCommand(platform, slug),
    page: "/cuentas",
  };
  if (account === undefined) {
    return item("account", "missing", `Sin cuenta de ${PLATFORM_TEXT[platform]}.`, fix);
  }
  if (account.status !== "connected") {
    return item(
      "account",
      "missing",
      `${account.displayName} está vencida o con error: reconéctala.`,
      fix,
    );
  }
  return item("account", "ok", `Conectada: ${account.displayName}.`);
}

function entryTestItem(
  platform: PostPlatform,
  account: ReadinessAccount | undefined,
): ReadinessItem {
  const test = ENTRY_TESTS[platform];
  const codes = entryTestCodesText(test);
  // Una cuenta a mano no llama a la red (LinkedIn nace a mano): su prueba es solo para la API.
  if (test.onlyForApi && (account?.publishingMode ?? "manual") === "manual") {
    return item(
      "entry_test",
      "ok",
      `No hace falta mientras vaya a mano: ${codes} son para publicar por la API.`,
    );
  }
  if (test.passedOn !== null) {
    const rest = test.pendingNote === null ? "" : ` Queda por ver: ${test.pendingNote}.`;
    return item("entry_test", "ok", `${codes} hecha el ${test.passedOn} (${test.doc}).${rest}`);
  }
  return item(
    "entry_test",
    "operator",
    `${codes} pendiente: la marca el operador, después de hacerla a mano con su cuenta.`,
    {
      text: `El operador la hace y anota el resultado en ${test.doc}; hasta entonces ${PLATFORM_TEXT[platform]} sale solo en simulación${test.onlyForApi ? " o a mano" : ""}.`,
    },
  );
}

/** Lo propio de cada red: el tope de X, lo que falta probar, a mano y el borrador. */
function networkExtras(
  platform: PostPlatform,
  account: ReadinessAccount | undefined,
): ReadinessItem[] {
  const connected = account?.status === "connected" ? account : undefined;
  switch (platform) {
    case "x": {
      const extras: ReadinessItem[] = [];
      if (connected !== undefined && connected.spendLimitUsd !== null) {
        const spent = roundUsd(connected.spentUsd ?? 0);
        const limit = connected.spendLimitUsd;
        const command = `pnpm -s cli accounts spend-limit ${connected.id} <dólares>`;
        extras.push(
          spent >= limit
            ? item(
                "x_spend",
                "missing",
                `Llegaste al tope del mes (${formatUsd(spent)} de ${formatUsd(limit)}): lo de X falla sin llamar a X.`,
                { text: "Súbelo (administrador) o espera al mes siguiente.", command },
              )
            : item(
                "x_spend",
                "ok",
                `${formatUsd(spent)} de ${formatUsd(limit)} este mes (un post de texto cuesta unos ${formatUsd(X_POST_COST_USD)}). Los créditos de X los cargas tú en console.x.com.`,
              ),
        );
      }
      extras.push(
        item(
          "x_media",
          "info",
          "Una imagen o un video en X todavía no se publicaron de verdad (S4 fue un texto sin enlace): mira en X la primera publicación en vivo con imagen o video.",
        ),
        item(
          "x_link",
          "info",
          `Un post con enlace en X necesita «Permitir un enlace en X» (cuesta ${formatUsd(X_LINK_POST_COST_USD)} en vez de ${formatUsd(X_POST_COST_USD)}); sin esa marca, su texto de X no se aprueba.`,
        ),
      );
      return extras;
    }
    case "linkedin": {
      if (connected?.publishingMode === "api" && ENTRY_TESTS.linkedin.passedOn === null) {
        return [
          item(
            "linkedin_manual",
            "missing",
            "La cuenta está por la API sin S2 y S3: debe volver a mano.",
            {
              text: "Pásala a mano (administrador).",
              command: `pnpm -s cli accounts mode ${connected.id} manual`,
            },
          ),
        ];
      }
      return [
        item(
          "linkedin_manual",
          "info",
          "A mano: cada día, en el post, «Copiar texto y abrir LinkedIn», lo pegas y confirmas con el enlace del post.",
        ),
      ];
    }
    case "tiktok":
      return [
        item(
          "tiktok_draft",
          "info",
          "El video llega como borrador a la app de TikTok: lo publicas desde el teléfono y confirmas con el enlace. Publicar directo espera la auditoría de TikTok.",
        ),
      ];
    case "discord":
      return [
        item(
          "discord_video",
          "info",
          "Fotos y video de hasta 20 MiB (la versión liviana); un video más grande sale sin adjuntar, solo con el texto.",
        ),
      ];
    default:
      return [];
  }
}

/** La cuenta de una red: la conectada si hay; si no, la primera que no esté desconectada. */
function accountOf(
  accounts: readonly ReadinessAccount[],
  platform: PostPlatform,
): ReadinessAccount | undefined {
  const own = accounts.filter((account) => account.platform === platform);
  return (
    own.find((account) => account.status === "connected") ??
    own.find((account) => account.status !== "revoked")
  );
}

/**
 * La lista «Lista para publicar a diario» de una marca (F9.5-T27): lo de la marca (modo, worker y
 * tope de IA) y, por cada red, la cuenta, la prueba de entrada y lo propio de la red. Pura: no lee
 * nada ni decide el modo (lo trae `effectiveMode`).
 */
export function dailyReadiness(input: DailyReadinessInput): DailyReadiness {
  const brand = [
    modeItem(input),
    workerItem(input.workerSchedule, input.workerRunning),
    aiCapItem(input),
    imageAiItem(input.imageAi),
  ];
  const networks = input.networks.map((platform): NetworkReadiness => {
    const account = accountOf(input.accounts, platform);
    const items = [
      accountItem(platform, account, input.broker.slug),
      entryTestItem(platform, account),
      ...networkExtras(platform, account),
    ];
    return { platform, ready: !items.some((one) => pendingState(one.state)), items };
  });
  const pending = [...brand, ...networks.flatMap((network) => network.items)].filter((one) =>
    pendingState(one.state),
  ).length;
  return {
    brokerId: input.broker.id,
    slug: input.broker.slug,
    ready: pending === 0,
    pending,
    brand,
    networks,
  };
}
