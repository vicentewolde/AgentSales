import { describe, expect, it } from "vitest";
import {
  type DailyReadinessInput,
  dailyReadiness,
  type ReadinessAccount,
  type ReadinessKey,
} from "./daily-readiness.js";

// «Lista para publicar a diario» (F9.5-T27): cada ítem dice qué falta y cómo resolverlo, y lo que
// el sistema no sabe lo dice como «lo marca el operador», sin inventar un estado.

const account = (overrides: Partial<ReadinessAccount> & Pick<ReadinessAccount, "platform">) =>
  ({
    id: `cuenta-${overrides.platform}`,
    displayName: `@agentpey-${overrides.platform}`,
    status: "connected",
    publishingMode: overrides.platform === "instagram" ? null : "api",
    spendLimitUsd: overrides.platform === "x" ? 10 : null,
    spentUsd: overrides.platform === "x" ? 0.3 : null,
    ...overrides,
  }) satisfies ReadinessAccount;

/** Una marca lista en vivo, con horario y todas sus redes conectadas (LinkedIn a mano). */
const ready = (overrides: Partial<DailyReadinessInput> = {}): DailyReadinessInput => ({
  broker: { id: "b1", slug: "agentpey", llmMonthlyCapUsd: 5, operatorOwned: true },
  effectiveMode: "live",
  server: "live",
  networks: ["x", "linkedin", "discord", "tiktok"],
  accounts: [
    account({ platform: "x" }),
    account({ platform: "linkedin", publishingMode: "manual" }),
    account({ platform: "discord" }),
    account({ platform: "tiktok" }),
  ],
  workerSchedule: true,
  llmSpentUsd: 1.2,
  ...overrides,
});

const brandItem = (input: DailyReadinessInput, key: ReadinessKey) =>
  dailyReadiness(input).brand.find((item) => item.key === key);
const networkItem = (input: DailyReadinessInput, platform: string, key: ReadinessKey) =>
  dailyReadiness(input)
    .networks.find((network) => network.platform === platform)
    ?.items.find((item) => item.key === key);

describe("dailyReadiness: la marca", () => {
  it("en vivo, con horario y tope sin pasar, lo de la marca está listo", () => {
    const result = dailyReadiness(ready());
    expect(result.brand.map((item) => [item.key, item.state])).toEqual([
      ["mode", "ok"],
      ["worker", "ok"],
      ["ai_cap", "ok"],
    ]);
    expect(result.brand.every((item) => item.fix === null)).toBe(true);
  });

  it("el modo dice por qué está en simulación y cómo resolverlo, sin cambiar nada", () => {
    const server = brandItem(ready({ effectiveMode: "dry-run", server: "dry-run" }), "mode");
    expect(server?.state).toBe("missing");
    expect(server?.detail).toContain("PUBLISH_MODE=dry-run");
    expect(server?.fix?.text).toContain("Lo decide el operador");

    const off = brandItem(ready({ effectiveMode: "dry-run" }), "mode");
    expect(off?.detail).toContain("la marca está apagada");
    expect(off?.fix?.command).toBe("pnpm -s cli brokers live agentpey on");

    const foreign = brandItem(
      ready({
        effectiveMode: "dry-run",
        broker: { id: "b1", slug: "otra", llmMonthlyCapUsd: null, operatorOwned: false },
      }),
      "mode",
    );
    expect(foreign?.detail).toContain("no es del operador");
    expect(foreign?.fix?.command).toBeUndefined();
  });

  it("el worker: con horario listo, sin horario falta, y si no se sabe lo revisa el operador", () => {
    expect(brandItem(ready(), "worker")?.detail).toContain("cada hora");
    expect(brandItem(ready({ workerSchedule: false }), "worker")?.state).toBe("missing");
    const unknown = brandItem(ready({ workerSchedule: null }), "worker");
    expect(unknown?.state).toBe("operator");
    expect(unknown?.fix?.command).toBe("pnpm -s cli doctor");
  });

  it("el tope de IA: sin tope es un aviso; al llegar, falta con el comando", () => {
    const none = ready({
      broker: { id: "b1", slug: "agentpey", llmMonthlyCapUsd: null, operatorOwned: true },
    });
    expect(brandItem(none, "ai_cap")?.state).toBe("info");
    const over = brandItem(ready({ llmSpentUsd: 5 }), "ai_cap");
    expect(over?.state).toBe("missing");
    expect(over?.fix?.command).toBe("pnpm -s cli brokers edit agentpey --cap <dólares>");
  });
});

