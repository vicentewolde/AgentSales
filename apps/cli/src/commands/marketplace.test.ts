import {
  confirmManualPublication,
  type PublishMode,
  publishPublication,
  startPublication,
  type UfValueSource,
} from "@agentsales/core";
import { createFakePublisher } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { brokerData, fakeClock, harness, publicationHarness } from "../../test/harness.js";
import { type AccountsDeps, runAccounts, runConnect, runDisconnect } from "./accounts.js";
import { runApprove } from "./approve.js";
import {
  runCancelPublication,
  runConfirmPublication,
  runNotPublished,
  runPublications,
} from "./publications.js";
import { type PublishOptions, runPublish } from "./publish.js";

// F5-T11: la CLI de Marketplace (spec F5 §4.12), sobre la API real en proceso y sin Facebook.

const MARKETPLACE = "fb_marketplace";
/** El enlace que pega el operador, con datos de rastreo en la consulta (inventado). */
const PASTED_URL = "https://www.facebook.com/marketplace/item/123456789/?ref=share&tracking=abc123";
const CLEAN_URL = "https://www.facebook.com/marketplace/item/123456789/";

/** La UF de los tests (inventada): ayer y hoy, en cualquier fecha que se pida. */
const ufSource: UfValueSource = {
  async valuesBetween(from, to) {
    return [
      { date: from, value: "41126.12" },
      { date: to, value: "41130.94" },
    ];
  },
};

type Setup = Awaited<ReturnType<typeof publicationHarness>>;

async function marketplaceSetup(
  options: { publishMode?: PublishMode; ufConfigured?: boolean; approve?: boolean } = {},
) {
  const mode = options.publishMode ?? "live";
  const setup = await publicationHarness({
    platform: MARKETPLACE,
    publishMode: mode,
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    marketplace: { dailyLimit: 3, ufConfigured: options.ufConfigured ?? true },
  });
  const { t } = setup;
  const fake = createFakePublisher({
    platform: MARKETPLACE,
    formats: ["post"],
    manualConfirm: true,
  });
  /** Hace de worker: el intento de cada una en curso deja el formulario listo. */
  const attempt = async () => {
    for (const publication of t.publications.all()) {
      if (publication.status !== "publishing") continue;
      await publishPublication(
        {
          publications: t.publications,
          platformAccounts: t.platformAccounts,
          contents: t.contents,
          media: t.media,
          listings: t.listings,
          brokers: t.brokers,
          storage: t.storage,
          publishers: { fb_marketplace: fake },
          workerMode: mode,
          mercadoLibre: null,
          marketplaceDailyLimit: 3,
          uf: ufSource,
        },
        { publicationId: publication.id, isLastAttempt: false },
      );
    }
  };
  const only = () => {
    const [publication] = t.publications.all();
    if (publication === undefined) throw new Error("falta la publicación");
    return publication;
  };
  /** Deja la publicación esperando el clic final, como después de publicar. */
  const awaiting = async () => {
    await startPublication(
      { ...t.deps, marketplace: { dailyLimit: 3, ufConfigured: true } },
      { publicationId: only().id, dryRun: mode !== "live", actor: "operator" },
    );
    await attempt();
    const current = only();
    expect(current.status).toBe("awaiting_manual_confirm");
    return current;
  };
  return { ...setup, attempt, awaiting, only };
}

const publishDeps = (
  { h }: Setup,
  clock: ReturnType<typeof fakeClock>,
  confirm: (question: string) => Promise<boolean> = async () => true,
) => ({ ...h.io, client: h.client, sleep: clock.sleep, now: clock.now, confirm });

const publish = (setup: Setup, clock: ReturnType<typeof fakeClock>, options: PublishOptions = {}) =>
  runPublish(publishDeps(setup, clock), setup.t.listingId, { platform: "marketplace", ...options });

