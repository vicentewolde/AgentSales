import type { NewPublication, PublicationRepository } from "@agentsales/core";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Suite de contrato de `PublicationRepository` (F3-T04): corre igual contra el doble en memoria y
 * contra Drizzle sobre PGlite. Cada caso usa su propio aviso (`fixtures`), así no comparten filas.
 */
export type PublicationRepositories = {
  publications: PublicationRepository;
  /** Un aviso nuevo con una cuenta y un texto de Instagram, para referenciar desde la publicación. */
  fixtures(): Promise<{ listingId: string; accountId: string; contentId: string }>;
  /** Un id con el formato del adaptador que no existe (un uuid en Postgres). */
  missingId: string;
};

const remote = {
  status: "paused",
  subStatus: ["picture_download_pending"],
  // Con la zona horaria de Chile, como lo entrega Mercado Libre: el jsonb la guarda tal cual.
  stopTime: "2026-11-20T01:00:00.000-03:00",
  expirationTime: null,
  checkedAt: "2026-10-06T12:00:00.000Z",
};

const portalProgress = {
  pictureIds: ["foto-1", "foto-2"],
  sellerContact: { contact: "Vinny", email: null, countryCode2: "56", phone2: "912345678" },
  createRequestedAt: "2026-10-06T12:00:00.000Z",
  itemId: "MLC123",
};