describe("dailyReadiness: las redes", () => {
  it("un ítem por red de la marca, en su orden, cada uno con su cuenta y su prueba", () => {
    const result = dailyReadiness(ready());
    expect(result.networks.map((network) => network.platform)).toEqual([
      "x",
      "linkedin",
      "discord",
      "tiktok",
    ]);
    for (const network of result.networks) {
      expect(network.items.slice(0, 2).map((item) => item.key)).toEqual(["account", "entry_test"]);
    }
  });

  it("sin cuenta, o vencida, falta con el comando y el botón de Cuentas (Discord por la terminal)", () => {
    const missing = networkItem(ready({ accounts: [] }), "discord", "account");
    expect(missing?.state).toBe("missing");
    expect(missing?.fix).toEqual({
      text: expect.stringContaining("terminal"),
      command: "pbpaste | pnpm -s cli accounts connect discord --broker agentpey --webhook-stdin",
      page: "/cuentas",
    });
    const expired = networkItem(
      ready({ accounts: [account({ platform: "x", status: "expired" })] }),
      "x",
      "account",
    );
    expect(expired?.detail).toContain("reconéctala");
    expect(expired?.fix?.command).toBe("pnpm -s cli accounts connect x --broker agentpey");
  });

  it("la prueba de entrada sale solo de lo anotado: hecha con su fecha, o la marca el operador", () => {
    const x = networkItem(ready(), "x", "entry_test");
    expect(x?.state).toBe("ok");
    expect(x?.detail).toBe("S4 hecha el 2026-10-21 (docs/integraciones/x.md).");
    // LinkedIn a mano no la necesita; por la API, S2 y S3 siguen pendientes y las marca el operador.
    expect(networkItem(ready(), "linkedin", "entry_test")?.state).toBe("ok");
    const api = ready({ accounts: [account({ platform: "linkedin", publishingMode: "api" })] });
    const pending = networkItem(api, "linkedin", "entry_test");
    expect(pending?.state).toBe("operator");
    expect(pending?.detail).toContain("la marca el operador");
    expect(pending?.fix?.text).toContain("docs/integraciones/linkedin.md");
    expect(networkItem(api, "linkedin", "linkedin_manual")?.fix?.command).toBe(
      "pnpm -s cli accounts mode cuenta-linkedin manual",
    );
  });

  it("X: el tope de gasto del mes, lo que falta probar y el enlace marcado", () => {
    const spend = networkItem(ready(), "x", "x_spend");
    expect(spend?.state).toBe("ok");
    expect(spend?.detail).toContain("US$ 0,30 de US$ 10,00");
    const over = networkItem(
      ready({ accounts: [account({ platform: "x", spentUsd: 10 })] }),
      "x",
      "x_spend",
    );
    expect(over?.state).toBe("missing");
    expect(over?.fix?.command).toBe("pnpm -s cli accounts spend-limit cuenta-x <dólares>");
    expect(networkItem(ready(), "x", "x_media")?.state).toBe("operator");
    expect(networkItem(ready(), "x", "x_link")?.detail).toContain("Permitir un enlace en X");
    // Sin cuenta conectada no hay tope que mostrar.
    expect(networkItem(ready({ accounts: [] }), "x", "x_spend")).toBeUndefined();
  });

  it("LinkedIn a mano, el borrador de TikTok y el video de Discord se explican sin bloquear", () => {
    expect(networkItem(ready(), "linkedin", "linkedin_manual")).toMatchObject({
      state: "info",
      detail: expect.stringContaining("Copiar texto y abrir LinkedIn"),
    });
    expect(networkItem(ready(), "tiktok", "tiktok_draft")?.detail).toContain(
      "Publicar directo espera la auditoría de TikTok",
    );
    expect(networkItem(ready(), "discord", "discord_video")?.state).toBe("info");
    for (const platform of ["linkedin", "discord", "tiktok"]) {
      expect(dailyReadiness(ready()).networks.find((n) => n.platform === platform)?.ready).toBe(
        true,
      );
    }
  });

  it("cuenta lo pendiente: X espera la revisión de su primera imagen, y sin cuenta falta más", () => {
    expect(dailyReadiness(ready()).pending).toBe(1);
    expect(dailyReadiness(ready()).ready).toBe(false);
    const nothing = dailyReadiness(
      ready({ accounts: [], effectiveMode: "dry-run", workerSchedule: false }),
    );
    // modo + worker + 4 cuentas + la imagen de X.
    expect(nothing.pending).toBe(7);
  });
});