describe("publish --platform marketplace", () => {
  it("en vivo: espera el formulario listo, dice qué hacer y después el enlace que vio la ventana", async () => {
    const s = await marketplaceSetup();
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 2_000) await s.attempt();
      if (elapsed === 6_000) {
        await confirmManualPublication(
          { lock: s.t.deps.lock, publications: s.t.publications },
          { publicationId: s.only().id, url: PASTED_URL, actor: "system" },
        );
      }
    });
    const questions: string[] = [];

    const code = await runPublish(
      publishDeps(s, clock, async (question) => {
        questions.push(question);
        return true;
      }),
      s.t.listingId,
      { platform: "marketplace" },
    );

    expect(code).toBe(0);
    expect(questions[0]).toContain("Siguiente y Publicar");
    const text = s.h.text();
    expect(text).toContain("en Facebook Marketplace (en vivo): aviso");
    expect(text).toContain(
      "✓ Formulario listo: revisa la ventana de Chromium, haz clic en Siguiente y Publicar",
    );
    expect(text).toMatch(
      /Precio en el formulario: \$[\d.]+ \(UF del \d{4}-\d{2}-\d{2}: \$41\.130,94\)/,
    );
    expect(text).toContain("aviso de Facebook Marketplace: publicada (en vivo)");
    expect(text).toContain(CLEAN_URL);
    expect(text).not.toContain("tracking");
  });

  it("en vivo: si la ventana se cierra sin ver el aviso, pregunta y muestra los dos comandos", async () => {
    const s = await marketplaceSetup();
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 2_000) await s.attempt();
      if (elapsed === 6_000) {
        const publication = s.only();
        const progress = publication.progress as Record<string, unknown>;
        await s.t.publications.updateProgress(
          publication.id,
          { from: "awaiting_manual_confirm", attempts: publication.attempts },
          { ...progress, windowClosedAt: new Date().toISOString() },
        );
      }
    });

    expect(await publish(s, clock)).toBe(0);

    const id = s.only().id;
    const text = s.h.text();
    expect(text).toContain("La ventana se cerró sin que viera el aviso publicado: ¿lo publicaste?");
    expect(text).toContain(`pbpaste | pnpm -s cli publications confirm ${id} --url-stdin`);
    expect(text).toContain(`pnpm -s cli publications not-published ${id}`);
  });

  it("en vivo: si nada llega antes del tope, deja de esperar y muestra los comandos", async () => {
    const s = await marketplaceSetup();
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 2_000) await s.attempt();
    });
    const code = await runPublish(
      { ...publishDeps(s, clock), wait: { maxWaitMs: 10_000 } },
      s.t.listingId,
      { platform: "marketplace" },
    );
    expect(code).toBe(0);
    expect(s.h.text()).toContain("No vi el enlace del aviso: ¿lo publicaste?");
    expect(s.h.text()).toContain(`publications not-published ${s.only().id}`);
  });

  it("en simulación: no abre Facebook, muestra el precio y los comandos sin esperar el enlace", async () => {
    const s = await marketplaceSetup({ publishMode: "dry-run" });
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 2_000) await s.attempt();
    });

    expect(await publish(s, clock)).toBe(0);

    const text = s.h.text();
    expect(text).toContain("simulación: formulario listo sin abrir Facebook");
    expect(text).toContain("Precio en el formulario:");
    expect(text).toContain(`publications confirm ${s.only().id} --url-stdin`);
    expect(text).toContain("Simulación: no se abrió Facebook");
    expect(clock.sleeps).toHaveLength(1);
  });

  it("--no-wait imprime el id y sale", async () => {
    const s = await marketplaceSetup();
    expect(await publish(s, fakeClock(), { wait: false })).toBe(0);
    expect(s.h.out).toContain(s.only().id);
    expect(s.only().status).toBe("publishing");
  });

  it("al aviso le falta algo: MARKETPLACE_NOT_READY con la lista, sin publicar", async () => {
    const s = await marketplaceSetup({ ufConfigured: false });
    expect(await publish(s, fakeClock())).toBe(1);
    const errors = s.h.errors();
    expect(errors).toContain(
      "✗ MARKETPLACE_NOT_READY: Falta información para publicar en Facebook Marketplace:",
    );
    expect(errors).toContain("falta BCCH_API_TOKEN");
    expect(s.only().status).toBe("approved");
  });

  it("volver a publicar mientras espera el clic: MANUAL_CONFIRM_PENDING con los dos comandos", async () => {
    const s = await marketplaceSetup();
    const waiting = await s.awaiting();
    expect(await publish(s, fakeClock())).toBe(1);
    const errors = s.h.errors();
    expect(errors).toContain("✗ MANUAL_CONFIRM_PENDING");
    expect(errors).toContain(`publications confirm ${waiting.id} --url-stdin`);
    expect(errors).toContain(`publications not-published ${waiting.id}`);
  });
});

