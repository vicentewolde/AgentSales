import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_SCOPE,
  type ContentRunError,
  formatChileTime,
  type Language,
  type Platform,
  type PublicationStatus,
} from "@agentsales/core";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, fakeClock, harness, memoryPutFile, PORT } from "../../test/harness.js";
import { localServerUrl } from "../server.js";
import { createMemorySessionStore } from "../session.js";
import type { PutFile } from "../upload.js";
import { runAgenda } from "./agenda.js";
import {
  type PostDeps,
  publicationNextSteps,
  register,
  runPostApprove,
  runPostArchive,
  runPostCreate,
  runPostDraft,
  runPostEdit,
  runPostList,
  runPostPublish,
  runPostSchedule,
  runPostShow,
  runPostUpload,
  withoutSignedUrls,
} from "./post.js";
import { adviceText } from "./publication-view.js";
import {
  runCancelPublication,
  runConfirmPublication,
  runNotPublished,
  runResolvePublication,
  runRetryPublication,
} from "./publications.js";

// F9-T12 (spec F9 §4.10): `agentsales post …` y `publications resolve|retry|confirm` contra la API
// real en proceso, con R2 y el worker de mentira (nada llama a una red ni a la IA).

const BROKER_TOKEN = "token-del-corredor-post";
const inHours = (hours: number) => formatChileTime(new Date(Date.now() + hours * 3_600_000));
const noQuestions = async () => {
  throw new Error("no debía preguntar");
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Text = { platform: Platform; language: Language; body?: string };

async function setup(options: { live?: boolean } = {}) {
  const h = harness(options.live ? { deps: { publishMode: "live" } } : {});
  const brand = await h.brokers.create(brokerData("agentpey"), { kind: "brand" });
  // En vivo, la marca está encendida y es propia (las dos llaves, ADR-0036).
  if (options.live) {
    await h.brokers.setSettings(brand.id, { operatorOwned: true });
    await h.brokers.setLiveEnabled(brand.id, true);
  }
  const other = await h.brokers.create(brokerData("ajena"), { kind: "brand" });
  await h.platformAccounts.upsertConnected({
    brokerId: brand.id,
    platform: "discord",
    externalAccountId: "canal-1",
    displayName: "#anuncios",
    tokenExpiresAt: null,
    meta: {},
    credentials: { webhookUrl: "https://discord.com/api/webhooks/123456/token-de-prueba" },
  });
  const cwd = await mkdtemp(join(tmpdir(), "agentsales-cli-post-"));
  dirs.push(cwd);
  // El worker de los textos: en cada espera, la corrida activa termina (o falla) con lo pedido.
  let draftOutcome: { texts: Text[] } | { error: ContentRunError } = {
    texts: [{ platform: "discord", language: "es" }],
  };
  const clock = fakeClock(async () => {
    for (const post of await h.posts.list({}, ALL_SCOPE)) {
      const run = await h.contentRuns.findActive({ kind: "post", id: post.id });
      if (run === null) continue;
      await h.contentRuns.markRunning(run.id);
      if ("error" in draftOutcome) {
        await h.contentRuns.markFailed(run.id, draftOutcome.error);
        continue;
      }
      await h.contentRuns.markSucceeded(run.id, {
        report: { warnings: [] },
        contents: draftOutcome.texts.map((text) => ({
          platform: text.platform,
          language: text.language,
          title: null,
          body: text.body ?? `Texto en ${text.language} para ${text.platform}`,
          hashtags: [],
          llmProvider: "fake",
          llmModel: "fake",
          promptVersion: "social-v1",
          rawOutput: null,
        })),
      });
    }
  });
  let stdin: string | null = null;
  const asked: string[] = [];
  const deps = (
    extra: Partial<PostDeps> = {},
    answer: boolean | null = null,
  ): PostDeps & { stdinIsTty: () => boolean; readStdin: () => Promise<string> } => ({
    ...h.io,
    client: h.client,
    cwd,
    sleep: clock.sleep,
    now: clock.now,
    putFile: h.putFile,
    confirm:
      answer === null
        ? noQuestions
        : async (question: string) => {
            asked.push(question);
            return answer;
          },
    stdinIsTty: () => stdin === null,
    readStdin: async () => stdin ?? "",
    ...extra,
  });
  /** El único post de la marca (el que se acaba de crear). */
  const created = async () => {
    const [post] = await h.posts.list({ brokerId: brand.id }, ALL_SCOPE);
    if (post === undefined) throw new Error("sin post");
    return post;
  };
  /** Las publicaciones del post. */
  const publicationsOf = (postId: string) =>
    h.publications.all().filter((p) => p.subject.kind === "post" && p.subject.id === postId);
  /** Mueve una publicación por la máquina de estados, como el worker. */
  const move = (postId: string, id: string, steps: PublicationStatus[]) =>
    h.postLock.run(postId, async ({ publications }) => {
      for (const to of steps) {
        const current = await publications.get(id);
        if (current === null) throw new Error("no existe");
        await publications.transition(
          id,
          {
            from: current.status,
            to,
            ...(to === "publishing" ? { changes: { dryRun: true } } : {}),
          },
          { actor: "system" },
        );
      }
    });
  return {
    h,
    brand,
    other,
    cwd,
    clock,
    asked,
    deps,
    created,
    publicationsOf,
    move,
    setDraft: (outcome: typeof draftOutcome) => {
      draftOutcome = outcome;
    },
    setStdin: (text: string | null) => {
      stdin = text;
    },
  };
}

/** Un post creado, con su texto de Discord aprobado (la publicación nace en `approved`). */
async function approvedPost(s: Awaited<ReturnType<typeof setup>>) {
  expect(await runPostCreate(s.deps(), "Lo que aprendí esta semana", { broker: "agentpey" })).toBe(
    0,
  );
  const post = await s.created();
  expect(await runPostDraft(s.deps(), post.id)).toBe(0);
  expect(await runPostApprove(s.deps(), post.id, { platform: "discord" })).toBe(0);
  const [publication] = s.publicationsOf(post.id);
  if (publication === undefined) throw new Error("sin publicación");
  return { post, publication };
}

describe("post de punta a punta", () => {
  it("create → upload → draft → approve → schedule deja la publicación programada y la agenda la muestra", async () => {
    const s = await setup();
    await writeFile(join(s.cwd, "foto.jpg"), "foto de prueba");
    await writeFile(join(s.cwd, "clip.mp4"), "video de prueba");

    expect(
      await runPostCreate(s.deps(), "Lo que aprendí esta semana", {
        broker: "agentpey",
        brief: "Tres cosas que aprendí",
        kind: "image",
        date: "2026-11-02 10:00",
      }),
    ).toBe(0);
    const post = await s.created();
    expect(post).toMatchObject({ status: "draft", kind: "image", brief: "Tres cosas que aprendí" });
    expect(formatChileTime(post.plannedAt ?? new Date(0))).toBe("2026-11-02 10:00");
    expect(s.h.text()).toContain(`Post ${post.id} creado en agentpey`);

    expect(await runPostUpload(s.deps(), post.id, ["foto.jpg", "clip.mp4"])).toBe(0);
    expect(s.h.text()).toContain("2 archivo(s) subidos: el post tiene 2 medio(s)");
    expect(s.h.errors()).toContain("Subiendo 2 archivo(s)");
    expect(s.h.queue.jobs.map((job) => job.name)).toContain("post.media");
    // Las URLs firmadas nunca se imprimen.
    expect([s.h.text(), s.h.errors()].join("\n")).not.toContain("r2.test");
    // El worker (`post.media`) arma las variantes de la foto; el video sigue procesándose.
    for (const original of await s.h.media.listOriginals({ kind: "post", id: post.id })) {
      if (original.kind !== "image") continue;
      await s.h.media.upsertDerivative({
        role: "processed",
        variant: "ig_4x5",
        parentMediaId: original.id,
        postId: post.id,
        brokerId: s.brand.id,
        kind: "image",
        storagePath: `posts/${post.id}/ig_4x5/${original.id}.jpg`,
        mime: "image/jpeg",
        bytes: 8,
        checksum: `sha-${original.id}`,
        width: 1080,
        height: 1350,
        durationS: null,
      });
    }

    expect(await runPostDraft(s.deps(), post.id)).toBe(0);
    expect(s.h.text()).toContain("Discord · español: borrador");
    expect(s.h.queue.jobs.map((job) => job.name)).toContain("post.draft");

    expect(await runPostApprove(s.deps(), post.id, { platform: "discord" })).toBe(0);
    expect(s.h.text()).toContain(
      "Discord · español: aprobado · listas para publicar o programar: 1",
    );

    const at = inHours(3);
    expect(await runPostSchedule(s.deps(), post.id, { at })).toBe(0);
    expect(s.h.text()).toContain(`Discord [es]: programada para ${at} (simulación)`);
    const [publication] = s.publicationsOf(post.id);
    expect(publication).toMatchObject({ status: "scheduled", dryRun: true });

    s.h.out.length = 0;
    expect(await runAgenda(s.deps())).toBe(0);
    const agenda = s.h.text();
    expect(agenda).toContain("Próximas (7 días) (1)");
    expect(agenda).toContain("Lo que aprendí esta semana (post)");
    expect(agenda).toContain(`→ agentsales post show ${post.id}`);
    expect(agenda).toContain(`→ agentsales unschedule ${publication?.id}`);

    s.h.out.length = 0;
    expect(await runPostShow(s.deps(), post.id)).toBe(0);
    const shown = s.h.text();
    expect(shown).toContain("Lo que aprendí esta semana");
    expect(shown).toContain("listo · imagen · agentpey");
    expect(shown).toContain("Medios (2)");
    expect(shown).toContain("variantes: ig_4x5");
    expect(shown).toContain("procesando…");
    expect(shown).toContain("Brief (tuyo):");
    expect(shown).toContain("Discord · español");
    expect(shown).toContain("✓ sin problemas");
    expect(shown).toContain("Publicaciones (1)");
    expect(shown).toContain("programada");

    // `--json` no imprime las URLs prefirmadas de R2 de los medios.
    s.h.out.length = 0;
    expect(await runPostShow(s.deps(), post.id, { json: true })).toBe(0);
    const json = s.h.text();
    expect(json).not.toContain("r2.test");
    const parsed = JSON.parse(json) as { media: Record<string, unknown>[] };
    expect(parsed.media).toHaveLength(2);
    for (const item of parsed.media) {
      expect(item).not.toHaveProperty("url");
      expect(item).not.toHaveProperty("thumbUrl");
      expect(item).not.toHaveProperty("downloadUrl");
      expect(item).toHaveProperty("variants");
    }

    s.h.out.length = 0;
    expect(await runPostList(s.deps(), { status: "ready" })).toBe(0);
    expect(s.h.text()).toContain(post.id);
    expect(s.h.text()).toContain("2026-11-02 10:00");
  });

  it("upload reintenta un archivo que falló y vuelve a subir lo que R2 no tiene hasta completar", async () => {
    const s = await setup();
    await writeFile(join(s.cwd, "foto.jpg"), "foto de prueba");
    await runPostCreate(s.deps(), "Con foto", { broker: "agentpey", kind: "image" });
    const post = await s.created();
    // El primer PUT se corta (se reintenta solo); el segundo "llega" pero R2 no lo guarda: complete
    // dice que falta, y la CLI lo vuelve a subir.
    let calls = 0;
    const flaky: PutFile = async (request) => {
      calls += 1;
      if (calls === 1) throw new Error("se cortó la conexión");
      if (calls === 2) return;
      await memoryPutFile(s.h.storage)(request);
    };
    expect(await runPostUpload(s.deps({ putFile: flaky }), post.id, ["foto.jpg"])).toBe(0);
    expect(calls).toBe(3);
    expect(s.h.errors()).toContain("Faltan 1 archivo(s) en R2: los subo de nuevo");
    expect(s.h.text()).toContain("el post tiene 1 medio(s)");

    // Subir el mismo archivo otra vez no sube nada.
    s.h.out.length = 0;
    expect(await runPostUpload(s.deps(), post.id, ["foto.jpg"])).toBe(0);
    expect(s.h.text()).toContain("foto.jpg: el post ya lo tiene");
    expect(s.h.text()).toContain("Nada nuevo que subir");
  });

  it("approve sin cuenta en ninguna red aprobada: lo que sigue es conectarla, no publicar (ensayo de la demo de F9)", async () => {
    const s = await setup();
    s.setDraft({ texts: [{ platform: "linkedin", language: "es" }] });
    await runPostCreate(s.deps(), "Bastidores", { broker: "agentpey" });
    const post = await s.created();
    expect(await runPostDraft(s.deps(), post.id)).toBe(0);
    s.h.out.length = 0;
    expect(await runPostApprove(s.deps(), post.id, {})).toBe(0);
    const text = s.h.text();
    expect(text).toContain("LinkedIn · español: aprobado");
    expect(text).toContain("sin cuenta conectada en esa red");
    expect(text).toContain("→ Conecta la cuenta de LinkedIn (agentsales accounts)");
    expect(text).not.toContain("→ Publica con");
    expect(s.publicationsOf(post.id)).toEqual([]);

    // Con una red con cuenta (Discord) entre las aprobadas, sí se sugiere publicar.
    s.setDraft({
      texts: [
        { platform: "linkedin", language: "es" },
        { platform: "discord", language: "es" },
      ],
    });
    expect(await runPostDraft(s.deps(), post.id, { replaceEdits: true })).toBe(0);
    s.h.out.length = 0;
    expect(await runPostApprove(s.deps(), post.id, {})).toBe(0);
    expect(s.h.text()).toContain(`→ Publica con agentsales post publish ${post.id}`);
    expect(s.h.text()).not.toContain("→ Conecta la cuenta");
  });

  it("approve de un post de imágenes sin imágenes: aprueba y dice que faltan los medios, no la cuenta (F9.5-T21)", async () => {
    const s = await setup();
    s.setDraft({ texts: [{ platform: "discord", language: "es" }] });
    await runPostCreate(s.deps(), "Bastidores", { broker: "agentpey", kind: "image" });
    const post = await s.created();
    expect(await runPostDraft(s.deps(), post.id)).toBe(0);
    s.h.out.length = 0;
    expect(await runPostApprove(s.deps(), post.id, {})).toBe(0);
    const text = s.h.text();
    expect(text).toContain("Discord · español: aprobado");
    expect(text).toContain("los medios faltan o se están procesando");
    expect(text).toContain(`agentsales post upload ${post.id}`);
    expect(text).toContain("→ Sube los medios con");
    expect(text).not.toContain("sin cuenta conectada");
    expect(text).not.toContain("→ Conecta la cuenta");
    expect(text).not.toContain("→ Publica con");
    expect(s.publicationsOf(post.id)).toEqual([]);

    // Publicar todavía no se puede: faltan los medios.
    expect(await runPostPublish(s.deps(), post.id, { platform: "discord" })).toBe(1);
    expect(s.h.errors()).toContain("Falta la imagen del post");
    expect(s.publicationsOf(post.id)).toEqual([]);
  });

  it("approve con la foto subida pero sin procesar: dice que se está procesando, no que falta la cuenta (F9.5-T21)", async () => {
    const s = await setup();
    await writeFile(join(s.cwd, "foto.jpg"), "foto de prueba");
    s.setDraft({ texts: [{ platform: "discord", language: "es" }] });
    await runPostCreate(s.deps(), "Bastidores", { broker: "agentpey", kind: "image" });
    const post = await s.created();
    // Subida, pero el worker (`post.media`) todavía no arma sus variantes: la revisión no avisa
    // nada (el original está), y aun así no se pueden abrir publicaciones.
    expect(await runPostUpload(s.deps(), post.id, ["foto.jpg"])).toBe(0);
    expect(await runPostDraft(s.deps(), post.id)).toBe(0);
    s.h.out.length = 0;
    expect(await runPostApprove(s.deps(), post.id, {})).toBe(0);
    const text = s.h.text();
    expect(text).toContain("Discord · español: aprobado");
    expect(text).toContain("los medios faltan o se están procesando");
    expect(text).not.toContain("sin cuenta conectada");
    expect(text).not.toContain("→ Conecta la cuenta");
    expect(s.publicationsOf(post.id)).toEqual([]);
  });

  it("edit toma el texto de la entrada estándar y lo deja editado; publish lo envía en simulación", async () => {
    const s = await setup();
    await runPostCreate(s.deps(), "Bastidores", { broker: "agentpey" });
    const post = await s.created();
    await runPostDraft(s.deps(), post.id);
    s.setStdin("Lo que aprendí construyendo, en corto\n");
    expect(await runPostEdit(s.deps(), post.id, { platform: "discord" })).toBe(0);
    expect(s.h.text()).toContain("Discord · español editado");
    expect(s.h.text()).toContain("Lo que aprendí construyendo, en corto");
    s.setStdin(null);

    expect(await runPostApprove(s.deps(), post.id, {})).toBe(0);
    // El worker de las publicaciones: en cada espera, la que está publicándose sale.
    const [publication] = s.publicationsOf(post.id);
    const id = publication?.id ?? "";
    const publishing = fakeClock(async () => {
      if (s.publicationsOf(post.id).some((p) => p.status === "publishing")) {
        await s.move(post.id, id, ["published"]);
      }
    });
    expect(
      await runPostPublish(s.deps({ sleep: publishing.sleep, now: publishing.now }), post.id),
    ).toBe(0);
    expect(s.h.text()).toContain("Publicando en Discord: 1 publicación(es)");
    expect(s.h.text()).toContain("publicada");
    expect(s.h.text()).toContain("Simulación: no se envió nada a las redes");
  });
});

describe("publications resolve, retry, confirm y not-published con posts", () => {
  it("resolve en los dos sentidos: no salió → retry → salió (con el enlace por la entrada estándar)", async () => {
    const s = await setup();
    const { post, publication } = await approvedPost(s);
    await s.move(post.id, publication.id, ["publishing", "outcome_unknown"]);

    s.h.out.length = 0;
    expect(await runAgenda(s.deps())).toBe(0);
    expect(s.h.text()).toContain(
      `→ agentsales publications resolve ${publication.id} --not-published`,
    );

    expect(await runResolvePublication(s.deps(), publication.id, { notPublished: true })).toBe(0);
    expect(s.h.text()).toContain("anotado que no salió");
    expect(s.h.errors()).toContain(`agentsales publications retry ${publication.id}`);
    expect(s.publicationsOf(post.id)[0]?.status).toBe("failed");

    expect(await runRetryPublication(s.deps(), publication.id)).toBe(0);
    expect(s.publicationsOf(post.id)[0]?.status).toBe("publishing");
    expect(s.h.errors()).toContain(`agentsales post show ${post.id}`);

    await s.move(post.id, publication.id, ["outcome_unknown"]);
    s.setStdin("https://discord.com/channels/1/2/3\n");
    expect(
      await runResolvePublication(s.deps(), publication.id, { published: true, urlStdin: true }),
    ).toBe(0);
    expect(s.publicationsOf(post.id)[0]?.status).toBe("published");
    expect(s.h.text()).toContain("Simulación: el enlace no se guarda");
    // El enlace pegado no se imprime.
    expect(s.h.text()).not.toContain("discord.com/channels");
  });

  it("resolve sin decir si salió, o con las dos, se explica sin llamar a la API", async () => {
    const s = await setup();
    const { publication } = await approvedPost(s);
    expect(await runResolvePublication(s.deps(), publication.id, {})).toBe(1);
    expect(
      await runResolvePublication(s.deps(), publication.id, {
        published: true,
        notPublished: true,
      }),
    ).toBe(1);
    expect(s.h.errors()).toContain("RESOLVE_OUTCOME_REQUIRED");
    // Sobre una que no está en duda, la API lo rechaza con qué hacer.
    expect(await runResolvePublication(s.deps(), publication.id, { published: true })).toBe(1);
    expect(s.h.errors()).toContain("INVALID_TRANSITION");
  });

  it("retry de una con resultado dudoso dice cómo resolverla; en vivo pregunta antes", async () => {
    const s = await setup();
    const { post, publication } = await approvedPost(s);
    await s.move(post.id, publication.id, ["publishing", "outcome_unknown"]);
    expect(await runRetryPublication(s.deps(), publication.id)).toBe(1);
    expect(s.h.errors()).toContain("OUTCOME_UNKNOWN_PENDING");
    expect(s.h.errors()).toContain(
      `agentsales publications resolve ${publication.id} --published|--not-published`,
    );
  });

  it("confirm y not-published sirven para un post a mano, con el reintento de posts", async () => {
    const s = await setup();
    const { post, publication } = await approvedPost(s);
    await s.move(post.id, publication.id, ["publishing", "awaiting_manual_confirm"]);
    expect(await runNotPublished(s.deps(), publication.id)).toBe(0);
    expect(s.h.errors()).toContain(`agentsales publications retry ${publication.id}`);

    await runRetryPublication(s.deps(), publication.id);
    await s.move(post.id, publication.id, ["awaiting_manual_confirm"]);
    expect(await runConfirmPublication(s.deps(), publication.id)).toBe(0);
    expect(s.publicationsOf(post.id)[0]?.status).toBe("published");
  });

  it("confirm --no-url: con --url-stdin a la vez no vale, y en una red que no es LinkedIn tampoco (F9.5)", async () => {
    const s = await setup();
    const { post, publication } = await approvedPost(s);
    await s.move(post.id, publication.id, ["publishing", "awaiting_manual_confirm"]);
    s.setStdin("https://www.linkedin.com/feed/update/urn:li:share:1/");
    expect(
      await runConfirmPublication(s.deps(), publication.id, { urlStdin: true, url: false }),
    ).toBe(1);
    expect(s.h.errors()).toContain("CONFIRM_OPTIONS_CONFLICT");
    expect(s.h.errors()).not.toContain("urn:li:share");
    expect(s.publicationsOf(post.id)[0]?.status).toBe("awaiting_manual_confirm");

    // Discord no se confirma sin enlace (solo LinkedIn): la API lo rechaza y no cambia nada.
    s.setStdin(null);
    expect(await runConfirmPublication(s.deps(), publication.id, { url: false })).toBe(1);
    expect(s.h.errors()).toContain("PUBLISHED_URL_REQUIRED");
    expect(s.publicationsOf(post.id)[0]?.status).toBe("awaiting_manual_confirm");
  });

  it("la agenda sugiere retry para una fallida de un post", async () => {
    const s = await setup();
    const { post, publication } = await approvedPost(s);
    await s.move(post.id, publication.id, ["publishing", "failed"]);
    s.h.out.length = 0;
    expect(await runAgenda(s.deps())).toBe(0);
    expect(s.h.text()).toContain(`→ agentsales post show ${post.id}`);
    expect(s.h.text()).toContain(`→ agentsales publications retry ${publication.id}`);
  });
});

describe("post show --json sin URLs firmadas (F9.5)", () => {
  it("quita las URLs de los medios del post y de los que lleva cada publicación", () => {
    const detail = {
      media: [
        { id: "m1", url: "https://r2.test/o.jpg?firma", thumbUrl: "https://r2.test/t.jpg?firma" },
      ],
      publications: [
        {
          id: "pub-1",
          media: [
            { id: "p1", variant: "ig_4x5", mime: "image/jpeg", url: "https://r2.test/p.jpg?firma" },
          ],
        },
      ],
    } as unknown as Parameters<typeof withoutSignedUrls>[0];
    const text = JSON.stringify(withoutSignedUrls(detail));
    expect(text).not.toContain("r2.test");
    expect(text).toContain('"p1"');
  });
});

describe("el consejo del error en los posts (F9-T19)", () => {
  const failed = {
    id: "pub-1",
    status: "failed" as const,
    errorAdvice: "Recarga créditos en la consola de X y reintenta.",
  };

  it("post show lo pone antes de reintentar o descartar", () => {
    expect(publicationNextSteps(failed as Parameters<typeof publicationNextSteps>[0])).toEqual([
      "Qué hacer: Recarga créditos en la consola de X y reintenta.",
      "Reintenta: agentsales publications retry pub-1",
      "O descártala: agentsales publications cancel pub-1",
    ]);
  });

  it("publications y publish lo muestran solo en una fallida", () => {
    expect(adviceText(failed)).toBe("Qué hacer: Recarga créditos en la consola de X y reintenta.");
    expect(adviceText({ ...failed, errorAdvice: null })).toBeNull();
    expect(adviceText({ ...failed, status: "published" })).toBeNull();
  });
});

describe("ajustes de la revisión", () => {
  it("edit con solo --hashtags y la entrada estándar vacía (sin TTY) cambia solo los hashtags", async () => {
    const s = await setup();
    await runPostCreate(s.deps(), "Hashtags", { broker: "agentpey" });
    const post = await s.created();
    await runPostDraft(s.deps(), post.id);
    s.setStdin("");
    expect(
      await runPostEdit(s.deps(), post.id, { platform: "discord", hashtags: "#agentpey ia" }),
    ).toBe(0);
    const [content] = await s.h.contents.listCurrent({ kind: "post", id: post.id });
    expect(content).toMatchObject({
      status: "edited",
      body: "Texto en es para discord",
      hashtags: ["#agentpey", "#ia"],
    });
  });

  it("upload se rinde con POST_UPLOAD_INCOMPLETE si R2 sigue sin el archivo tras 3 vueltas", async () => {
    const s = await setup();
    await writeFile(join(s.cwd, "foto.jpg"), "foto de prueba");
    await runPostCreate(s.deps(), "Sin llegar", { broker: "agentpey", kind: "image" });
    const post = await s.created();
    let calls = 0;
    // El PUT "termina bien", pero el archivo nunca llega a R2.
    const lost: PutFile = async () => {
      calls += 1;
    };
    expect(await runPostUpload(s.deps({ putFile: lost }), post.id, ["foto.jpg"])).toBe(1);
    expect(calls).toBe(3);
    expect(s.h.errors()).toContain("POST_UPLOAD_INCOMPLETE");
    expect(s.h.errors()).toContain("foto.jpg");
    expect(s.h.errors()).toContain(`agentsales post upload ${post.id}`);
  });

  it("publish dice por qué un idioma no se publicó (skipped: una activa de un texto anterior)", async () => {
    const s = await setup();
    const { post, publication } = await approvedPost(s);
    await s.move(post.id, publication.id, ["publishing", "published"]);
    // Textos nuevos en dos idiomas: el español choca con la publicada del texto anterior.
    s.setDraft({
      texts: [
        { platform: "discord", language: "es" },
        { platform: "discord", language: "en" },
      ],
    });
    expect(await runPostDraft(s.deps(), post.id, { replaceEdits: true })).toBe(0);
    await runPostApprove(s.deps(), post.id, {});
    const publishing = fakeClock(async () => {
      for (const p of s.publicationsOf(post.id)) {
        if (p.status === "publishing") await s.move(post.id, p.id, ["published"]);
      }
    });
    expect(
      await runPostPublish(s.deps({ sleep: publishing.sleep, now: publishing.now }), post.id, {
        platform: "discord",
      }),
    ).toBe(0);
    expect(s.h.text()).toContain("Publicando en Discord: 1 publicación(es)");
    expect(s.h.errors()).toContain(
      `ya hay una publicación activa de un texto anterior (${publication.id})`,
    );
  });
});

describe("errores con su consejo y permisos", () => {
  it("una corrida que falla muestra el código y qué hacer (POST_NO_PLATFORMS, LLM_OUTPUT_INVALID)", async () => {
    const s = await setup();
    await runPostCreate(s.deps(), "Sin redes", { broker: "agentpey" });
    const post = await s.created();
    s.setDraft({
      error: { code: "POST_NO_PLATFORMS", message: "La marca no tiene redes para este post" },
    });
    expect(await runPostDraft(s.deps(), post.id)).toBe(1);
    expect(s.h.text()).toContain("POST_NO_PLATFORMS");
    expect(s.h.text()).toContain("agentsales brand edit");

    s.setDraft({ error: { code: "LLM_OUTPUT_INVALID", message: "La IA no entregó los textos" } });
    expect(await runPostDraft(s.deps(), post.id)).toBe(1);
    expect(s.h.text()).toContain(`vuelve a pedirlos con agentsales post draft ${post.id}`);
  });

  it("pedir textos editados sin --replace-edits, o de un post archivado, se explica", async () => {
    const s = await setup();
    await runPostCreate(s.deps(), "Editado", { broker: "agentpey" });
    const post = await s.created();
    await runPostDraft(s.deps(), post.id);
    s.setStdin("Mi versión");
    await runPostEdit(s.deps(), post.id, { platform: "discord", language: "es" });
    s.setStdin(null);
    expect(await runPostDraft(s.deps(), post.id)).toBe(1);
    expect(s.h.errors()).toContain("CONTENT_EDITED");
    expect(s.h.errors()).toContain("--replace-edits");

    expect(await runPostArchive(s.deps(), post.id)).toBe(0);
    expect(await runPostDraft(s.deps(), post.id)).toBe(1);
    expect(s.h.errors()).toContain("POST_NOT_READY");
    expect(s.h.errors()).toContain("un post archivado ya no cambia");
  });

  it("publicar sin textos aprobados y una red de avisos se explican sin llamar", async () => {
    const s = await setup();
    await runPostCreate(s.deps(), "Nada aprobado", { broker: "agentpey" });
    const post = await s.created();
    expect(await runPostPublish(s.deps(), post.id)).toBe(1);
    expect(s.h.errors()).toContain("CONTENT_NOT_APPROVED");
    expect(await runPostApprove(s.deps(), post.id, { platform: "portal" })).toBe(1);
    expect(s.h.errors()).toContain("--platform debe ser instagram, x, linkedin, discord, tiktok");
  });

  it("las redes del post (F9-T21): edit las cambia y publicar sin --platform usa solo esas", async () => {
    const s = await setup();
    const { post, publication } = await approvedPost(s);
    // Quitar Discord con su publicación pendiente no se puede: primero se cancela.
    expect(await runPostEdit(s.deps(), post.id, { platforms: "x,linkedin" })).toBe(1);
    expect(s.h.errors()).toContain("POST_HAS_PENDING_PUBLICATIONS");
    expect(s.h.errors()).toContain("agentsales publications cancel <id>");
    expect((await s.h.posts.get(post.id))?.platforms).toBeNull();
    expect(await runCancelPublication(s.deps(), publication.id)).toBe(0);
    // Le quita Discord al post: el texto aprobado sigue, pero ya no se publica sin pedirlo.
    expect(await runPostEdit(s.deps(), post.id, { platforms: "x,linkedin" })).toBe(0);
    expect(s.h.text()).toContain("actualizado (redes: X, LinkedIn");
    expect((await s.h.posts.get(post.id))?.platforms).toEqual(["x", "linkedin"]);
    s.h.out.length = 0;
    expect(await runPostShow(s.deps(), post.id)).toBe(0);
    expect(s.h.text()).toContain("Redes: X, LinkedIn");
    expect(s.h.text()).toContain("Discord ya no está entre las redes del post");
    expect(s.h.text()).toContain("Falta el texto de X, LinkedIn");

    expect(await runPostPublish(s.deps(), post.id)).toBe(1);
    expect(s.h.errors()).toContain("POST_PLATFORM_EXCLUDED");
    expect(s.h.errors()).toContain("--platforms <redes>");
    // Pedida a mano, la API también la rechaza (409), sin cambiar nada.
    expect(await runPostPublish(s.deps(), post.id, { platform: "discord" })).toBe(1);
    expect(s.h.errors()).toContain("no está entre las redes del post");
    expect(s.publicationsOf(post.id)[0]).toMatchObject({ id: publication.id, status: "cancelled" });

    // Mover la fecha y volver a todas las redes.
    expect(
      await runPostEdit(s.deps(), post.id, { platforms: "todas", date: "2026-11-05 10:00" }),
    ).toBe(0);
    expect(await s.h.posts.get(post.id)).toMatchObject({
      platforms: null,
      plannedAt: new Date("2026-11-05T13:00:00Z"),
    });
    expect(await runPostEdit(s.deps(), post.id, { platforms: "portal" })).toBe(1);
    expect(await runPostEdit(s.deps(), post.id, { date: "mañana" })).toBe(1);
    expect(s.h.errors()).toContain("--date");
  });

  it("--music (F9.5-T19): elige y quita la música de los videos; una pista que no existe no llama", async () => {
    const s = await setup();
    await runPostCreate(s.deps(), "Recorrido en video", { broker: "agentpey", kind: "video" });
    const post = await s.created();
    expect(await runPostEdit(s.deps(), post.id, { music: "up-in-the-sky" })).toBe(0);
    expect(s.h.text()).toContain("música: Up in the Sky · Moderna (los videos se rehacen solos)");
    expect((await s.h.posts.get(post.id))?.musicTrackId).toBe("up-in-the-sky");
    s.h.out.length = 0;
    expect(await runPostShow(s.deps(), post.id)).toBe(0);
    expect(s.h.text()).toContain("Música de los videos: Up in the Sky · Moderna");

    expect(await runPostEdit(s.deps(), post.id, { music: "ninguna" })).toBe(0);
    expect((await s.h.posts.get(post.id))?.musicTrackId).toBeNull();

    expect(await runPostEdit(s.deps(), post.id, { music: "reggaeton" })).toBe(1);
    expect(s.h.errors()).toContain("MUSIC_TRACK_INVALID");

    // Un post que no es de video: la API lo rechaza y la CLI dice por qué.
    await runPostCreate(s.deps(), "Solo texto", { broker: "agentpey" });
    const text = (await s.h.posts.list({}, ALL_SCOPE)).find((item) => item.topic === "Solo texto");
    if (text === undefined) throw new Error("sin el post de texto");
    expect(await runPostEdit(s.deps(), text.id, { music: "calm-piano" })).toBe(1);
    expect(s.h.errors()).toContain("La música es solo para los posts de video");
    expect((await s.h.posts.get(text.id))?.musicTrackId).toBeNull();
  });

  it("approve sin --platform aprueba solo las redes del post; con todas quitadas, lo explica", async () => {
    const s = await setup();
    await runPostCreate(s.deps(), "Dos redes", { broker: "agentpey" });
    const post = await s.created();
    s.setDraft({
      texts: [
        { platform: "discord", language: "es" },
        { platform: "x", language: "es" },
      ],
    });
    expect(await runPostDraft(s.deps(), post.id)).toBe(0);
    await s.h.posts.update(post.id, { platforms: ["discord"] });

    expect(await runPostApprove(s.deps(), post.id)).toBe(0);
    expect(s.h.errors()).toContain("Sin aprobar: X ya no está entre las redes del post");
    const statuses = (await s.h.contents.listCurrent({ kind: "post", id: post.id })).map(
      (content) => [content.platform, content.status],
    );
    expect(statuses).toEqual(
      expect.arrayContaining([
        ["discord", "approved"],
        ["x", "draft"],
      ]),
    );

    await s.h.posts.update(post.id, { platforms: ["linkedin"] });
    expect(await runPostApprove(s.deps(), post.id, { undo: true })).toBe(0);
    expect(await runPostApprove(s.deps(), post.id)).toBe(1);
    expect(s.h.errors()).toContain("POST_PLATFORM_EXCLUDED");
  });

  it("show con una corrida terminada sin textos dice una sola vez qué falta", async () => {
    const s = await setup();
    await runPostCreate(s.deps(), "Sin textos", { broker: "agentpey" });
    const post = await s.created();
    await s.h.posts.update(post.id, { platforms: ["discord"] });
    s.setDraft({ texts: [] });
    expect(await runPostDraft(s.deps(), post.id)).toBe(0);
    s.h.out.length = 0;
    expect(await runPostShow(s.deps(), post.id)).toBe(0);
    expect(s.h.text()).toContain("Falta el texto de Discord");
    expect(s.h.text()).not.toContain("(ninguno: pídelos");
  });

  it("un corredor no ve ni toca los posts de otra marca (POST_NOT_FOUND)", async () => {
    const s = await setup();
    const foreign = await s.h.posts.create({
      brokerId: s.other.id,
      topic: "De otra marca",
      kind: "text",
      status: "draft",
    });
    const user = s.h.auth.repos.seed.user({
      email: "agentpey@ejemplo.cl",
      name: "AgentPey",
      role: "broker",
      brokerId: s.brand.id,
    });
    s.h.auth.repos.seed.session({
      userId: user.id,
      tokenHash: s.h.auth.tokens.hash(BROKER_TOKEN),
      client: "cli",
    });
    const broker = s.deps({ client: s.h.clientWith(BROKER_TOKEN) });
    expect(await runPostShow(broker, foreign.id)).toBe(1);
    expect(await runPostDraft(broker, foreign.id)).toBe(1);
    expect(await runPostArchive(broker, foreign.id)).toBe(1);
    expect(s.h.errors()).toContain("POST_NOT_FOUND");
    expect(s.h.errors()).toContain("agentsales post list");
    expect((await s.h.posts.get(foreign.id))?.status).toBe("draft");

    // Su propio post sí, sin --broker (ve una sola marca).
    expect(await runPostCreate(broker, "El mío")).toBe(0);
    s.h.out.length = 0;
    expect(await runPostList(broker)).toBe(0);
    expect(s.h.text()).toContain("El mío");
    expect(s.h.text()).not.toContain("De otra marca");
  });

  it("en vivo, programar y publicar preguntan; si no, no cambia nada", async () => {
    const s = await setup({ live: true });
    const { post, publication } = await approvedPost(s);
    expect(await runPostSchedule(s.deps({}, false), post.id, {})).toBe(1);
    expect(s.h.errors()).toContain("SCHEDULE_AT_REQUIRED");

    expect(await runPostSchedule(s.deps({}, false), post.id, { at: inHours(3) })).toBe(1);
    expect(await runPostPublish(s.deps({}, false), post.id)).toBe(1);
    expect(await runRetryPublication(s.deps({}, false), publication.id)).toBe(1);
    expect(s.asked).toHaveLength(3);
    expect(s.asked[0]).toContain("EN VIVO");
    expect(s.asked[1]).toContain("¿publicar el post de verdad en Discord?");
    expect(s.h.errors()).toContain("No se publicó nada");
    expect(s.publicationsOf(post.id)[0]?.status).toBe("approved");
  });

  it("con el servidor en vivo pero la marca apagada (ADR-0036), no pregunta: sale en simulación", async () => {
    const s = await setup({ live: true });
    const { post } = await approvedPost(s);
    await s.h.brokers.setLiveEnabled((await s.h.brokers.findBySlug("agentpey"))?.id ?? "", false);
    expect(await runPostSchedule(s.deps({}, false), post.id, { at: inHours(3) })).toBe(0);
    expect(s.asked).toEqual([]);
    expect(s.publicationsOf(post.id)[0]).toMatchObject({ status: "scheduled", dryRun: true });
  });
});

describe("el enlace en X (F9-T16)", () => {
  const LINK = "https://agentpey.com/guia";

  /** Un post con el enlace en el brief y un texto de X que lo lleva (sin la marca del post). */
  async function xPostWithLink(s: Awaited<ReturnType<typeof setup>>) {
    expect(
      await runPostCreate(s.deps(), "Lo que aprendí esta semana", {
        broker: "agentpey",
        brief: `La guía está en ${LINK}`,
      }),
    ).toBe(0);
    const post = await s.created();
    s.setDraft({ texts: [{ platform: "x", language: "es", body: `Texto en es para x: ${LINK}` }] });
    expect(await runPostDraft(s.deps(), post.id)).toBe(0);
    return post;
  }

  it("sin la marca, show y approve dicen el comando exacto; --x-link la pone y --no-x-link la quita", async () => {
    const s = await setup();
    const post = await xPostWithLink(s);
    s.h.out.length = 0;
    expect(await runPostShow(s.deps(), post.id)).toBe(0);
    expect(s.h.text()).toContain(
      `Enlace en X: no permitido (permítelo con agentsales post edit ${post.id} --x-link; cuesta US$0,20 en vez de US$0,015)`,
    );
    expect(s.h.text()).toContain("Lleva un enlace y el post no lo permite en X");
    expect(s.h.text()).toContain("LINK_NOT_ALLOWED");

    // Aprobar el texto de X falla con el consejo de permitirlo, no el genérico de corregir.
    expect(await runPostApprove(s.deps(), post.id, { platform: "x" })).toBe(1);
    expect(s.h.errors()).toContain("CONTENT_HAS_ERRORS");
    expect(s.h.errors()).toContain(`permítelo con agentsales post edit ${post.id} --x-link`);
    expect(s.h.errors()).not.toContain("Corrige el texto");

    s.h.out.length = 0;
    expect(await runPostEdit(s.deps(), post.id, { xLink: true })).toBe(0);
    expect(s.h.text()).toContain("enlace en X: permitido, cuesta US$0,20 en vez de US$0,015");
    expect((await s.h.posts.get(post.id))?.xLinkAllowed).toBe(true);
    s.h.out.length = 0;
    expect(await runPostShow(s.deps(), post.id)).toBe(0);
    expect(s.h.text()).toContain("Enlace en X: permitido (un post con enlace cuesta US$0,20");
    expect(s.h.text()).not.toContain("Lleva un enlace y el post no lo permite en X");
    expect(s.h.text()).toContain("LINK_COST");

    expect(await runPostApprove(s.deps(), post.id, { platform: "x" })).toBe(0);
    const [content] = await s.h.contents.listCurrent({ kind: "post", id: post.id });
    expect(content?.status).toBe("approved");

    expect(await runPostApprove(s.deps(), post.id, { platform: "x", undo: true })).toBe(0);
    s.h.out.length = 0;
    expect(await runPostEdit(s.deps(), post.id, { xLink: false })).toBe(0);
    expect(s.h.text()).toContain("enlace en X: no permitido");
    expect((await s.h.posts.get(post.id))?.xLinkAllowed).toBe(false);
  });

  it("post edit --x-link y --no-x-link llegan a la API; sin ellas, la marca no cambia", async () => {
    const s = await setup();
    const post = await xPostWithLink(s);
    const program = new Command().exitOverride();
    register(program, {
      ...s.h.io,
      api: () => s.h.client,
      server: () => ({
        ok: true,
        target: { url: localServerUrl(PORT), source: "local", remote: false, sessionUrl: null },
      }),
      localServer: () => localServerUrl(PORT),
      localPort: () => PORT,
      envApiUrl: undefined,
      apiFor: () => s.h.client,
      clientFrom: () => s.h.client,
      session: createMemorySessionStore(),
      readPassword: async () => null,
      copyToClipboard: async () => {
        throw new Error("no debía copiar");
      },
      cwd: s.cwd,
      confirm: noQuestions,
      stdinIsTty: () => true,
      readStdin: async () => "",
      openUrl: () => {},
    });
    await program.parseAsync(["post", "edit", post.id, "--x-link"], { from: "user" });
    expect((await s.h.posts.get(post.id))?.xLinkAllowed).toBe(true);
    // Sin la opción no se manda: la marca queda como esté (aquí, quitada por fuera).
    await s.h.posts.update(post.id, { xLinkAllowed: false });
    await program.parseAsync(["post", "edit", post.id, "--date", "2026-11-05 10:00"], {
      from: "user",
    });
    expect(await s.h.posts.get(post.id)).toMatchObject({
      xLinkAllowed: false,
      plannedAt: new Date("2026-11-05T13:00:00Z"),
    });
    await s.h.posts.update(post.id, { xLinkAllowed: true });
    await program.parseAsync(["post", "edit", post.id, "--no-x-link"], { from: "user" });
    expect((await s.h.posts.get(post.id))?.xLinkAllowed).toBe(false);
  });
});
