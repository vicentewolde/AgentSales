import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createLogger, type Logger } from "@agentsales/config";
import {
  type LLMProvider,
  type MediaProcessor,
  type NewListing,
  SAMPLE_CONTENT_DRAFT,
} from "@agentsales/core";
import {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
  createInMemoryBrokerRepository,
  createInMemoryContentRepositories,
  createInMemoryFieldDefinitionRepository,
  createInMemoryHtmlRenderer,
  createInMemoryListingRepository,
  createInMemoryLlmProvider,
  createInMemoryMediaProcessor,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
  createInMemorySlideTemplates,
  fakeHash,
} from "@agentsales/core/testing";
import type { ContentPrepareJobDeps } from "../src/jobs/content-prepare.js";

/** Un logger que descarta todo. */
export const silentLogger: Logger = createLogger(
  { level: "silent" },
  new Writable({ write: (_chunk, _encoding, callback) => callback() }),
);

/** Un logger que guarda cada línea como objeto (para revisar qué se registra). */
export function captureLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { level: "info" },
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(JSON.parse(chunk.toString()));
        callback();
      },
    }),
  );
  return { logger, lines };
}

const text = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));

/**
 * Un aviso con dos fotos en memoria, las dependencias del job `content.prepare` con dobles de core
 * y un directorio temporal real. El procesador escribe un archivo en el temporal del intento (como
 * el de `packages/media`) y anota si el directorio existía mientras trabajaba.
 */
export async function contentJobSetup(options: { llm?: LLMProvider } = {}) {
  const media = createInMemoryMediaRepository();
  const storage = createInMemoryMediaStorage();
  const broker = contentBrokerFixture();
  const listings = createInMemoryListingRepository();
  const {
    id: _id,
    status: _s,
    closeReason: _c,
    createdAt: _a,
    updatedAt: _u,
    ...rest
  } = contentListingFixture();
  const listing = await listings.create({
    ...(rest as Omit<NewListing, "sourceHash">),
    sourceHash: "hash-1",
  });
  await listings.promoteToReady(listing.id);
  for (const [index, name] of ["foto-1", "foto-2"].entries()) {
    const path = `brokers/${broker.id}/listings/${listing.id}/original/${name}`;
    await storage.put(path, text(name), "image/jpeg");
    await media.create({
      listingId: listing.id,
      brokerId: broker.id,
      kind: "image",
      storagePath: path,
      mime: "image/jpeg",
      bytes: name.length,
      checksum: `sha-${name}`,
      sortOrder: index,
      isCover: index === 0,
    });
  }

  const contentRepos = createInMemoryContentRepositories({ nextId: () => randomUUID() });
  const tmpRoot = await mkdtemp(join(tmpdir(), "agentsales-content-"));
  const workDirs: { path: string; existed: boolean }[] = [];
  const llm =
    options.llm ??
    createInMemoryLlmProvider(Array.from({ length: 5 }, () => ({ data: SAMPLE_CONTENT_DRAFT })));
  const abort = new AbortController();

  const createProcessor = (workDir: string): MediaProcessor => {
    const inner = createInMemoryMediaProcessor();
    return {
      version: inner.version,
      async processImage(input, opts, signal) {
        workDirs.push({ path: workDir, existed: existsSync(workDir) });
        await writeFile(join(workDir, `${randomUUID()}.tmp`), "trabajo");
        return inner.processImage(input, opts, signal);
      },
      processVideo: (input, opts, signal) => inner.processVideo(input, opts, signal),
    };
  };

  const deps: ContentPrepareJobDeps = {
    shared: {
      contentRuns: contentRepos.contentRuns,
      listings,
      brokers: createInMemoryBrokerRepository([broker]),
      fieldDefinitions: createInMemoryFieldDefinitionRepository(contentDefinitionsFixture()),
      media,
      storage,
      templates: createInMemorySlideTemplates(),
      renderer: createInMemoryHtmlRenderer(),
      llm,
      sha256: fakeHash,
    },
    createProcessor,
    tmpRoot,
    signal: abort.signal,
  };
  const newRun = async () =>
    (await contentRepos.contentRuns.create({ listingId: listing.id, texts: true })).id;

  return { deps, contentRuns: contentRepos.contentRuns, tmpRoot, workDirs, abort, newRun };
}
