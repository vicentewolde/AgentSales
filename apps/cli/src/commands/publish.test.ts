import { AppError, type Publication } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { fakeClock, harness, publicationHarness } from "../../test/harness.js";
import { type PublishOptions, runPublish } from "./publish.js";

type Setup = Awaited<ReturnType<typeof publicationHarness>>;

const run = (
  { h, t }: Setup,
  clock: ReturnType<typeof fakeClock>,
  options: PublishOptions = {},
  confirm: (question: string) => Promise<boolean> = async () => {
    throw new Error("no debía preguntar");
  },
) =>
  runPublish(
    { ...h.io, client: h.client, sleep: clock.sleep, now: clock.now, confirm },
    t.listingId,
    options,
  );

/** Hace de worker: termina cada publicación en curso con `published` (y su enlace) o `failed`. */
async function finish(
  t: Setup["t"],
  outcome: (publication: Publication) => "published" | "failed" = () => "published",
) {
  for (const publication of t.publications.all()) {
    if (publication.status !== "publishing") continue;
    if (outcome(publication) === "published") {
      await t.publications.transition(
        publication.id,
        {
          from: "publishing",
          to: "published",
          changes: {
            publishedAt: new Date(),
            externalId: `ig-${publication.format}`,
            externalUrl: `https://www.instagram.com/p/${publication.format}/`,
          },
        },
        { actor: "system" },
      );
    } else {
      await t.publications.transition(
        publication.id,
        {
          from: "publishing",
          to: "failed",
          changes: {
            lastError: {
              code: "IG_MEDIA_REJECTED",
              message: "Instagram rechazó una imagen",
              retriable: false,
            },
          },
        },
        { actor: "system" },
      );
    }
  }
}

