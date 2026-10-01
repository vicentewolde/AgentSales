import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "../errors.js";
import type { NewMedia } from "../ports/media-repository.js";
import {
  createInMemoryMediaFileSource,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  memoryFile,
} from "./media.js";

// La semántica de `MediaRepository` contra Postgres se fija en la suite de contrato de
// `packages/db` (F1-T07b); aquí, lo que usan los tests de `ingestMedia`.

const newMedia = (overrides: Partial<NewMedia> = {}): NewMedia => ({
  listingId: "listing-1",
  brokerId: "broker-1",
  kind: "image",
  storagePath: "brokers/broker-1/listings/listing-1/original/a.jpg",
  mime: "image/jpeg",
  bytes: 10,
  checksum: "a",
  sortOrder: 0,
  isCover: false,
  ...overrides,
});

async function caught(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("createInMemoryMediaRepository", () => {
  it("create choca con el mismo checksum del aviso o la misma ruta: MEDIA_CONFLICT reintentable", async () => {
    const repo = createInMemoryMediaRepository();
    await repo.create(newMedia());

    for (const clash of [newMedia({ storagePath: "otra.jpg" }), newMedia({ checksum: "b" })]) {
      const error = await caught(repo.create(clash));
      expect(isAppError(error) && [error.code, error.retriable]).toEqual(["MEDIA_CONFLICT", true]);
    }
    // El mismo archivo en otro aviso sí vale.
    await repo.create(newMedia({ listingId: "listing-2", storagePath: "b.jpg" }));
  });

  it("listOriginals ordena por sortOrder; arrange es todo o nada", async () => {
    const repo = createInMemoryMediaRepository();
    const a = await repo.create(newMedia({ sortOrder: 1 }));
    const b = await repo.create(newMedia({ storagePath: "b.jpg", checksum: "b", sortOrder: 0 }));
    const other = await repo.create(
      newMedia({ listingId: "listing-2", storagePath: "c.jpg", checksum: "c" }),
    );
    expect((await repo.listOriginals("listing-1")).map((media) => media.id)).toEqual([b.id, a.id]);

    const error = await caught(
      repo.arrange("listing-1", [
        { id: a.id, sortOrder: 0, isCover: true },
        { id: other.id, sortOrder: 1, isCover: false },
      ]),
    );
    expect(isAppError(error) && error.code).toBe("MEDIA_NOT_FOUND");
    expect((await repo.listOriginals("listing-1")).map((media) => media.isCover)).toEqual([
      false,
      false,
    ]);

    await repo.arrange("listing-1", [{ id: a.id, sortOrder: 0, isCover: true }]);
    expect(await repo.listOriginals("listing-1")).toMatchObject([
      { id: a.id, sortOrder: 0, isCover: true },
      { id: b.id, sortOrder: 0, isCover: false },
    ]);
  });
});

describe("createInMemoryMediaStorage", () => {
  it("putStream con otro largo: STORAGE_CONTENT_MISMATCH, sin guardar", async () => {
    const storage = createInMemoryMediaStorage();
    const file = memoryFile("p/foto.jpg", "abc");

    const error = await caught(
      storage.putStream("x.jpg", file.open(), { contentType: "image/jpeg", contentLength: 4 }),
    );

    expect(isAppError(error) && [error.code, error.retriable]).toEqual([
      "STORAGE_CONTENT_MISMATCH",
      false,
    ]);
    expect(storage.objects.size).toBe(0);
    expect(storage.uploads).toEqual([]);
  });

  it("putStream guarda los bytes y el tipo, y registra la subida", async () => {
    const storage = createInMemoryMediaStorage();
    const file = memoryFile("p/foto.jpg", "abc");

    await storage.putStream("x.jpg", file.open(), { contentType: "image/jpeg", contentLength: 3 });

    expect(await storage.get("x.jpg")).toEqual(new Uint8Array([97, 98, 99]));
    expect(await storage.head("x.jpg")).toEqual({ size: 3, contentType: "image/jpeg" });
    expect(storage.uploads).toEqual(["x.jpg"]);
  });
});

describe("createInMemoryMediaFileSource", () => {
  it("una carpeta fuera del mapa es MEDIA_FOLDER_NOT_FOUND; un AppError del mapa se lanza", async () => {
    const source = createInMemoryMediaFileSource({
      rota: new AppError("MEDIA_FOLDER_UNREADABLE", "sin permiso"),
    });

    const missing = await caught(source.list("nada"));
    const broken = await caught(source.list("rota"));

    expect(isAppError(missing) && missing.code).toBe("MEDIA_FOLDER_NOT_FOUND");
    expect(isAppError(broken) && broken.code).toBe("MEDIA_FOLDER_UNREADABLE");
    expect(source.listed).toEqual(["nada", "rota"]);
  });
});