/** Unos milisegundos reales: `updatedAt` de Postgres usa su reloj, no uno falso. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const progress = {
  attemptStartedAt: "2026-10-05T12:00:00.000Z",
  childIds: ["hijo-1", "hijo-2"],
  containerId: "carrusel-1",
};

export function publicationRepositoryContract(
  name: string,
  make: () => Promise<PublicationRepositories>,
) {
  describe(`${name} · PublicationRepository`, () => {
    let repos: PublicationRepositories;
    beforeAll(async () => {
      repos = await make();
    });

    const newPublication = async (
      overrides: Partial<NewPublication> = {},
    ): Promise<NewPublication> => {
      const { listingId, accountId, contentId } = await repos.fixtures();
      return {
        listingId,
        platformAccountId: accountId,
        platform: "instagram",
        format: "post",
        contentId,
        mediaIds: [],
        listingSourceHash: "hash",
        ...overrides,
      };
    };
    const operator = { actor: "operator" } as const;

    it("create nace en approved con su evento de nacimiento", async () => {
      const input = await newPublication();
      const publication = await repos.publications.create(input, {
        actor: "operator",
        payload: { motivo: "aprobado" },
      });

      expect(publication).toMatchObject({
        listingId: input.listingId,
        platformAccountId: input.platformAccountId,
        platform: "instagram",
        format: "post",
        contentId: input.contentId,
        status: "approved",
        attempts: 0,
        dryRun: true,
        progress: null,
        lastError: null,
        externalId: null,
        publishedAt: null,
      });
      expect(await repos.publications.get(publication.id)).toEqual(publication);
      expect(await repos.publications.get(repos.missingId)).toBeNull();
      expect(await repos.publications.listEvents(publication.id)).toEqual([
        expect.objectContaining({
          type: "status_changed",
          fromStatus: null,
          toStatus: "approved",
          actor: "operator",
          payload: { motivo: "aprobado" },
        }),
      ]);
    });

    it("el carrusel y el reel conviven; una segunda activa del mismo formato es PUBLICATION_CONFLICT", async () => {
      const input = await newPublication();
      const post = await repos.publications.create(input, operator);
      await repos.publications.create({ ...input, format: "reel" }, operator);

      await expect(repos.publications.create(input, operator)).rejects.toMatchObject({
        code: "PUBLICATION_CONFLICT",
        retriable: false,
      });
      // La que no se creó no deja un evento suelto.
      expect(await repos.publications.listEvents(post.id)).toHaveLength(1);
      expect(
        (await repos.publications.listByListing(input.listingId)).map((item) => item.format),
      ).toEqual(["post", "reel"]);
    });

    it("transition cambia el estado con sus campos y anota el evento, en orden", async () => {
      const created = await repos.publications.create(await newPublication(), operator);

      const publishing = await repos.publications.transition(
        created.id,
        { from: "approved", to: "publishing", changes: { incrementAttempts: true, dryRun: false } },
        { actor: "cli" },
      );
      expect(publishing).toMatchObject({ status: "publishing", attempts: 1, dryRun: false });

      const publishedAt = new Date("2026-10-05T12:05:00Z");
      const published = await repos.publications.transition(
        created.id,
        {
          from: "publishing",
          to: "published",
          changes: {
            externalId: "17900000000000000",
            externalUrl: "https://www.instagram.com/p/abc/",
            publishedAt,
            progress,
          },
        },
        { actor: "system", payload: { intento: 1 } },
      );
      expect(published).toMatchObject({
        status: "published",
        externalId: "17900000000000000",
        externalUrl: "https://www.instagram.com/p/abc/",
        publishedAt,
        progress,
        attempts: 1,
      });
      expect(
        (await repos.publications.listEvents(created.id)).map((event) => [
          event.fromStatus,
          event.toStatus,
          event.actor,
        ]),
      ).toEqual([
        [null, "approved", "operator"],
        ["approved", "publishing", "cli"],
        ["publishing", "published", "system"],
      ]);
    });

    it("guarda y borra el último error", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      await repos.publications.transition(
        created.id,
        { from: "approved", to: "publishing", changes: { incrementAttempts: true, dryRun: true } },
        operator,
      );
      const lastError = {
        code: "IG_UNAVAILABLE",
        message: "Instagram no respondió",
        retriable: true,
      };

      const failed = await repos.publications.transition(
        created.id,
        { from: "publishing", to: "failed", changes: { lastError } },
        { actor: "system" },
      );
      expect(failed.lastError).toEqual(lastError);

      const retry = await repos.publications.transition(
        created.id,
        {
          from: "failed",
          to: "publishing",
          changes: { incrementAttempts: true, lastError: null, dryRun: true },
        },
        operator,
      );
      expect(retry).toMatchObject({ lastError: null, attempts: 2 });
    });

    it("una transición que la máquina no permite es INVALID_TRANSITION, sin escribir", async () => {
      const created = await repos.publications.create(await newPublication(), operator);

      await expect(
        repos.publications.transition(created.id, { from: "approved", to: "published" }, operator),
      ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
      expect((await repos.publications.get(created.id))?.status).toBe("approved");
      expect(await repos.publications.listEvents(created.id)).toHaveLength(1);
    });

    it("desde un estado que ya cambió es INVALID_TRANSITION, sin escribir ni anotar", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      await repos.publications.transition(
        created.id,
        { from: "approved", to: "cancelled" },
        operator,
      );

      await expect(
        repos.publications.transition(
          created.id,
          {
            from: "approved",
            to: "publishing",
            changes: { incrementAttempts: true, dryRun: true },
          },
          operator,
        ),
      ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
      expect(await repos.publications.get(created.id)).toMatchObject({
        status: "cancelled",
        attempts: 0,
      });
      expect(await repos.publications.listEvents(created.id)).toHaveLength(2);
    });

    it("un progreso que no calza con su plataforma es PUBLICATION_PROGRESS_INVALID, sin escribir", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      await repos.publications.transition(
        created.id,
        { from: "approved", to: "publishing", changes: { dryRun: true } },
        operator,
      );

      for (const bad of [{ containerId: 3 }, "texto", [1, 2]]) {
        await expect(repos.publications.saveProgress(created.id, bad)).rejects.toMatchObject({
          code: "PUBLICATION_PROGRESS_INVALID",
          retriable: false,
        });
        await expect(
          repos.publications.transition(
            created.id,
            { from: "publishing", to: "failed", changes: { progress: bad } },
            operator,
          ),
        ).rejects.toMatchObject({ code: "PUBLICATION_PROGRESS_INVALID" });
      }
      expect(await repos.publications.get(created.id)).toMatchObject({
        status: "publishing",
        progress: null,
      });
    });

    it("saveProgress guarda y borra el progreso, solo mientras se publica", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      await expect(repos.publications.saveProgress(created.id, progress)).rejects.toMatchObject({
        code: "PUBLICATION_NOT_PUBLISHING",
      });

      await repos.publications.transition(
        created.id,
        { from: "approved", to: "publishing", changes: { dryRun: true } },
        operator,
      );
      expect((await repos.publications.saveProgress(created.id, progress)).progress).toEqual(
        progress,
      );
      expect((await repos.publications.get(created.id))?.progress).toEqual(progress);
      expect((await repos.publications.saveProgress(created.id, null)).progress).toBeNull();
      // Guardar el progreso no anota un cambio de estado.
      expect(await repos.publications.listEvents(created.id)).toHaveLength(2);
    });

    it("un reintento desde failed conserva el progreso", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      await repos.publications.transition(
        created.id,
        { from: "approved", to: "publishing", changes: { dryRun: true } },
        operator,
      );
      await repos.publications.saveProgress(created.id, progress);
      await repos.publications.transition(
        created.id,
        { from: "publishing", to: "failed" },
        operator,
      );

      const retry = await repos.publications.transition(
        created.id,
        { from: "failed", to: "publishing", changes: { dryRun: true } },
        operator,
      );
      expect(retry.progress).toEqual(progress);
    });

    it("addEvent anota un evento sin cambiar el estado; listEvents las trae en orden", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      const event = await repos.publications.addEvent(created.id, {
        type: "publish_attempt",
        actor: "system",
        payload: { modo: "dry-run", caption: "Texto" },
      });

      expect(event).toMatchObject({
        publicationId: created.id,
        type: "publish_attempt",
        fromStatus: null,
        toStatus: null,
        payload: { modo: "dry-run", caption: "Texto" },
      });
      expect((await repos.publications.listEvents(created.id)).map((item) => item.type)).toEqual([
        "status_changed",
        "publish_attempt",
      ]);
      expect((await repos.publications.get(created.id))?.status).toBe("approved");
    });

    it("listByStatus trae las de un estado", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      await repos.publications.transition(
        created.id,
        { from: "approved", to: "publishing", changes: { dryRun: true } },
        operator,
      );

      const publishing = await repos.publications.listByStatus("publishing");
      expect(publishing.map((item) => item.id)).toContain(created.id);
      expect(publishing.every((item) => item.status === "publishing")).toBe(true);
    });

    it("pasar a publishing sin fijar el modo es PUBLICATION_MODE_REQUIRED, sin escribir", async () => {
      const created = await repos.publications.create(await newPublication(), operator);

      await expect(
        repos.publications.transition(
          created.id,
          { from: "approved", to: "publishing", changes: { incrementAttempts: true } },
          operator,
        ),
      ).rejects.toMatchObject({ code: "PUBLICATION_MODE_REQUIRED", retriable: false });
      expect(await repos.publications.get(created.id)).toMatchObject({
        status: "approved",
        attempts: 0,
      });
    });

    it("un formato terminal libera su lugar: se puede crear otra del mismo formato", async () => {
      const input = await newPublication();
      const first = await repos.publications.create(input, operator);
      await repos.publications.transition(
        first.id,
        { from: "approved", to: "cancelled" },
        operator,
      );

      const second = await repos.publications.create(input, operator);
      expect(second.id).not.toBe(first.id);
      expect(
        (await repos.publications.listByListing(input.listingId)).map((item) => item.status),
      ).toEqual(["cancelled", "approved"]);
    });

    it("updatedAt avanza con cada cambio y nunca queda antes de createdAt", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      expect(created.updatedAt.getTime()).toBeGreaterThanOrEqual(created.createdAt.getTime());

      const publishing = await repos.publications.transition(
        created.id,
        { from: "approved", to: "publishing", changes: { dryRun: true } },
        operator,
      );
      expect(publishing.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
      const saved = await repos.publications.saveProgress(created.id, progress);
      expect(saved.updatedAt.getTime()).toBeGreaterThanOrEqual(publishing.updatedAt.getTime());
    });

    it("revisa los datos antes que el estado: los dos adaptadores dan el mismo error", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      await repos.publications.transition(
        created.id,
        { from: "approved", to: "cancelled" },
        operator,
      );

      // Desde un estado que ya cambió y con un progreso inválido: manda el progreso.
      await expect(
        repos.publications.transition(
          created.id,
          { from: "approved", to: "publishing", changes: { dryRun: true, progress: { x: 1 } } },
          operator,
        ),
      ).rejects.toMatchObject({ code: "PUBLICATION_PROGRESS_INVALID" });
      // Un evento inválido sobre una publicación que no existe: manda el evento.
      await expect(
        repos.publications.addEvent(repos.missingId, {
          type: "sync",
          actor: "system",
          payload: ["no", "es", "objeto"] as unknown as Record<string, unknown>,
        }),
      ).rejects.toMatchObject({ code: "PUBLICATION_EVENT_INVALID" });
    });

    it("una publicación que no existe es PUBLICATION_NOT_FOUND en cada escritura", async () => {
      const id = repos.missingId;
      for (const action of [
        () => repos.publications.transition(id, { from: "approved", to: "cancelled" }, operator),
        () => repos.publications.saveProgress(id, null),
        () => repos.publications.addEvent(id, { type: "sync", actor: "system" }),
        () => repos.publications.setRemoteState(id, null),
      ]) {
        await expect(action()).rejects.toMatchObject({ code: "PUBLICATION_NOT_FOUND" });
      }
    });
    it("nace sin estado remoto y con la versión del aviso que recibe (F4; obligatoria desde F4-T16)", async () => {
      const sin = await repos.publications.create(await newPublication(), operator);
      expect(sin).toMatchObject({ remoteState: null, listingSourceHash: "hash" });

      const con = await repos.publications.create(
        await newPublication({ listingSourceHash: "hash-del-aviso" }),
        operator,
      );
      expect(con.listingSourceHash).toBe("hash-del-aviso");
      expect(await repos.publications.get(con.id)).toEqual(con);
    });

    it("setRemoteState guarda el estado remoto en cualquier estado, con su evento, y null lo borra", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      await tick();

      const saved = await repos.publications.setRemoteState(created.id, remote, {
        type: "sync",
        actor: "system",
        payload: { remote },
      });
      expect(saved.status).toBe("approved");
      expect(saved.remoteState).toEqual(remote);
      expect(saved.remoteState?.stopTime).toBe("2026-11-20T01:00:00.000-03:00");
      expect(saved.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
      expect(await repos.publications.get(created.id)).toEqual(saved);
      const events = await repos.publications.listEvents(created.id);
      expect(events.at(-1)).toMatchObject({
        type: "sync",
        fromStatus: null,
        toStatus: null,
        actor: "system",
        payload: { remote },
      });

      const sinEvento = await repos.publications.setRemoteState(created.id, null);
      expect(sinEvento.remoteState).toBeNull();
      expect(await repos.publications.listEvents(created.id)).toHaveLength(events.length);
    });

    it("transition guarda el estado remoto junto con el cambio de estado", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      await repos.publications.transition(
        created.id,
        { from: "approved", to: "publishing", changes: { dryRun: false } },
        operator,
      );
      const publishing = await repos.publications.get(created.id);
      await tick();
      const published = await repos.publications.transition(
        created.id,
        { from: "publishing", to: "published", changes: { remoteState: remote } },
        { actor: "system" },
      );
      expect(published.remoteState).toEqual(remote);
      expect(published.updatedAt.getTime()).toBeGreaterThan(publishing?.updatedAt.getTime() ?? 0);

      const paused = await repos.publications.transition(
        created.id,
        { from: "published", to: "paused" },
        { actor: "system" },
      );
      // Sin `remoteState` en los cambios, no se toca.
      expect(paused.remoteState).toEqual(remote);
    });

    it("un estado remoto inválido es PUBLICATION_REMOTE_STATE_INVALID, sin escribir", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      const before = await repos.publications.listEvents(created.id);
      const invalid = { ...remote, checkedAt: "ayer" } as unknown as typeof remote;

      await expect(
        repos.publications.setRemoteState(created.id, invalid, { type: "sync", actor: "system" }),
      ).rejects.toMatchObject({ code: "PUBLICATION_REMOTE_STATE_INVALID" });
      await expect(
        repos.publications.transition(
          created.id,
          { from: "approved", to: "cancelled", changes: { remoteState: invalid } },
          operator,
        ),
      ).rejects.toMatchObject({ code: "PUBLICATION_REMOTE_STATE_INVALID" });

      expect(await repos.publications.get(created.id)).toEqual(created);
      expect(await repos.publications.listEvents(created.id)).toEqual(before);
    });

    it("revisa el estado remoto y el evento antes que el estado, sin escribir nada", async () => {
      const created = await repos.publications.create(await newPublication(), operator);
      const before = await repos.publications.listEvents(created.id);
      const invalid = { ...remote, status: "" };

      // Una publicación que no existe con datos inválidos: primero los datos.
      await expect(
        repos.publications.setRemoteState(repos.missingId, invalid),
      ).rejects.toMatchObject({ code: "PUBLICATION_REMOTE_STATE_INVALID" });
      // Una transición que la máquina no permite con datos inválidos: primero los datos.
      await expect(
        repos.publications.transition(
          created.id,
          { from: "approved", to: "published", changes: { remoteState: invalid } },
          operator,
        ),
      ).rejects.toMatchObject({ code: "PUBLICATION_REMOTE_STATE_INVALID" });
      // Un evento inválido no deja el estado remoto a medias: fila y evento van juntos.
      await expect(
        repos.publications.setRemoteState(created.id, remote, {
          type: "sync",
          actor: "system",
          payload: [] as unknown as Record<string, unknown>,
        }),
      ).rejects.toMatchObject({ code: "PUBLICATION_EVENT_INVALID" });

      expect(await repos.publications.get(created.id)).toEqual(created);
      expect(await repos.publications.listEvents(created.id)).toEqual(before);
    });

    it("una versión del aviso vacía queda en null", async () => {
      const created = await repos.publications.create(
        await newPublication({ listingSourceHash: "" }),
        operator,
      );
      expect(created.listingSourceHash).toBeNull();
    });

    it("el progreso de Portal se valida con su esquema", async () => {
      const created = await repos.publications.create(
        await newPublication({ platform: "portal_inmobiliario" }),
        operator,
      );
      await repos.publications.transition(
        created.id,
        { from: "approved", to: "publishing", changes: { dryRun: false } },
        operator,
      );

      const saved = await repos.publications.saveProgress(created.id, portalProgress);
      expect(saved.progress).toEqual(portalProgress);
      // El de Instagram no calza con Portal.
      await expect(repos.publications.saveProgress(created.id, progress)).rejects.toMatchObject({
        code: "PUBLICATION_PROGRESS_INVALID",
      });
      // Un WhatsApp con símbolos tampoco: Mercado Libre exige solo dígitos.
      await expect(
        repos.publications.saveProgress(created.id, {
          ...portalProgress,
          sellerContact: { ...portalProgress.sellerContact, phone2: "+56 9 1234 5678" },
        }),
      ).rejects.toMatchObject({ code: "PUBLICATION_PROGRESS_INVALID" });
      expect((await repos.publications.get(created.id))?.progress).toEqual(portalProgress);
    });
  });
}
