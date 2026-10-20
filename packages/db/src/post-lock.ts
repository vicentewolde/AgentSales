import {
  AppError,
  lockedMedia,
  type PostLock,
  postSubject,
  type SecretBox,
} from "@agentsales/core";
import { eq } from "drizzle-orm";
import type { SchemaDatabase } from "./client.js";
import { withDbErrors } from "./errors.js";
import { createBrokerRepository } from "./repositories/brokers.js";
import { createContentRunRepository } from "./repositories/content-runs.js";
import { createContentRepository } from "./repositories/contents.js";
import { createMediaRepository } from "./repositories/media.js";
import { createPlatformAccountRepository } from "./repositories/platform-accounts.js";
import { createPostRepository, createPostUploadRepository } from "./repositories/posts.js";
import { createPublicationRepository } from "./repositories/publications.js";
import { posts } from "./schema.js";

/**
 * Candado por post sobre Postgres (ADR-0029, punto 3), como `createListingLock`: una transacción
 * que bloquea la fila del post con `FOR NO KEY UPDATE` y entrega a `fn` repositorios atados a esa
 * transacción (las transacciones propias de los repositorios pasan a ser savepoints). Si `fn`
 * falla, se deshace todo. El bloqueo es de una fila de `posts`, no un advisory lock: su espacio de
 * llaves es la tabla, así que nunca choca con el candado de un aviso (filas de `listings`). Dos
 * `run` del mismo post se esperan; los de posts distintos no.
 */
export function createPostLock(
  db: SchemaDatabase,
  { secretBox }: { secretBox: SecretBox },
): PostLock {
  return {
    run(postId, fn) {
      return withDbErrors(() =>
        db.transaction(async (tx) => {
          const [row] = await tx
            .select({ id: posts.id })
            .from(posts)
            .where(eq(posts.id, postId))
            .for("no key update");
          if (row === undefined) {
            throw new AppError("POST_NOT_FOUND", `No existe el post ${postId}`, {
              details: { postId },
            });
          }
          return fn({
            brokers: createBrokerRepository(tx),
            posts: createPostRepository(tx),
            postUploads: createPostUploadRepository(tx),
            // `arrange` solo con este post: con otro sujeto sería un segundo bloqueo anidado.
            media: lockedMedia(createMediaRepository(tx), postSubject(postId)),
            contentRuns: createContentRunRepository(tx),
            contents: createContentRepository(tx),
            publications: createPublicationRepository(tx),
            platformAccounts: createPlatformAccountRepository(tx, { secretBox }),
          });
        }),
      );
    },
  };
}
