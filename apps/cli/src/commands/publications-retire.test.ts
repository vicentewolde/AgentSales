import type { PublishMode } from "@agentsales/core";
import { createPostPublicationScenario } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { harness } from "../../test/harness.js";
import { runRetirePublication } from "./publications.js";

// F9-T19: `publications retire <id> --delete` borra un post de LinkedIn por la API (cuenta en modo
// `api`, API en vivo) contra la API real en proceso; LinkedIn es un doble.

const POST_URN = "urn:li:share:7380000000000000001";

async function setup(options: { publishMode?: PublishMode; mode?: "api" | "manual" } = {}) {
  const t = await createPostPublicationScenario({
    texts: [{ platform: "linkedin", language: "es" }],
    accounts: [
      { platform: "linkedin", meta: { memberId: "miembro-123", mode: options.mode ?? "api" } },
    ],
  });
  const started = await t.toPublishing(t.publicationOf("linkedin"));
  const publication = await t.publications.transition(
    started.id,
    {
      from: "publishing",
      to: "published",
      changes: {
        externalId: POST_URN,
        externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:7380000000000000001/",
      },
    },
    { actor: "system", payload: { mode: "live" } },
  );
  const removed: string[] = [];
  const h = harness({
    deps: {
      brokers: t.repos.brokers,
      posts: t.posts,
      publications: t.publications,
      platformAccounts: t.platformAccounts,
      lock: t.lock,
      postLock: t.postLock,
      publishMode: options.publishMode ?? "live",
      operationsFor: (platform) =>
        platform === "linkedin"
          ? {
              async remove(ref) {
                removed.push(ref.externalId);
              },
            }
          : undefined,
    },
  });
  const questions: string[] = [];
  const deps = (answer: boolean) => ({
    ...h.io,
    client: h.client,
    confirm: async (question: string) => {
      questions.push(question);
      return answer;
    },
  });
  return { t, h, publication, removed, questions, deps };
}

describe("publications retire --delete (F9-T19)", () => {
  it("pregunta antes de borrar; con el sí, LinkedIn la borra y queda retirada", async () => {
    const { t, h, publication, removed, questions, deps } = await setup();

    expect(await runRetirePublication(deps(false), publication.id, { delete: true })).toBe(1);
    expect(questions[0]).toContain("¿Borrar en LinkedIn");
    expect(removed).toEqual([]);

    expect(await runRetirePublication(deps(true), publication.id, { delete: true })).toBe(0);
    expect(removed).toEqual([POST_URN]);
    expect(t.current(publication.id)?.status).toBe("unpublished");
    expect(h.text()).toContain("Se borró en LinkedIn");
  });

  it("sin --delete, en LinkedIn sigue a mano y recuerda --delete al no confirmar", async () => {
    const { h, publication, removed, deps } = await setup();

    expect(await runRetirePublication(deps(false), publication.id)).toBe(1);
    expect(h.errors()).toContain("AgentSales la borra con --delete");
    expect(removed).toEqual([]);
  });

  it("con la cuenta a mano o la API en simulación, explica cómo seguir a mano", async () => {
    const manual = await setup({ mode: "manual" });
    expect(
      await runRetirePublication(manual.deps(true), manual.publication.id, {
        delete: true,
        yes: true,
      }),
    ).toBe(1);
    expect(manual.h.errors()).toContain("RETIRE_DELETE_UNSUPPORTED");
    expect(manual.h.errors()).toContain(`agentsales publications retire ${manual.publication.id}`);

    const simulated = await setup({ publishMode: "dry-run" });
    expect(
      await runRetirePublication(simulated.deps(true), simulated.publication.id, {
        delete: true,
        yes: true,
      }),
    ).toBe(1);
    expect(simulated.h.errors()).toContain("PUBLISH_MODE_MISMATCH");
    expect(simulated.removed).toEqual([]);
  });
});
