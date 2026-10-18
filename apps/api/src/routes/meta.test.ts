import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger, createSignedRequestVerifier } from "@agentsales/config";
import { ERASED_ACCOUNT_DISPLAY_NAME } from "@agentsales/core";
import {
  createInMemoryMetaDeletionRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPublicationRepository,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { createApp, mountApi } from "../app.js";
import { testDeps } from "../testing/index.js";

// F8-T17 (spec F8 §4.11, D18): las vueltas de Meta, con firmas hechas aquí (sin llamar a Meta).

const IG_SECRET = "clave-de-la-app-de-instagram";
const FB_SECRET = "clave-de-la-app-de-meta";
const IG_USER = "17841400000000001";
const PUBLIC = "https://agentsales.test";

function signedRequest(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${signature}.${body}`;
}
const signedFor = (userId: string, secret = IG_SECRET) =>
  signedRequest({ algorithm: "HMAC-SHA256", issued_at: 1_791_990_000, user_id: userId }, secret);

async function setup() {
  const platformAccounts = createInMemoryPlatformAccountRepository();
  const publications = createInMemoryPublicationRepository();
  const account = await platformAccounts.upsertConnected({
    brokerId: "broker-1",
    platform: "instagram",
    externalAccountId: IG_USER,
    displayName: "@corredora",
    tokenExpiresAt: null,
    meta: { accountType: "BUSINESS" },
    credentials: { accessToken: "IGAA-secreto" },
  });
  const created = await publications.create(
    {
      listingId: "listing-1",
      platformAccountId: account.id,
      platform: "instagram",
      format: "post",
      contentId: "content-1",
      mediaIds: [],
      listingSourceHash: "hash",
    },
    { actor: "operator" },
  );
  await publications.transition(
    created.id,
    { from: "approved", to: "publishing", changes: { incrementAttempts: true, dryRun: false } },
    { actor: "system" },
  );
  const publication = await publications.transition(
    created.id,
    {
      from: "publishing",
      to: "published",
      changes: {
        externalId: "17900000000000001",
        externalUrl: "https://www.instagram.com/p/abc/",
        publishedAt: new Date(),
      },
    },
    { actor: "system" },
  );
  const lines: string[] = [];
  const logger = createLogger(
    { level: "debug" },
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    }),
  );
  // Montada bajo `/api` y sin sesión: como llega Meta (sin cookie ni `Origin`).
  const api = mountApi(
    createApp(
      testDeps({
        platformAccounts,
        verifyMetaSignature: createSignedRequestVerifier([IG_SECRET, FB_SECRET]),
        metaDeletion: createInMemoryMetaDeletionRepository({ platformAccounts, publications }),
        access: { allowedHosts: ["agentsales.test"], allowedOrigins: [PUBLIC] },
        panelUrl: PUBLIC,
        logger,
      }),
    ),
  );
  const post = (path: string, body: string, type = "application/x-www-form-urlencoded") =>
    api.request(`${PUBLIC}/api/meta/${path}`, {
      method: "POST",
      headers: { "content-type": type },
      body,
    });
  const form = (signed: string) => new URLSearchParams({ signed_request: signed }).toString();
  return { api, post, form, platformAccounts, publications, account, publication, lines };
}

describe("POST /api/meta/deauthorize", () => {
  it("con la firma buena desconecta la cuenta de ese usuario, sin sesión ni Origin", async () => {
    const t = await setup();
    const response = await t.post("deauthorize", t.form(signedFor(IG_USER)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(await t.platformAccounts.get(t.account.id)).toMatchObject({
      status: "revoked",
      hasCredentials: false,
    });
    // Quitar la app no borra las publicaciones.
    expect(await t.publications.get(t.publication.id)).toMatchObject({
      externalId: "17900000000000001",
    });
  });

  it("también acepta la firma con la clave de la app de Meta", async () => {
    const t = await setup();
    const response = await t.post("deauthorize", t.form(signedFor(IG_USER, FB_SECRET)));
    expect(response.status).toBe(200);
    expect((await t.platformAccounts.get(t.account.id))?.status).toBe("revoked");
  });

  it("una firma mala, de otra app, sin signed_request o en JSON: 400 sin tocar nada", async () => {
    const t = await setup();
    const tries = [
      t.post("deauthorize", t.form(signedFor(IG_USER, "clave-de-otra-app"))),
      t.post("deauthorize", t.form("no.es-una-firma")),
      t.post("deauthorize", "otro=1"),
      t.post(
        "deauthorize",
        JSON.stringify({ signed_request: signedFor(IG_USER) }),
        "application/json",
      ),
    ];
    for (const response of await Promise.all(tries)) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "META_SIGNATURE_INVALID" } });
    }
    expect(await t.platformAccounts.get(t.account.id)).toMatchObject({
      status: "connected",
      hasCredentials: true,
    });
  });

  it("un cuerpo enorme sin largo declarado (por partes) también se corta (413)", async () => {
    const t = await setup();
    const chunk = new TextEncoder().encode(`signed_request=${"x".repeat(10_000)}`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await t.api.request(`${PUBLIC}/api/meta/deauthorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
  });

  it("un cuerpo enorme se rechaza antes de leerlo (413)", async () => {
    const t = await setup();
    const response = await t.post("deauthorize", `signed_request=${"x".repeat(20_000)}`);
    expect(response.status).toBe(413);
  });
});

