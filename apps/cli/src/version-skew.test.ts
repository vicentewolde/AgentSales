import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  brokerData,
  fakeClock,
  harness,
  readyListing,
  rewriteJson,
  simulateContentWorker,
} from "../test/harness.js";
import { ApiCallError, unwrap } from "./api-client.js";
import { runContent } from "./commands/content.js";
import { runPlanShow } from "./commands/plan.js";
import { runPostShow } from "./commands/post.js";
import { captureNotices, noticeOnce, resetNotices } from "./notices.js";

// F9.5-T11 (spec F9.5 §4.2, B5): una CLI y un servidor de versiones distintas. La API avisa su
// versión en `X-AgentSales-Version` y la CLI tolera un valor de enum que no conoce. El "servidor
// nuevo" es la API real en proceso con la respuesta cambiada (`rewriteJson`): nada sale a la red.

let notices: string[];
beforeEach(() => {
  notices = captureNotices();
});
afterEach(() => {
  resetNotices();
  vi.restoreAllMocks();
});

const NEW_VALUES = "El servidor envió valores que esta CLI no conoce";

/** Una respuesta 200 con este JSON, como la de `fetch`. */
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const itemSchema = z.object({
  status: z.enum(["queued", "done"]),
  at: z.coerce.date(),
  tags: z.array(z.enum(["a", "b"])),
});
const schema = z.object({
  items: z.array(itemSchema),
  language: z.enum(["es", "en"]).default("es"),
});

describe("unwrap con un valor de enum nuevo", () => {
  it("lo acepta tal como llegó, y valida y convierte lo demás (fechas y valores por defecto)", async () => {
    const data = await unwrap(
      jsonResponse({
        items: [
          { status: "done", at: "2026-10-22T10:00:00.000Z", tags: ["a"] },
          { status: "archived", at: "2026-10-22T11:00:00.000Z", tags: ["a", "c"] },
        ],
      }),
      schema,
    );

    expect(data.items.map((item) => item.status)).toEqual(["done", "archived"]);
    expect(data.items[1]?.tags).toEqual(["a", "c"]);
    expect(data.items[1]?.at).toBeInstanceOf(Date);
    expect(data.items[1]?.at.toISOString()).toBe("2026-10-22T11:00:00.000Z");
    expect(data.language).toBe("es");
    expect(notices).toEqual([
      `${NEW_VALUES} (archived, c): se muestran tal como llegan; actualiza la CLI`,
    ]);
  });

  it("avisa una sola vez por comando, aunque lleguen varias respuestas", async () => {
    for (let i = 0; i < 3; i++) {
      await unwrap(
        jsonResponse({ items: [{ status: "archived", at: "2026-10-22T10:00:00Z", tags: [] }] }),
        schema,
      );
    }

    expect(notices).toHaveLength(1);
  });

  it("un error que no es de un valor de enum sigue siendo UNEXPECTED_RESPONSE", async () => {
    const wrong: unknown[] = [
      // Falta el campo: no es un valor nuevo, es otra forma.
      { items: [{ at: "2026-10-22T10:00:00Z", tags: [] }] },
      // Un número donde va un texto del enum.
      { items: [{ status: 3, at: "2026-10-22T10:00:00Z", tags: [] }] },
      // Una fecha que no es fecha.
      { items: [{ status: "done", at: "no es fecha", tags: [] }] },
      // Un valor nuevo junto a otro error: tampoco se acepta.
      { items: [{ status: "archived", tags: [] }] },
      // Otro servicio en el puerto.
      { hola: "mundo" },
    ];
    for (const body of wrong) {
      const failure = await unwrap(jsonResponse(body), schema).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiCallError);
      expect(failure).toMatchObject({ code: "UNEXPECTED_RESPONSE" });
    }
    expect(notices).toEqual([]);
  });
});

