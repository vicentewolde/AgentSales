import { describe, expect, it } from "vitest";
import { ALL_SCOPE } from "../access.js";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPublicationRepository,
} from "../testing/index.js";
import { connectManualInstagramAccount } from "./connect-instagram-manual-account.js";

function setup(kind: "brand" | "broker" = "brand") {
  const broker = contentBrokerFixture({ kind, slug: "marca-de-prueba" });
  const brokers = createInMemoryBrokerRepository([broker]);
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const publications = createInMemoryPublicationRepository();
  const deps = { brokers, platformAccounts, publications };
  return { broker, platformAccounts, publications, deps };
}

const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error as { code: string }).code,
  );

/** Una cuenta de Instagram por la API, con su token, ya conectada. */
const apiAccount = (
  brokerId: string,
  platformAccounts: ReturnType<typeof setup>["platformAccounts"],
) =>
  platformAccounts.upsertConnected(
    {
      brokerId,
      platform: "instagram",
      externalAccountId: "1789",
      displayName: "@vicentewoldec",
      tokenExpiresAt: null,
      meta: {},
      credentials: { accessToken: "token-de-prueba" },
    },
    { revokeOthers: true },
  );

describe("connectManualInstagramAccount (ADR-0041)", () => {
  it("crea la cuenta a mano de una marca, sin credenciales y con el usuario limpio", async () => {
    const { platformAccounts, deps } = setup();

    const account = await connectManualInstagramAccount(deps, {
      broker: "marca-de-prueba",
      handle: "  @AgentPey.CL ",
    });

    expect(account).toMatchObject({
      platform: "instagram",
      externalAccountId: "manual:agentpey.cl",
      displayName: "@agentpey.cl",
      status: "connected",
      hasCredentials: false,
      tokenExpiresAt: null,
      meta: { mode: "manual", handle: "agentpey.cl" },
    });
    expect(await platformAccounts.list(ALL_SCOPE)).toHaveLength(1);
  });

  it("activarla otra vez con el mismo usuario actualiza la misma cuenta", async () => {
    const { platformAccounts, deps } = setup();
    const first = await connectManualInstagramAccount(deps, {
      broker: "marca-de-prueba",
      handle: "agentpey",
    });
    const again = await connectManualInstagramAccount(deps, {
      broker: "marca-de-prueba",
      handle: "@agentpey",
    });

    expect(again.id).toBe(first.id);
    expect(await platformAccounts.list(ALL_SCOPE)).toHaveLength(1);
  });

  it("un corredor de propiedades no puede: ACCOUNT_MODE_NOT_SUPPORTED, sin crear nada", async () => {
    const { platformAccounts, deps } = setup("broker");

    expect(
      await codeOf(
        connectManualInstagramAccount(deps, { broker: "marca-de-prueba", handle: "agentpey" }),
      ),
    ).toBe("ACCOUNT_MODE_NOT_SUPPORTED");
    expect(await platformAccounts.list(ALL_SCOPE)).toEqual([]);
  });

  it("un corredor que no existe es BROKER_NOT_FOUND y un usuario inválido, INSTAGRAM_HANDLE_INVALID", async () => {
    const { deps } = setup();

    expect(
      await codeOf(connectManualInstagramAccount(deps, { broker: "nadie", handle: "agentpey" })),
    ).toBe("BROKER_NOT_FOUND");
    for (const handle of ["", "@", "con espacio", "a/b", "x".repeat(31), "ñandú"]) {
      expect(
        await codeOf(connectManualInstagramAccount(deps, { broker: "marca-de-prueba", handle })),
      ).toBe("INSTAGRAM_HANDLE_INVALID");
    }
  });

  it("la cuenta por la API que se reemplaza queda desconectada si no tiene nada pendiente", async () => {
    const { broker, platformAccounts, deps } = setup();
    const old = await apiAccount(broker.id, platformAccounts);

    const manual = await connectManualInstagramAccount(deps, {
      broker: "marca-de-prueba",
      handle: "agentpey",
    });

    expect((await platformAccounts.get(old.id))?.status).toBe("revoked");
    expect((await platformAccounts.get(manual.id))?.status).toBe("connected");
  });

  it("con publicaciones por salir en la cuenta que se reemplaza: ACCOUNT_HAS_PENDING_PUBLICATIONS", async () => {
    const { broker, platformAccounts, publications, deps } = setup();
    const old = await apiAccount(broker.id, platformAccounts);
    const pending = await publications.create(
      {
        postId: "post-1",
        platformAccountId: old.id,
        platform: "instagram",
        format: "post",
        contentId: "texto-1",
        mediaIds: [],
      },
      { actor: "operator" },
    );

    const error = await connectManualInstagramAccount(deps, {
      broker: "marca-de-prueba",
      handle: "agentpey",
    }).catch((caught: unknown) => caught as { code: string; details?: { publicationId?: string } });

    expect(error).toMatchObject({
      code: "ACCOUNT_HAS_PENDING_PUBLICATIONS",
      details: { publicationId: pending.id },
    });
    expect((await platformAccounts.get(old.id))?.status).toBe("connected");
    expect(await platformAccounts.list(ALL_SCOPE)).toHaveLength(1);
  });
});
