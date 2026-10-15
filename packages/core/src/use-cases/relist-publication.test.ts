import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import type { Publication } from "../publication.js";
import { createPublicationScenario } from "../testing/index.js";
import { publishListing } from "./publish-listing.js";
import { relistPublication } from "./relist-publication.js";

// F6-T07 (spec F6 §4.7, ADR-0020): republicar un aviso de Portal cerrado o vencido.

const PORTAL = "portal_inmobiliario";

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return isAppError(error) ? error.code : "otro";
  }
  return null;
};

/** Una publicación de Portal publicada y después cerrada (en vivo, o simulada). */
async function closed(options: { dryRun?: boolean; remoteClosed?: boolean } = {}) {
  const t = await createPublicationScenario({ platform: PORTAL });
  const dryRun = options.dryRun ?? true;
  const [started] = (
    await publishListing(t.deps, {
      listingId: t.listingId,
      platform: PORTAL,
      dryRun,
      actor: "operator",
    })
  ).started;
  if (started === undefined) throw new Error("falta la publicación");
  await t.publications.transition(
    started.id,
    {
      from: "publishing",
      to: "published",
      changes: { externalId: dryRun ? `dry-run:${started.id}` : "MLC1234567890" },
    },
    { actor: "system" },
  );
  await t.publications.transition(
    started.id,
    {
      from: "published",
      to: "unpublished",
      ...(options.remoteClosed
        ? {
            changes: {
              remoteState: {
                status: "closed",
                subStatus: ["expired"],
                stopTime: null,
                expirationTime: null,
                checkedAt: new Date().toISOString(),
              },
            },
          }
        : {}),
    },
    { actor: "system" },
  );
  t.queue.jobs.length = 0;
  return { t, previous: started };
}

describe("relistPublication", () => {
  it("en simulación crea una publicación nueva que recuerda la anterior, la pasa a publishing y la encola", async () => {
    const { t, previous } = await closed();

    const relisted = await relistPublication(t.deps, {
      publicationId: previous.id,
      dryRun: true,
      actor: "operator",
    });

    expect(relisted).toMatchObject({
      status: "publishing",
      relistedFrom: previous.id,
      dryRun: true,
      platform: PORTAL,
    });
    expect(relisted.id).not.toBe(previous.id);
    expect(t.queue.jobs).toEqual([
      {
        name: "publication.publish",
        data: { publicationId: relisted.id },
        options: { singletonKey: relisted.id },
      },
    ]);
    expect((await t.publications.get(previous.id))?.status).toBe("unpublished");
  });

  it("no se republica dos veces la misma, ni con otra publicación de Portal activa", async () => {
    const { t, previous } = await closed();
    await relistPublication(t.deps, {
      publicationId: previous.id,
      dryRun: true,
      actor: "operator",
    });

    expect(
      await codeOf(
        relistPublication(t.deps, { publicationId: previous.id, dryRun: true, actor: "operator" }),
      ),
    ).toBe("RELIST_NOT_ALLOWED");
  });

  it("los modos no se cruzan", async () => {
    const simulated = await closed({ dryRun: true });
    expect(
      await codeOf(
        relistPublication(simulated.t.deps, {
          publicationId: simulated.previous.id,
          dryRun: false,
          actor: "operator",
          confirmed: true,
        }),
      ),
    ).toBe("RELIST_NOT_ALLOWED");

    const live = await closed({ dryRun: false, remoteClosed: true });
    expect(
      await codeOf(
        relistPublication(live.t.deps, {
          publicationId: live.previous.id,
          dryRun: true,
          actor: "operator",
        }),
      ),
    ).toBe("PUBLISH_MODE_MISMATCH");
  });

  it("en vivo exige que Mercado Libre la haya cerrado y la confirmación", async () => {
    const open = await closed({ dryRun: false, remoteClosed: false });
    expect(
      await codeOf(
        relistPublication(open.t.deps, {
          publicationId: open.previous.id,
          dryRun: false,
          actor: "operator",
          confirmed: true,
        }),
      ),
    ).toBe("RELIST_NOT_ALLOWED");

    const live = await closed({ dryRun: false, remoteClosed: true });
    expect(
      await codeOf(
        relistPublication(live.t.deps, {
          publicationId: live.previous.id,
          dryRun: false,
          actor: "operator",
        }),
      ),
    ).toBe("RELIST_NOT_CONFIRMED");
    const relisted = await relistPublication(live.t.deps, {
      publicationId: live.previous.id,
      dryRun: false,
      actor: "operator",
      confirmed: true,
    });
    expect(relisted).toMatchObject({ relistedFrom: live.previous.id, dryRun: false });
  });

  it("solo una de Portal cerrada; una que no existe es PUBLICATION_NOT_FOUND", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    expect(
      await codeOf(
        relistPublication(t.deps, { publicationId: post.id, dryRun: true, actor: "operator" }),
      ),
    ).toBe("RELIST_NOT_ALLOWED");
    expect(
      await codeOf(
        relistPublication(t.deps, { publicationId: "no-existe", dryRun: true, actor: "operator" }),
      ),
    ).toBe("PUBLICATION_NOT_FOUND");
  });
});