describe("avisos en stderr", () => {
  it("salen por stderr, una vez, y nunca por stdout", () => {
    resetNotices();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    noticeOnce("prueba", "un aviso");
    noticeOnce("prueba", "un aviso");

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("un aviso");
    expect(stdout).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

/** La ruta de la API (sin el servidor) de un pedido del arnés. */
const pathOf = (url: string) => new URL(url).pathname;

/**
 * Lo que piden `post show` y `plan show`: no esperan ni preguntan, pero comparten las dependencias
 * de los comandos de `post` y `plan`.
 */
const waitingDeps = (h: ReturnType<typeof harness>) => {
  const clock = fakeClock();
  return {
    ...h.io,
    client: h.client,
    sleep: clock.sleep,
    now: clock.now,
    confirm: async () => false,
    stdinIsTty: () => true,
    readStdin: async () => "",
    cwd: process.cwd(),
  };
};

async function contentHarness(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  const listing = await readyListing(h);
  await h.contentRuns.create({ listingId: listing.id, texts: true });
  await simulateContentWorker(h, listing.id).finish();
  return h;
}

describe("versión de la CLI y del servidor", () => {
  it("si difieren, avisa una vez por comando en stderr, sin fallar ni tocar stdout (--json)", async () => {
    // La API de prueba responde 0.0.1.
    const h = await contentHarness({ cliVersion: "0.2.0" });

    expect(await runContent({ ...h.io, client: h.client }, "P-001", { json: true })).toBe(0);
    expect(await runContent({ ...h.io, client: h.client }, "P-001", { json: true })).toBe(0);

    expect(notices).toEqual(["La CLI es 0.2.0 y el servidor 0.0.1: actualiza la que esté atrás"]);
    // stdout sigue siendo JSON puro (dos veces el mismo contenido) y sin el aviso.
    expect(h.out).toHaveLength(2);
    for (const line of h.out) expect(() => JSON.parse(line)).not.toThrow();
    expect(h.text()).not.toContain("La CLI es");
    expect(h.errors()).toBe("");
  });

  it("con la misma versión, no avisa", async () => {
    const h = await contentHarness({ cliVersion: "0.0.1" });

    expect(await runContent({ ...h.io, client: h.client }, "P-001")).toBe(0);
    expect(notices).toEqual([]);
  });

  it("un servidor sin la cabecera (anterior a F9.5) no se compara", async () => {
    const h = await contentHarness({
      cliVersion: "0.2.0",
      afterResponse: (_url, _method, response) => {
        const headers = new Headers(response.headers);
        headers.delete("x-agentsales-version");
        return new Response(response.body, { status: response.status, headers });
      },
    });

    expect(await runContent({ ...h.io, client: h.client }, "P-001")).toBe(0);
    expect(notices).toEqual([]);
  });
});

describe("las fuentes nuevas de F9.5 contra una CLI anterior", () => {
  it("post show con una variante de medio nueva (discord_video) la muestra tal como llega", async () => {
    const h = harness({
      afterResponse: (url, method, response) =>
        method === "GET" && /^\/api\/posts\/[^/]+$/.test(pathOf(url))
          ? rewriteJson(response, (body) => {
              for (const item of body.media as { variants: string[] }[]) {
                item.variants = ["thumb", "discord_video"];
              }
            })
          : response,
    });
    const brand = await h.brokers.create(brokerData("agentpey"), { kind: "brand" });
    const post = await h.posts.create({ brokerId: brand.id, topic: "Un video", kind: "video" });
    await h.media.create({
      listingId: null,
      postId: post.id,
      brokerId: brand.id,
      kind: "video",
      storagePath: `posts/${post.id}/original/clip.mp4`,
      mime: "video/mp4",
      bytes: 1_000,
      checksum: "clip",
      sortOrder: 0,
      isCover: false,
    });

    expect(await runPostShow(waitingDeps(h), post.id)).toBe(0);
    expect(h.text()).toContain("variantes: thumb, discord_video");
    expect(notices).toEqual([
      `${NEW_VALUES} (discord_video): se muestran tal como llegan; actualiza la CLI`,
    ]);
  });

  it("content con un código de revisión nuevo (como la muletilla de T05) y un estado nuevo los muestra", async () => {
    const h = await contentHarness({
      afterResponse: (url, method, response) =>
        method === "GET" && pathOf(url).endsWith("/content")
          ? rewriteJson(response, (body) => {
              const [first] = body.contents as {
                status: string;
                checks: { code: string; severity: string; message: string }[];
              }[];
              if (first === undefined) throw new Error("sin textos");
              first.status = "revisado";
              first.checks.push({
                code: "MULETILLA_NUEVA",
                severity: "warning",
                message: "Suena a texto de IA",
              });
            })
          : response,
    });

    expect(await runContent({ ...h.io, client: h.client }, "P-001")).toBe(0);
    expect(h.text()).toContain("⚠ MULETILLA_NUEVA: Suena a texto de IA");
    expect(h.text()).toContain("revisado ·");
    expect(notices).toEqual([
      `${NEW_VALUES} (revisado, MULETILLA_NUEVA): se muestran tal como llegan; actualiza la CLI`,
    ]);
  });

  it("plan show con descartes nuevos (IDEA_TOO_SIMILAR y NO_SLOT) y una red nueva no falla", async () => {
    const h = harness({
      afterResponse: (url, method, response) =>
        method === "GET" && /^\/api\/plans\/[^/]+$/.test(pathOf(url))
          ? rewriteJson(response, (body) => {
              (body.plan as { platforms: string[] }).platforms = ["linkedin", "threads"];
              body.report = {
                discarded: [
                  {
                    topic: "Otra vez lo mismo",
                    code: "IDEA_TOO_SIMILAR",
                    message: "se parece a una idea reciente",
                  },
                  { topic: "Sin hueco", code: "NO_SLOT", message: "no quedó un horario libre" },
                ],
                warnings: [],
              };
            })
          : response,
    });
    const brand = await h.brokers.create(brokerData("agentpey"), { kind: "brand" });
    const plan = await h.planRuns.create({
      brokerId: brand.id,
      periodStart: new Date("2026-11-02T03:00:00Z"),
      periodEnd: new Date("2026-11-16T03:00:00Z"),
      request: { platforms: ["linkedin"] },
    });
    await h.planRuns.markRunning(plan.id);
    await h.planRuns.markSucceeded(plan.id, {
      report: { discarded: [], warnings: [] },
      promptVersion: "plan-v1",
    });

    expect(await runPlanShow(waitingDeps(h), plan.id)).toBe(0);
    const shown = h.text();
    expect(shown).toContain("threads");
    expect(shown).toContain("Descartadas por las revisiones (2)");
    expect(shown).toContain("Otra vez lo mismo: se parece a una idea reciente");
    expect(shown).toContain("Sin hueco: no quedó un horario libre");
    // El código del descarte ya es texto libre en el contrato; la red nueva es la que se avisa.
    expect(notices).toEqual([
      `${NEW_VALUES} (threads): se muestran tal como llegan; actualiza la CLI`,
    ]);
  });
});