describe("runPublish", () => {
  it("en dry-run publica el carrusel y el reel, espera y muestra los enlaces; la bitácora dice cli", async () => {
    const setup = await publicationHarness();
    const { h, t } = setup;
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 4_000) await finish(t);
    });

    const code = await run(setup, clock);

    expect(code).toBe(0);
    expect(h.out[0]).toMatch(/^Publicando .* en Instagram \(simulación\): carrusel, reel$/);
    const text = h.text();
    expect(text).toContain("carrusel de Instagram: publicada (simulación)");
    expect(text).toContain("https://www.instagram.com/p/post/");
    expect(text).toContain("https://www.instagram.com/p/reel/");
    expect(text).toContain("Simulación: no se envió nada a la plataforma");
    expect(t.queue.jobs.map((job) => job.name)).toEqual([
      "publication.publish",
      "publication.publish",
    ]);
    const events = await t.publications.listEvents(t.byFormat("post")?.id ?? "");
    expect(events.find((event) => event.toStatus === "publishing")?.actor).toBe("cli");
  });

  it("si una falla, muestra el motivo y sale con 1", async () => {
    const setup = await publicationHarness();
    const clock = fakeClock(() =>
      finish(setup.t, (publication) => (publication.format === "reel" ? "failed" : "published")),
    );

    expect(await run(setup, clock)).toBe(1);
    expect(setup.h.text()).toContain("IG_MEDIA_REJECTED: Instagram rechazó una imagen");
    expect(setup.h.errors()).toContain("Una publicación falló");
  });

  it("con la API en vivo pide confirmación: si no se confirma, no publica nada", async () => {
    const setup = await publicationHarness({ publishMode: "live" });
    const questions: string[] = [];

    const code = await run(setup, fakeClock(), {}, async (question) => {
      questions.push(question);
      return false;
    });

    expect(code).toBe(1);
    expect(questions[0]).toContain("La API está en vivo");
    expect(setup.h.errors()).toContain("No se publicó nada");
    expect(setup.t.queue.jobs).toEqual([]);
    expect(setup.t.publications.all().every((p) => p.status === "approved")).toBe(true);
  });

  it("con la API en vivo, confirmar o --yes publica en vivo", async () => {
    for (const [options, answer] of [
      [{}, true],
      [{ yes: true }, undefined],
    ] as const) {
      const setup = await publicationHarness({ publishMode: "live" });
      const clock = fakeClock(() => finish(setup.t));
      const confirm =
        answer === undefined
          ? undefined
          : async () => {
              return answer;
            };

      expect(await run(setup, clock, options, confirm)).toBe(0);
      expect(setup.h.out[0]).toContain("(en vivo)");
      expect(setup.t.publications.all().every((p) => p.dryRun === false)).toBe(true);
    }
  });

  it("avisa a los 20 s si nadie tomó las publicaciones (worker apagado)", async () => {
    const setup = await publicationHarness();
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 24_000) await finish(setup.t);
    });

    expect(await run(setup, clock)).toBe(0);
    expect(setup.h.out).toContain("Sigue en cola: ¿está corriendo el worker? (pnpm dev)");
  });

  it("no avisa de la cola si el worker ya las tocó", async () => {
    const setup = await publicationHarness({ publishMode: "live" });
    const clock = fakeClock(async (elapsed) => {
      // El publisher guarda su progreso al crear los contenedores: `updatedAt` cambia.
      if (elapsed === 2_000) {
        // Un instante real después, para que `updatedAt` no coincida al milisegundo.
        await new Promise((done) => setTimeout(done, 5));
        for (const publication of setup.t.publications.all()) {
          await setup.t.publications.saveProgress(publication.id, {
            attemptStartedAt: new Date().toISOString(),
            childIds: [],
            containerId: `c-${publication.format}`,
          });
        }
      }
      if (elapsed === 30_000) await finish(setup.t);
    });

    expect(await run(setup, clock, { yes: true })).toBe(0);
    expect(setup.h.out).not.toContain("Sigue en cola: ¿está corriendo el worker? (pnpm dev)");
  });

  it("--no-wait imprime los ids y sale sin esperar", async () => {
    const setup = await publicationHarness();
    const clock = fakeClock();

    expect(await run(setup, clock, { wait: false })).toBe(0);
    expect(clock.sleeps).toEqual([]);
    const ids = setup.t.publications.all().map((p) => p.id);
    expect(setup.h.out).toEqual(expect.arrayContaining(ids));
  });

  it("sin cola explica que quedaron en curso y que hay que arrancar el worker", async () => {
    const setup = await publicationHarness({
      queueFails: () =>
        new AppError("QUEUE_UNAVAILABLE", "La cola no está disponible", { retriable: true }),
    });

    expect(await run(setup, fakeClock())).toBe(1);
    const errors = setup.h.errors();
    expect(errors).toContain(
      "QUEUE_UNAVAILABLE: La cola no responde: las publicaciones quedaron en curso",
    );
    expect(errors).toContain("arranca el worker (pnpm dev)");
  });

  it("sin texto aprobado dice cómo aprobarlo", async () => {
    const setup = await publicationHarness({ approve: false });

    expect(await run(setup, fakeClock())).toBe(1);
    expect(setup.h.errors()).toContain("CONTENT_NOT_APPROVED");
    expect(setup.h.errors()).toContain("agentsales approve");
  });

  it("un canal desconocido es PLATFORM_INVALID sin llamar a la API", async () => {
    const setup = await publicationHarness();

    expect(await run(setup, fakeClock(), { platform: "tiktok" })).toBe(1);
    expect(setup.h.errors()).toContain("PLATFORM_INVALID");
    expect(setup.h.requests).toEqual([]);
  });

  it("deja de esperar en el tope (sigue en curso) y sale con 1", async () => {
    const setup = await publicationHarness();
    const clock = fakeClock();

    const code = await runPublish(
      {
        ...setup.h.io,
        client: setup.h.client,
        sleep: clock.sleep,
        now: clock.now,
        confirm: async () => false,
        wait: { maxWaitMs: 10_000 },
      },
      setup.t.listingId,
    );

    expect(code).toBe(1);
    expect(setup.h.text()).toContain(
      "Sigue en curso: revisa más tarde con agentsales publications",
    );
  });

  it("una falla aislada de la API se reintenta; tres seguidas dejan de esperar con 1", async () => {
    // La API cae en la consulta de los 2 s y vuelve después de `downUntil`.
    for (const [downUntil, expected] of [
      [4_000, 0],
      [8_000, 1],
    ] as const) {
      let down = false;
      const { t } = await publicationHarness();
      const h = harness({
        deps: {
          listings: t.listings,
          brokers: t.brokers,
          media: t.media,
          fieldDefinitions: t.fieldDefinitions,
          storage: t.storage,
          contents: t.contents,
          contentRuns: t.contentRuns,
          platformAccounts: t.platformAccounts,
          publications: t.publications,
          lock: t.deps.lock,
          queue: t.deps.queue,
        },
        beforeRequest: (url, method) => {
          if (method === "GET" && url.includes("/publications/") && down) {
            throw new Error("API reiniciándose");
          }
        },
      });
      const clock = fakeClock(async (elapsed) => {
        down = elapsed >= 2_000 && elapsed < downUntil;
        if (elapsed === 10_000) await finish(t);
      });

      const code = await runPublish(
        {
          ...h.io,
          client: h.client,
          sleep: clock.sleep,
          now: clock.now,
          confirm: async () => false,
        },
        t.listingId,
      );

      expect(code).toBe(expected);
      if (expected === 1) expect(h.errors()).toContain("Dejé de esperar");
    }
  });

  it("las reencoladas no disparan el aviso de cola, y se informan", async () => {
    const setup = await publicationHarness();
    const first = await run(setup, fakeClock(), { wait: false });
    expect(first).toBe(0);
    setup.h.out.length = 0;
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 30_000) await finish(setup.t);
    });

    expect(await run(setup, clock)).toBe(0);
    expect(setup.h.text()).toContain("Ya estaban en curso y se retomaron: 2");
    expect(setup.h.out).not.toContain("Sigue en cola: ¿está corriendo el worker? (pnpm dev)");
  });

  it("si alguien descarta una mientras se espera, sale con 1", async () => {
    const setup = await publicationHarness();
    const clock = fakeClock(async (elapsed) => {
      if (elapsed !== 2_000) return;
      const reel = setup.t.byFormat("reel")?.id ?? "";
      await setup.t.publications.transition(
        reel,
        {
          from: "publishing",
          to: "failed",
          changes: { lastError: { code: "X", message: "x", retriable: false } },
        },
        { actor: "system" },
      );
      await setup.t.publications.transition(
        reel,
        { from: "failed", to: "cancelled" },
        { actor: "operator" },
      );
      await finish(setup.t);
    });

    expect(await run(setup, clock)).toBe(1);
    expect(setup.h.errors()).toContain("No todas quedaron publicadas");
  });

  it("los formatos ocupados por un texto anterior y las pendientes de otra cuenta se avisan", async () => {
    const setup = await publicationHarness();
    await setup.t.platformAccounts.disconnect(setup.t.account?.id ?? "");
    await setup.t.platformAccounts.upsertConnected({
      brokerId: setup.t.account?.brokerId ?? "",
      platform: "instagram",
      externalAccountId: "17841400000000002",
      displayName: "@otra",
      tokenExpiresAt: null,
      meta: {},
      credentials: { accessToken: "IGAA-otra" },
    });

    expect(
      await run(
        setup,
        fakeClock(() => finish(setup.t)),
      ),
    ).toBe(0);
    expect(setup.h.errors()).toContain("2 pendiente(s) de una cuenta desconectada no se publican");
  });

  it("--platform portal sin texto aprobado de Portal lo explica", async () => {
    const setup = await publicationHarness();

    expect(await run(setup, fakeClock(), { platform: "portal" })).toBe(1);
    expect(setup.h.errors()).toContain("CONTENT_NOT_APPROVED");
    expect(setup.h.errors()).toContain("agentsales approve");
    expect(setup.h.errors()).toContain("--platform portal");
  });
});