describe("publications confirm y not-published", () => {
  const confirmDeps = (s: Setup, stdin: string | null) => ({
    ...s.h.io,
    client: s.h.client,
    confirm: async () => false,
    stdinIsTty: () => stdin === null,
    readStdin: async () => stdin ?? "",
  });

  it("confirm --url-stdin: publicada con el enlace limpio, sin imprimir el enlace pegado", async () => {
    const s = await marketplaceSetup();
    const waiting = await s.awaiting();

    expect(
      await runConfirmPublication(confirmDeps(s, `${PASTED_URL}\n`), waiting.id, {
        urlStdin: true,
      }),
    ).toBe(0);

    expect(s.only()).toMatchObject({ status: "published", externalUrl: CLEAN_URL });
    const all = `${s.h.text()}\n${s.h.errors()}`;
    expect(all).toContain("aviso de Facebook Marketplace publicada (en vivo)");
    expect(all).not.toContain("123456789");
    expect(all).not.toContain("tracking");
    const events = await s.t.publications.listEvents(waiting.id);
    expect(events.find((event) => event.toStatus === "published")?.actor).toBe("cli");
  });

  it("confirm: desde la terminal, vacío, con espacios o sin enlace en vivo, explica sin repetir lo pegado", async () => {
    const s = await marketplaceSetup();
    const waiting = await s.awaiting();
    const cases: Array<[string | null, boolean, string]> = [
      [null, true, "URL_STDIN_REQUIRED"],
      ["  ", true, "URL_MISSING"],
      ["https://x.test/a secreto", true, "URL_INVALID"],
      ["https://www.facebook.com/profile.php?id=1&secreto=1", true, "MARKETPLACE_URL_INVALID"],
      [null, false, "MARKETPLACE_URL_REQUIRED"],
    ];
    for (const [stdin, urlStdin, code] of cases) {
      const before = s.h.err.length;
      expect(await runConfirmPublication(confirmDeps(s, stdin), waiting.id, { urlStdin })).toBe(1);
      const errors = s.h.err.slice(before).join("\n");
      expect(errors, code).toContain(`✗ ${code}`);
      expect(errors).not.toContain("secreto");
    }
    expect(s.h.errors()).toContain(
      `pbpaste | pnpm -s cli publications confirm ${waiting.id} --url-stdin`,
    );
    expect(s.only().status).toBe("awaiting_manual_confirm");
  });

  it("not-published: queda fallida y sugiere reintentar o descartar; dos veces, INVALID_TRANSITION", async () => {
    const s = await marketplaceSetup();
    const waiting = await s.awaiting();
    const deps = { ...s.h.io, client: s.h.client, confirm: async () => false };

    expect(await runNotPublished(deps, waiting.id)).toBe(0);
    expect(s.only()).toMatchObject({
      status: "failed",
      lastError: { code: "MARKETPLACE_NOT_PUBLISHED" },
    });
    expect(s.h.text()).toContain("anotado que no se publicó");
    expect(s.h.errors()).toContain("--platform marketplace");

    expect(await runNotPublished(deps, waiting.id)).toBe(1);
    expect(s.h.errors()).toContain("✗ INVALID_TRANSITION");
  });

  it("descartar mientras espera: MANUAL_CONFIRM_PENDING con los dos comandos", async () => {
    const s = await marketplaceSetup();
    const waiting = await s.awaiting();
    const deps = { ...s.h.io, client: s.h.client, confirm: async () => false };

    expect(await runCancelPublication(deps, waiting.id)).toBe(1);

    const errors = s.h.errors();
    expect(errors).toContain("✗ MANUAL_CONFIRM_PENDING");
    expect(errors).toContain(
      `pbpaste | pnpm -s cli publications confirm ${waiting.id} --url-stdin`,
    );
    expect(errors).toContain(`pnpm -s cli publications not-published ${waiting.id}`);
    expect(s.only().status).toBe("awaiting_manual_confirm");
  });

  it("publications muestra el estado, el precio en pesos con la UF usada y los comandos", async () => {
    const s = await marketplaceSetup();
    const waiting = await s.awaiting();
    const deps = { ...s.h.io, client: s.h.client, confirm: async () => false };

    expect(await runPublications(deps, s.t.listingId)).toBe(0);

    const text = s.h.text();
    expect(text).toContain("formulario listo: revisa la ventana de Chromium y publica");
    expect(text).toMatch(
      /Precio en el formulario: \$[\d.]+ \(UF del \d{4}-\d{2}-\d{2}: \$41\.130,94\)/,
    );
    expect(text).toContain(`publications confirm ${waiting.id} --url-stdin`);
  });
});

