import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicationHarness } from "../../test/harness.js";
import { runCancelPublication, runPublications, runRetirePublication } from "./publications.js";

type Setup = Awaited<ReturnType<typeof publicationHarness>>;

const deps = (
  { h }: Setup,
  confirm: (question: string) => Promise<boolean> = async () => {
    throw new Error("no debía preguntar");
  },
) => ({ ...h.io, client: h.client, confirm });

/** Lleva una publicación a `published`, como lo haría el worker (en vivo o en simulación). */
async function published(t: Setup["t"], format: "post" | "reel", live: boolean) {
  const id = t.byFormat(format)?.id ?? "";
  await t.publications.transition(
    id,
    { from: "approved", to: "publishing", changes: { dryRun: !live, incrementAttempts: true } },
    { actor: "system" },
  );
  await t.publications.transition(
    id,
    {
      from: "publishing",
      to: "published",
      changes: {
        publishedAt: new Date(),
        externalId: "1789",
        externalUrl: `https://www.instagram.com/p/${format}/`,
      },
    },
    { actor: "system" },
  );
  return id;
}

describe("runPublications", () => {
  it("lista las publicaciones de una propiedad con estado, formato, modo y enlace", async () => {
    const setup = await publicationHarness();
    await published(setup.t, "post", true);

    expect(await runPublications(deps(setup), setup.t.listingId)).toBe(0);
    const text = setup.h.text();
    expect(text).toContain("ESTADO");
    expect(text).toMatch(
      /carrusel\s+publicada\s+en vivo\s+1\s+https:\/\/www\.instagram\.com\/p\/post\//,
    );
    expect(text).toMatch(/reel\s+aprobada\s+simulación\s+0/);
  });

  it("--events muestra la bitácora con el actor y lo enviado en cada intento", async () => {
    const setup = await publicationHarness();
    const id = await published(setup.t, "post", false);
    await setup.t.publications.addEvent(id, {
      type: "publish_attempt",
      actor: "system",
      payload: {
        mode: "dry-run",
        attempt: 1,
        retry: 0,
        result: "published",
        sent: {
          platform: "instagram",
          format: "post",
          title: null,
          caption: "Depto en Ñuñoa",
          media: [],
          account: { id: "a", displayName: "@muestra" },
        },
      },
    });

    expect(await runPublications(deps(setup), setup.t.listingId, { events: true })).toBe(0);
    const text = setup.h.text();
    expect(text).toContain(`Bitácora de ${id} (carrusel de Instagram)`);
    expect(text).toContain("nace → aprobada");
    expect(text).toContain("sistema  aprobada → publicando");
    expect(text).toContain("intento 1 en simulación: publicada");
    expect(text).toContain("enviado: 0 medios · caption de 14 caracteres · @muestra");
  });

  it("sin propiedad lista las de todas las propiedades que tienen", async () => {
    const setup = await publicationHarness();

    const listing = await setup.t.listings.get(setup.t.listingId);
    const broker = await setup.t.brokers.findById(listing?.brokerId ?? "");

    expect(await runPublications(deps(setup), undefined)).toBe(0);
    expect(setup.h.out).toContain(`${listing?.externalRef} (${broker?.slug})`);
    expect(setup.h.text()).toContain("carrusel");
  });

  it("una propiedad sin publicaciones lo dice", async () => {
    const setup = await publicationHarness({ approve: false });

    expect(await runPublications(deps(setup), setup.t.listingId)).toBe(0);
    expect(setup.h.text()).toContain("no tiene publicaciones");
  });
});

describe("runCancelPublication", () => {
  it("descarta una aprobada; una ya descartada se explica", async () => {
    const setup = await publicationHarness();
    const id = setup.t.byFormat("reel")?.id ?? "";

    expect(await runCancelPublication(deps(setup), id)).toBe(0);
    expect(setup.h.text()).toContain("✓ reel de Instagram descartada");
    expect(await runCancelPublication(deps(setup), id)).toBe(1);
    expect(setup.h.errors()).toContain("INVALID_TRANSITION");
    expect(setup.h.errors()).toContain("se descarta (publications cancel)");
  });

  it("un id que no es uuid se rechaza sin llamar a la API; uno que no existe es 404", async () => {
    const setup = await publicationHarness();

    expect(await runCancelPublication(deps(setup), "P-001")).toBe(1);
    expect(setup.h.errors()).toContain("PUBLICATION_ID_INVALID");
    expect(setup.h.requests).toEqual([]);
    expect(await runCancelPublication(deps(setup), randomUUID())).toBe(1);
    expect(setup.h.errors()).toContain("PUBLICATION_NOT_FOUND");
  });
});

describe("runRetirePublication", () => {
  it("en simulación la retira sin preguntar", async () => {
    const setup = await publicationHarness();
    const id = await published(setup.t, "post", false);

    expect(await runRetirePublication(deps(setup), id)).toBe(0);
    expect(setup.h.text()).toContain("✓ carrusel de Instagram retirada");
    expect(setup.t.byFormat("post")?.status).toBe("unpublished");
  });

  it("en vivo pregunta si se borró a mano: sin confirmar no cambia nada", async () => {
    const setup = await publicationHarness();
    const id = await published(setup.t, "post", true);
    const questions: string[] = [];

    const code = await runRetirePublication(
      deps(setup, async (question) => {
        questions.push(question);
        return false;
      }),
      id,
    );

    expect(code).toBe(1);
    expect(questions[0]).toContain("¿Ya borraste a mano en Instagram");
    expect(questions[0]).toContain("https://www.instagram.com/p/post/");
    expect(setup.t.byFormat("post")?.status).toBe("published");
  });

  it("en vivo, con la confirmación (o --yes) la marca retirada y la propiedad vuelve a lista", async () => {
    for (const [confirm, options] of [
      [async () => true, {}],
      [undefined, { yes: true }],
    ] as const) {
      const setup = await publicationHarness();
      const id = await published(setup.t, "post", true);
      await setup.t.listings.changeStatus(setup.t.listingId, "ready", "active");

      expect(await runRetirePublication(deps(setup, confirm), id, options)).toBe(0);
      expect(setup.t.byFormat("post")?.status).toBe("unpublished");
      expect(setup.h.text()).toContain("la propiedad volvió a lista");
      const events = await setup.t.publications.listEvents(id);
      expect(events.at(-1)).toMatchObject({
        toStatus: "unpublished",
        actor: "cli",
        payload: { removedByHand: true },
      });
    }
  });
});