describe("POST /api/meta/data-deletion", () => {
  it("borra los datos y responde la URL del pedido y su código, sin el user_id en los logs", async () => {
    const t = await setup();
    const response = await t.post("data-deletion", t.form(signedFor(IG_USER)));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.url).toBe(`${PUBLIC}/api/meta/data-deletion/${body.confirmation_code}`);

    const account = await t.platformAccounts.get(t.account.id);
    expect(account).toMatchObject({
      status: "revoked",
      hasCredentials: false,
      displayName: ERASED_ACCOUNT_DISPLAY_NAME,
      meta: {},
    });
    expect(account?.externalAccountId).not.toBe(IG_USER);
    expect(await t.publications.get(t.publication.id)).toMatchObject({
      status: "published",
      externalId: null,
      externalUrl: null,
    });
    expect((await t.publications.listEvents(t.publication.id)).at(-1)).toMatchObject({
      type: "data_deleted",
      payload: { confirmationCode: body.confirmation_code },
    });
    expect(t.lines.join("\n")).not.toContain(IG_USER);
  });

  it("un user_id desconocido responde un código sin borrar nada", async () => {
    const t = await setup();
    const response = await t.post("data-deletion", t.form(signedFor("17841499999999999")));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { confirmation_code: string };
    expect(body.confirmation_code).not.toBe("");
    expect(await t.platformAccounts.get(t.account.id)).toMatchObject({ status: "connected" });
    // Ninguna cuenta calzó: queda como aviso en el log (sin el user_id), para notarlo en T21.
    const warning = t.lines.map((line) => JSON.parse(line)).find((entry) => entry.level === 40);
    expect(warning).toMatchObject({ accounts: 0 });
    expect(t.lines.join("\n")).not.toContain("17841499999999999");

    const page = await t.api.request(`${PUBLIC}/api/meta/data-deletion/${body.confirmation_code}`);
    expect(await page.text()).toContain("No teníamos datos guardados de esa cuenta");
  });

  it("una firma inválida responde 400 sin borrar ni anotar nada", async () => {
    const t = await setup();
    const response = await t.post("data-deletion", t.form(signedFor(IG_USER, "otra")));

    expect(response.status).toBe(400);
    expect(await t.platformAccounts.get(t.account.id)).toMatchObject({
      status: "connected",
      externalAccountId: IG_USER,
    });
  });
});

describe("GET /api/meta/data-deletion/:code", () => {
  it("la página del código muestra el pedido completado, sin JavaScript y sin caché", async () => {
    const t = await setup();
    const deletion = await t.post("data-deletion", t.form(signedFor(IG_USER)));
    const { confirmation_code: code } = (await deletion.json()) as { confirmation_code: string };

    const page = await t.api.request(`${PUBLIC}/api/meta/data-deletion/${code}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain(code);
    expect(html).toContain("Completado");
    expect(html).toContain("Borramos la conexión con tu cuenta de Instagram");
    expect(html).not.toMatch(/<script|style=/i);
    expect(html).toContain('href="/legal/legal.css"');
  });

  it("un código que no existe o sin forma da 404 en HTML, sin repetir lo que no es seguro", async () => {
    const t = await setup();
    const missing = await t.api.request(`${PUBLIC}/api/meta/data-deletion/no-existe`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Pedido no encontrado");

    const odd = await t.api.request(
      `${PUBLIC}/api/meta/data-deletion/${encodeURIComponent("<b>hola</b>")}`,
    );
    expect(odd.status).toBe(404);
    const html = await odd.text();
    expect(html).not.toContain("<b>hola</b>");
    expect(html).toContain("&lt;b&gt;hola&lt;/b&gt;");
  });
});
