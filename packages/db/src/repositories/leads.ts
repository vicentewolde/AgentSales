import {
  AppError,
  type Lead,
  type LeadRepository,
  leadConsentSchema,
  type SecretBox,
} from "@agentsales/core";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SchemaDatabase } from "../client.js";
import { isUniqueViolation, sqlStateOf, withDbErrors } from "../errors.js";
import { leadEvents, leads } from "../schema.js";

const aad = (id: string) => `lead:${id}`;

/** `LeadRepository` sobre Drizzle (F10-T01): los datos personales se guardan cifrados. */
export function createLeadRepository(db: SchemaDatabase, box: SecretBox): LeadRepository {
  const open = (id: string, value: string | null): string | null =>
    value === null ? null : box.decrypt(value, aad(id));

  function toLead(row: typeof leads.$inferSelect): Lead {
    const consent = leadConsentSchema.safeParse(row.consent);
    if (!consent.success) {
      throw new AppError("LEAD_ROW_INVALID", `El lead ${row.id} tiene datos inválidos`, {
        details: { id: row.id },
      });
    }
    return {
      id: row.id,
      brokerId: row.brokerId,
      source: row.source,
      externalId: row.externalId,
      listingId: row.listingId,
      adId: row.adId,
      campaign: row.campaign,
      name: open(row.id, row.nameEncrypted),
      phone: open(row.id, row.phoneEncrypted),
      email: open(row.id, row.emailEncrypted),
      consent: consent.data,
      status: row.status,
      assignedTo: row.assignedTo,
      erasedAt: row.erasedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  const seal = (id: string, value: string | null): string | null =>
    value === null ? null : box.encrypt(value, aad(id));

  return {
    async create(input) {
      const id = crypto.randomUUID();
      try {
        return await withDbErrors(async () => {
          const [row] = await db
            .insert(leads)
            .values({
              id,
              brokerId: input.brokerId,
              source: input.source,
              externalId: input.externalId,
              listingId: input.listingId,
              adId: input.adId,
              campaign: input.campaign,
              nameEncrypted: seal(id, input.name),
              phoneEncrypted: seal(id, input.phone),
              emailEncrypted: seal(id, input.email),
              consent: input.consent,
            })
            .returning();
          if (row === undefined) throw new AppError("LEAD_WRITE_FAILED", "No se guardó el lead");
          await db
            .insert(leadEvents)
            .values({ leadId: id, kind: "received", data: { source: input.source } });
          return { lead: toLead(row), created: true };
        });
      } catch (error) {
        if (isUniqueViolation(error, "leads_broker_source_external_unique")) {
          const [existing] = await db
            .select()
            .from(leads)
            .where(
              and(
                eq(leads.brokerId, input.brokerId),
                eq(leads.source, input.source),
                eq(leads.externalId, input.externalId),
              ),
            );
          if (existing !== undefined) return { lead: toLead(existing), created: false };
        }
        if (sqlStateOf(error) === "23503") {
          throw new AppError("LEAD_REFERENCE_INVALID", "El corredor o la propiedad no existe", {
            cause: error,
          });
        }
        throw error;
      }
    },

    get(id) {
      return withDbErrors(async () => {
        const [row] = await db.select().from(leads).where(eq(leads.id, id));
        return row === undefined ? null : toLead(row);
      });
    },

    list(filters, limit) {
      return withDbErrors(async () => {
        const rows = await db
          .select()
          .from(leads)
          .where(
            and(
              eq(leads.brokerId, filters.brokerId),
              filters.status ? eq(leads.status, filters.status) : undefined,
              filters.listingId ? eq(leads.listingId, filters.listingId) : undefined,
            ),
          )
          .orderBy(desc(leads.createdAt))
          .limit(limit);
        return rows.map(toLead);
      });
    },

    setStatus(id, from, to) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(leads)
          .set({ status: to })
          .where(and(eq(leads.id, id), eq(leads.status, from)))
          .returning();
        if (row === undefined) return null;
        await db.insert(leadEvents).values({ leadId: id, kind: "status", data: { from, to } });
        return toLead(row);
      });
    },

    assign(id, userId) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(leads)
          .set({ assignedTo: userId })
          .where(eq(leads.id, id))
          .returning();
        if (row === undefined) return null;
        await db.insert(leadEvents).values({ leadId: id, kind: "assigned", data: { userId } });
        return toLead(row);
      });
    },

    erase(id) {
      return withDbErrors(async () => {
        const [row] = await db
          .update(leads)
          .set({
            nameEncrypted: null,
            phoneEncrypted: null,
            emailEncrypted: null,
            erasedAt: sql`COALESCE(${leads.erasedAt}, now())`,
          })
          .where(eq(leads.id, id))
          .returning();
        if (row === undefined) return null;
        await db.insert(leadEvents).values({ leadId: id, kind: "erased", data: null });
        return toLead(row);
      });
    },
  };
}