describe("approve --platform marketplace", () => {
  it("aprueba y advierte lo que le falta al aviso para Marketplace", async () => {
    const s = await marketplaceSetup({ approve: false, ufConfigured: false });
    const code = await runApprove({ ...s.h.io, client: s.h.client }, s.t.listingId, {
      platform: "marketplace",
    });
    expect(code).toBe(0);
    expect(s.h.text()).toContain("✓ Facebook Marketplace: aprobado");
    expect(s.h.errors()).toContain("Para publicar en Marketplace falta:");
    expect(s.h.errors()).toContain("BCCH_API_TOKEN");
  });
});

// ---------------------------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------------------------

async function accountsSetup() {
  const h = harness();
  const broker = await h.brokers.create(brokerData("marca"));
  const questions: string[] = [];
  let answer = false;
  const deps = (clock = fakeClock()): AccountsDeps => ({
    ...h.io,
    client: h.client,
    stdinIsTty: () => true,
    readStdin: async () => "",
    openUrl: () => {},
    now: () => new Date(),
    confirm: async (question) => {
      questions.push(question);
      return answer;
    },
    sleep: clock.sleep,
    clock: clock.now,
  });
  const connected = (meta: Record<string, unknown> = {}) =>
    h.platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform: MARKETPLACE,
      externalAccountId: "100012345678901",
      displayName: "Facebook de prueba",
      tokenExpiresAt: null,
      meta: {
        userId: "100012345678901",
        connectedAt: "2026-10-09T12:00:00.000Z",
        sessionCheckedAt: "2026-10-09T12:00:00.000Z",
        ...meta,
      },
      credentials: null,
    });
  return {
    h,
    broker,
    deps,
    questions,
    connected,
    answer: (value: boolean) => {
      answer = value;
    },
  };
}

describe("accounts connect marketplace", () => {
  it("encola el inicio de sesión y espera hasta ver la sesión", async () => {
    const s = await accountsSetup();
    const clock = fakeClock(async (elapsed) => {
      // El worker ve la sesión y conecta la cuenta (como `connectMarketplaceAccount`).
      if (elapsed === 6_000) await s.connected({ sessionCheckedAt: new Date().toISOString() });
    });

    const code = await runConnect(s.deps(clock), "marketplace", {
      broker: "marca",
      label: "Facebook de Ana",
    });

    expect(code).toBe(0);
    expect(s.h.queue.jobs).toEqual([
      expect.objectContaining({
        name: "marketplace.profile",
        data: expect.objectContaining({
          brokerId: s.broker.id,
          action: "login",
          label: "Facebook de Ana",
        }),
      }),
    ]);
    const text = s.h.text();
    expect(text).toContain("inicia sesión ahí a mano");
    expect(text).toContain("✓ Conectada Facebook de prueba (marca)");
  });

  it("si el inicio de sesión falla, muestra el motivo y cómo reintentar (sale con 1)", async () => {
    const s = await accountsSetup();
    const account = await s.connected();
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 4_000) {
        await s.h.platformAccounts.mergeMeta(account.id, {
          lastLoginError: { code: "MARKETPLACE_LOGIN_TIMEOUT", at: new Date().toISOString() },
        });
      }
    });

    expect(await runConnect(s.deps(clock), "marketplace", { broker: "marca" })).toBe(1);

    expect(s.h.errors()).toContain(
      "✗ Pasaron 10 minutos sin que se iniciara la sesión en Facebook",
    );
    expect(s.h.errors()).toContain("pnpm -s cli accounts connect marketplace --broker marca");
  });

  it("una sesión vieja no cuenta: sin respuesta, deja de esperar al tope", async () => {
    const s = await accountsSetup();
    await s.connected();
    const deps = { ...s.deps(), wait: { maxWaitMs: 10_000 } };
    expect(await runConnect(deps, "marketplace", { broker: "marca" })).toBe(1);
    expect(s.h.text()).toContain("Sigue en curso");
    expect(s.h.errors()).toContain("el worker esté corriendo");
  });

  it("opciones de otro canal: --label fuera de Marketplace, --url-stdin en Marketplace", async () => {
    const s = await accountsSetup();
    expect(await runConnect(s.deps(), "instagram", { broker: "marca", label: "x" })).toBe(1);
    expect(await runConnect(s.deps(), "marketplace", { broker: "marca", urlStdin: true })).toBe(1);
    expect(s.h.errors().match(/OPTION_NOT_FOR_PLATFORM/g)).toHaveLength(2);
    expect(s.h.queue.jobs).toEqual([]);
  });
});

