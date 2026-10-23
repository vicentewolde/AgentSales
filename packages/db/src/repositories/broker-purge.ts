import {
  AppError,
  type BrokerPurgeBlocker,
  type BrokerPurgeRepository,
  brokerHasActivePublications,
  isPurgeBlockingStatus,
  isPurgeLiveStatus,
} from "@agentsales/core";
import { count, eq, inArray, or, type SQL } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { withDbErrors } from "../errors.js";
import {
  brokers,
  contentRuns,
  contents,
  editorialProfiles,
  fieldDefinitions,
  importRuns,
  invitations,
  listings,
  loginChallenges,
  media,
  planRuns,
  platformAccounts,
  postImageRuns,
  posts,
  postUploads,
  publicationEvents,
  publications,
  sessions,
  userRecoveryCodes,
  users,
} from "../schema.js";

// Borrar un corredor de verdad (spec F9.5-T14, ADR-0035). Como el borrado de Meta (ADR-0027), este
// repositorio cruza tablas de otros agregados en una transacción, como excepción explícita: **una
// tabla nueva que cuelgue de un corredor, una propiedad, un post, una publicación, una cuenta o un
// usuario debe sumarse aquí** y a su prueba (`packages/db/test/broker-purge.test.ts`, que cuenta
// las filas de cada tabla). Las FK no tienen `ON DELETE CASCADE` (salvo las de usuarios y la
// bitácora): el orden de abajo sigue las dependencias.

type Db = Pick<SchemaDatabase, "select">;

/** Las propiedades, los posts, las cuentas y los usuarios del corredor, como subconsultas. */
const ownedBy = (db: Db, brokerId: string) => ({
  listingIds: db.select({ id: listings.id }).from(listings).where(eq(listings.brokerId, brokerId)),
  postIds: db.select({ id: posts.id }).from(posts).where(eq(posts.brokerId, brokerId)),
  userIds: db.select({ id: users.id }).from(users).where(eq(users.brokerId, brokerId)),
});

/** Lo de un aviso o un post del corredor (publicaciones, textos y corridas). */
function subjectOf(
  db: Db,
  brokerId: string,
  table: typeof publications | typeof contents | typeof contentRuns,
): SQL {
  const { listingIds, postIds } = ownedBy(db, brokerId);
  return or(inArray(table.listingId, listingIds), inArray(table.postId, postIds)) as SQL;
}

/** Sus medios: todos llevan `broker_id`; por si acaso, también los de sus avisos y posts. */
function mediaOf(db: Db, brokerId: string): SQL {
  const { listingIds, postIds } = ownedBy(db, brokerId);
  return or(
    eq(media.brokerId, brokerId),
    inArray(media.listingId, listingIds),
    inArray(media.postId, postIds),
  ) as SQL;
}

const notFound = (brokerId: string) =>
  new AppError("BROKER_NOT_FOUND", `No existe el corredor ${brokerId}`, {
    details: { id: brokerId },
  });

