import { describe, expect, it } from "vitest";
import { issueLeadWebhookSecret, verifyLeadWebhookSecret } from "./lead-webhook.js";
import { fakeHash } from "./testing/fake-hash.js";
import { createInMemoryLeadWebhookKeyRepository } from "./testing/leads.js";

const setup = () => {
  let n = 0;
  return {
    keys: createInMemoryLeadWebhookKeyRepository(),
    randomSecret: () => `secreto-${++n}`,
    hash: (s: string) => fakeHash(s),
    safeEqual: (a: string, b: string) => a === b,
  };
};

describe("secreto del webhook de leads", () => {
  it("guarda solo el hash y el secreto vigente sirve", async () => {
    const deps = setup();
    const { secret } = await issueLeadWebhookSecret(deps, "B1");
    expect(await deps.keys.getHash("B1")).not.toBe(secret);
    expect(await verifyLeadWebhookSecret(deps, "B1", secret)).toBe(true);
  });

  it("rechaza un secreto equivocado, vacío, ausente o de otro corredor", async () => {
    const deps = setup();
    const { secret } = await issueLeadWebhookSecret(deps, "B1");
    expect(await verifyLeadWebhookSecret(deps, "B1", "otro")).toBe(false);
    expect(await verifyLeadWebhookSecret(deps, "B1", "")).toBe(false);
    expect(await verifyLeadWebhookSecret(deps, "B1", undefined)).toBe(false);
    expect(await verifyLeadWebhookSecret(deps, "B2", secret)).toBe(false);
  });

  it("al rotar, el secreto anterior deja de servir", async () => {
    const deps = setup();
    const first = await issueLeadWebhookSecret(deps, "B1");
    const second = await issueLeadWebhookSecret(deps, "B1");
    expect(await verifyLeadWebhookSecret(deps, "B1", first.secret)).toBe(false);
    expect(await verifyLeadWebhookSecret(deps, "B1", second.secret)).toBe(true);
  });
});