describe("accounts y accounts disconnect · Marketplace", () => {
  it("la lista muestra la sesión vista y el último inicio de sesión que falló", async () => {
    const s = await accountsSetup();
    await s.connected({
      lastLoginError: { code: "MARKETPLACE_PROFILE_BUSY", at: "2026-10-10T12:00:00.000Z" },
    });
    expect(await runAccounts(s.deps())).toBe(0);
    const text = s.h.text();
    expect(text).toContain("Facebook Marketplace");
    expect(text).toContain("Facebook de prueba: el inicio de sesión del");
    expect(text).toContain("El perfil de Facebook estaba ocupado");
  });

  it("pide confirmación: sin ella no desconecta; con ella, borra el perfil y la desconecta", async () => {
    const s = await accountsSetup();
    const account = await s.connected();

    expect(await runDisconnect(s.deps(), account.id)).toBe(1);
    expect(s.questions[0]).toContain("Se borra el perfil de Chromium");
    expect((await s.h.platformAccounts.get(account.id))?.status).toBe("connected");
    expect(s.h.queue.jobs).toEqual([]);

    s.answer(true);
    expect(await runDisconnect(s.deps(), account.id)).toBe(0);
    expect((await s.h.platformAccounts.get(account.id))?.status).toBe("revoked");
    expect(s.h.queue.jobs).toEqual([
      expect.objectContaining({
        name: "marketplace.profile",
        data: { brokerId: s.broker.id, action: "forget" },
      }),
    ]);
    expect(s.h.text()).toContain("✓ Desconectada Facebook de prueba");
  });

  it("--yes no pregunta; un id que no existe se explica", async () => {
    const s = await accountsSetup();
    const account = await s.connected();
    expect(await runDisconnect(s.deps(), account.id, { yes: true })).toBe(0);
    expect(s.questions).toEqual([]);
    expect(await runDisconnect(s.deps(), "00000000-0000-4000-8000-000000000000")).toBe(1);
    expect(s.h.errors()).toContain("ACCOUNT_NOT_FOUND");
  });

  it("con una publicación esperando el clic final: MANUAL_CONFIRM_PENDING con los dos comandos", async () => {
    const s = await marketplaceSetup();
    const waiting = await s.awaiting();
    const [account] = await s.t.platformAccounts.list();
    const deps: AccountsDeps = {
      ...s.h.io,
      client: s.h.client,
      stdinIsTty: () => true,
      readStdin: async () => "",
      openUrl: () => {},
      now: () => new Date(),
      confirm: async () => true,
      sleep: async () => {},
      clock: () => 0,
    };

    expect(await runDisconnect(deps, account?.id ?? "")).toBe(1);

    const errors = s.h.errors();
    expect(errors).toContain("✗ MANUAL_CONFIRM_PENDING");
    expect(errors).toContain(`publications confirm ${waiting.id} --url-stdin`);
    expect((await s.t.platformAccounts.get(account?.id ?? ""))?.status).toBe("connected");
  });
});