describe("runPublish · Portal (F4-T20)", () => {
  /** Le quita el WhatsApp al corredor (Portal lo exige). */
  async function withoutWhatsapp(t: Setup["t"]) {
    const listing = await t.listings.get(t.listingId);
    const broker = listing === null ? null : await t.brokers.findById(listing.brokerId);
    if (broker === null) throw new Error("falta el corredor");
    const { id, logoMediaId: _logo, autoPublish: _auto, ...data } = broker;
    await t.brokers.update(id, { ...data, whatsapp: null });
  }

  it("--platform portal en simulación publica el aviso, espera y lo informa", async () => {
    const setup = await publicationHarness({ platform: "portal_inmobiliario" });
    const { h, t } = setup;
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 4_000) await finish(t);
    });

    expect(await run(setup, clock, { platform: "portal" })).toBe(0);
    expect(h.out[0]).toMatch(/^Publicando .* en Portal Inmobiliario \(simulación\): aviso$/);
    expect(h.text()).toContain("aviso de Portal Inmobiliario: publicada (simulación)");
    expect(h.text()).toContain("Simulación: no se envió nada a la plataforma");
    expect(t.publications.all().map((p) => [p.platform, p.format, p.dryRun])).toEqual([
      ["portal_inmobiliario", "post", true],
    ]);
    expect(t.queue.jobs.map((job) => job.name)).toEqual(["publication.publish"]);
  });

  it("en vivo la confirmación dice que usa un cupo; publicado, muestra el estado en Mercado Libre", async () => {
    const setup = await publicationHarness({
      platform: "portal_inmobiliario",
      publishMode: "live",
    });
    const { h, t } = setup;
    const questions: string[] = [];
    const clock = fakeClock(async (elapsed) => {
      if (elapsed !== 4_000) return;
      const publication = t.publications.all()[0];
      if (publication === undefined) throw new Error("falta la publicación");
      await t.publications.transition(
        publication.id,
        {
          from: "publishing",
          to: "published",
          changes: {
            externalId: "MLC1234567890",
            externalUrl: "https://www.portalinmobiliario.com/MLC-1234567890",
            remoteState: {
              status: "active",
              subStatus: ["picture_download_pending"],
              stopTime: "2027-04-07T12:00:00.000-03:00",
              expirationTime: null,
              checkedAt: new Date().toISOString(),
            },
          },
        },
        { actor: "system" },
      );
    });

    const code = await run(setup, clock, { platform: "portal" }, async (question) => {
      questions.push(question);
      return true;
    });

    expect(code).toBe(0);
    expect(questions[0]).toContain("de verdad en Portal Inmobiliario?");
    expect(questions[0]).toContain("Usa un cupo de tu paquete de Mercado Libre");
    const text = h.text();
    expect(text).toContain("aviso de Portal Inmobiliario: publicada (en vivo)");
    expect(text).toContain("https://www.portalinmobiliario.com/MLC-1234567890");
    expect(text).toContain("En Mercado Libre: procesando fotos · vence 2027-04-07");
  });

  it("PORTAL_NOT_READY muestra la lista de lo que falta, una sola vez, y no publica", async () => {
    const setup = await publicationHarness({ platform: "portal_inmobiliario" });
    await withoutWhatsapp(setup.t);

    expect(await run(setup, fakeClock(), { platform: "portal" })).toBe(1);
    const errors = setup.h.errors();
    expect(errors).toContain(
      "PORTAL_NOT_READY: Falta información para publicar en Portal Inmobiliario:\n  • ",
    );
    expect(errors.match(/WhatsApp/g)?.length).toBeGreaterThanOrEqual(1);
    // El `message` de la API repite los motivos: no se muestra además de la lista.
    expect(errors).not.toContain("Portal Inmobiliario: Falta");
    expect(errors.split("\n").filter((line) => line.startsWith("  • "))).toHaveLength(1);
    expect(errors).toContain("hoja Corredor");
    expect(setup.t.publications.all().map((p) => p.status)).toEqual(["approved"]);
  });

  it("sin cuenta de Mercado Libre dice cómo conectarla", async () => {
    const setup = await publicationHarness({ platform: "portal_inmobiliario", account: false });

    expect(await run(setup, fakeClock(), { platform: "portal" })).toBe(1);
    expect(setup.h.errors()).toContain("ACCOUNT_NOT_CONNECTED");
    expect(setup.h.errors()).toContain("agentsales accounts connect mercadolibre --broker <slug>");
  });
});