/** `BrokerPurgeRepository` sobre Drizzle (spec F9.5-T14, ADR-0035). */
export function createBrokerPurgeRepository(db: SchemaDatabase): BrokerPurgeRepository {
  return {
    async summarize(brokerId) {
      return withDbErrors(async () => {
        const total = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;
        const [
          listingCount,
          mediaCount,
          publicationCount,
          postCount,
          userCount,
          accountCount,
          importCount,
        ] = await Promise.all([
          total(db.select({ n: count() }).from(listings).where(eq(listings.brokerId, brokerId))),
          total(db.select({ n: count() }).from(media).where(mediaOf(db, brokerId))),
          total(
            db
              .select({ n: count() })
              .from(publications)
              .where(subjectOf(db, brokerId, publications)),
          ),
          total(db.select({ n: count() }).from(posts).where(eq(posts.brokerId, brokerId))),
          total(db.select({ n: count() }).from(users).where(eq(users.brokerId, brokerId))),
          total(
            db
              .select({ n: count() })
              .from(platformAccounts)
              .where(eq(platformAccounts.brokerId, brokerId)),
          ),
          total(
            db.select({ n: count() }).from(importRuns).where(eq(importRuns.brokerId, brokerId)),
          ),
        ]);
        const rows = await db
          .select({
            publicationId: publications.id,
            status: publications.status,
            platform: publications.platform,
          })
          .from(publications)
          .where(subjectOf(db, brokerId, publications));
        const blocking: BrokerPurgeBlocker[] = rows.filter(({ status }) =>
          isPurgeBlockingStatus(status),
        );
        const livePublications = rows.filter(({ status }) => isPurgeLiveStatus(status)).length;
        return {
          counts: {
            listings: listingCount,
            media: mediaCount,
            publications: publicationCount,
            livePublications,
            posts: postCount,
            users: userCount,
            accounts: accountCount,
            importRuns: importCount,
          },
          blocking,
        };
      });
    },

    async storageRefs(brokerId) {
      return withDbErrors(async () => {
        const [mediaRows, uploadRows, postRows, importRows] = await Promise.all([
          db.select({ key: media.storagePath }).from(media).where(mediaOf(db, brokerId)),
          db
            .select({ key: postUploads.objectPath })
            .from(postUploads)
            .where(inArray(postUploads.postId, ownedBy(db, brokerId).postIds)),
          db.select({ id: posts.id }).from(posts).where(eq(posts.brokerId, brokerId)),
          db
            .select({ id: importRuns.id })
            .from(importRuns)
            .where(eq(importRuns.brokerId, brokerId)),
        ]);
        return {
          mediaKeys: mediaRows.map(({ key }) => key),
          uploadKeys: uploadRows.map(({ key }) => key),
          postIds: postRows.map(({ id }) => id),
          importRunIds: importRows.map(({ id }) => id),
        };
      });
    },

    async purge(brokerId) {
      return withDbErrors(() =>
        db.transaction(async (tx) => {
          // Se toman la fila del corredor y, antes de leer las publicaciones, sus propiedades,
          // posts, cuentas y usuarios: un `INSERT` concurrente con FK a cualquiera de ellos (un
          // medio, un texto, una publicación, una sesión…) pide un candado `KEY SHARE` que choca con
          // `FOR UPDATE`, así que espera el borrado y después falla por su FK, sin dejar huérfanos.
          // Las publicaciones también quedan tomadas: un cambio de estado que se cruce espera.
          const [broker] = await tx
            .select({ id: brokers.id })
            .from(brokers)
            .where(eq(brokers.id, brokerId))
            .for("update");
          if (broker === undefined) throw notFound(brokerId);
          await tx
            .select({ id: listings.id })
            .from(listings)
            .where(eq(listings.brokerId, brokerId))
            .for("update");
          await tx
            .select({ id: posts.id })
            .from(posts)
            .where(eq(posts.brokerId, brokerId))
            .for("update");
          await tx
            .select({ id: platformAccounts.id })
            .from(platformAccounts)
            .where(eq(platformAccounts.brokerId, brokerId))
            .for("update");
          await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.brokerId, brokerId))
            .for("update");
          const own = ownedBy(tx, brokerId);
          const owned = await tx
            .select({
              publicationId: publications.id,
              status: publications.status,
              platform: publications.platform,
            })
            .from(publications)
            .where(subjectOf(tx, brokerId, publications))
            .for("update");
          const blocking = owned.filter(({ status }) => isPurgeBlockingStatus(status));
          if (blocking.length > 0) throw brokerHasActivePublications(blocking);

          const deleted: Record<string, number> = {};
          const note = (table: string, rows: readonly unknown[]) => {
            deleted[table] = rows.length;
          };
          const ofOwnPublications = tx
            .select({ id: publications.id })
            .from(publications)
            .where(subjectOf(tx, brokerId, publications));

          // 1. La bitácora y las publicaciones (referencian textos, cuentas y medios por id).
          note(
            "publication_events",
            await tx
              .delete(publicationEvents)
              .where(inArray(publicationEvents.publicationId, ofOwnPublications))
              .returning({ id: publicationEvents.id }),
          );
          note(
            "publications",
            await tx
              .delete(publications)
              .where(subjectOf(tx, brokerId, publications))
              .returning({ id: publications.id }),
          );
          // 2. Los textos y sus corridas.
          note(
            "contents",
            await tx
              .delete(contents)
              .where(subjectOf(tx, brokerId, contents))
              .returning({ id: contents.id }),
          );
          note(
            "content_runs",
            await tx
              .delete(contentRuns)
              .where(subjectOf(tx, brokerId, contentRuns))
              .returning({ id: contentRuns.id }),
          );
          // 3. Los medios (el logo los referencia: se suelta antes) y las subidas de los posts.
          await tx.update(brokers).set({ logoMediaId: null }).where(eq(brokers.id, brokerId));
          note(
            "media",
            await tx.delete(media).where(mediaOf(tx, brokerId)).returning({ id: media.id }),
          );
          note(
            "post_uploads",
            await tx
              .delete(postUploads)
              .where(inArray(postUploads.postId, own.postIds))
              .returning({ id: postUploads.id }),
          );
          // 4. Los pedidos de imágenes de los posts (F9.5-T25), los posts, sus planes y el perfil
          // editorial.
          note(
            "post_image_runs",
            await tx
              .delete(postImageRuns)
              .where(eq(postImageRuns.brokerId, brokerId))
              .returning({ id: postImageRuns.id }),
          );
          const deletedPosts = await tx
            .delete(posts)
            .where(eq(posts.brokerId, brokerId))
            .returning({ id: posts.id });
          note("posts", deletedPosts);
          note(
            "plan_runs",
            await tx
              .delete(planRuns)
              .where(eq(planRuns.brokerId, brokerId))
              .returning({ id: planRuns.id }),
          );
          note(
            "editorial_profiles",
            await tx
              .delete(editorialProfiles)
              .where(eq(editorialProfiles.brokerId, brokerId))
              .returning({ brokerId: editorialProfiles.brokerId }),
          );
          // 5. Las propiedades (los valores de sus campos van en `attributes`), las cuentas con sus
          // credenciales cifradas, los campos propios del corredor y sus cargas.
          note(
            "listings",
            await tx
              .delete(listings)
              .where(eq(listings.brokerId, brokerId))
              .returning({ id: listings.id }),
          );
          note(
            "platform_accounts",
            await tx
              .delete(platformAccounts)
              .where(eq(platformAccounts.brokerId, brokerId))
              .returning({ id: platformAccounts.id }),
          );
          note(
            "field_definitions",
            await tx
              .delete(fieldDefinitions)
              .where(eq(fieldDefinitions.brokerId, brokerId))
              .returning({ id: fieldDefinitions.id }),
          );
          const deletedImportRuns = await tx
            .delete(importRuns)
            .where(eq(importRuns.brokerId, brokerId))
            .returning({ id: importRuns.id });
          note("import_runs", deletedImportRuns);
          // 6. Los usuarios: sesiones, invitaciones, códigos de recuperación y desafíos se irían en
          // cascada; se borran a la vista para contarlos.
          note(
            "sessions",
            await tx
              .delete(sessions)
              .where(inArray(sessions.userId, own.userIds))
              .returning({ id: sessions.id }),
          );
          note(
            "invitations",
            await tx
              .delete(invitations)
              .where(inArray(invitations.userId, own.userIds))
              .returning({ id: invitations.id }),
          );
          note(
            "user_recovery_codes",
            await tx
              .delete(userRecoveryCodes)
              .where(inArray(userRecoveryCodes.userId, own.userIds))
              .returning({ id: userRecoveryCodes.id }),
          );
          note(
            "login_challenges",
            await tx
              .delete(loginChallenges)
              .where(inArray(loginChallenges.userId, own.userIds))
              .returning({ id: loginChallenges.id }),
          );
          note(
            "users",
            await tx.delete(users).where(eq(users.brokerId, brokerId)).returning({ id: users.id }),
          );
          // 7. El corredor.
          note(
            "brokers",
            await tx.delete(brokers).where(eq(brokers.id, brokerId)).returning({ id: brokers.id }),
          );
          // Los prefijos de R2 salen de lo que se borró de verdad (spec F9.5-T14).
          return {
            deleted,
            postIds: deletedPosts.map(({ id }) => id),
            importRunIds: deletedImportRuns.map(({ id }) => id),
          };
        }),
      );
    },
  };
}
