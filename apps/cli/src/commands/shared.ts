import { brokerListResponseSchema, listingListResponseSchema } from "@agentsales/api/contracts";
import { type Broker, slugify } from "@agentsales/core";
import { z } from "zod";
import { type ApiClient, unwrap } from "../api-client.js";
import { CliError } from "../output.js";

/** Lo que usan varios comandos. */

/** `--broker` como slug (`Mi-Corredor` → `mi-corredor`), igual que el que sale de la hoja. */
export function brokerSlugOf(broker: string): string {
  const slug = slugify(broker);
  if (slug === "") {
    throw new CliError("BROKER_INVALID", `--broker "${broker}" no tiene letras ni números`);
  }
  return slug;
}

/** Los corredores por id, para mostrar de quién es cada aviso. */
export async function fetchBrokers(client: ApiClient): Promise<Map<string, Broker>> {
  const { brokers } = await unwrap(client.brokers.$get(), brokerListResponseSchema);
  return new Map(brokers.map((broker) => [broker.id, broker]));
}

const isUuid = (text: string) => z.uuid().safeParse(text).success;

/**
 * El id del aviso: un uuid va directo; si no, es el `id_propiedad`, que es único por corredor
 * (spec F1-T12). Si está en más de un corredor, hace falta `--broker`. La usan `listing`,
 * `prepare` y `content`.
 */
export async function resolveListingId(
  client: ApiClient,
  ref: string,
  brokers: Map<string, Broker>,
  brokerOption: string | undefined,
): Promise<string> {
  if (isUuid(ref)) return ref;
  const { listings } = await unwrap(
    client.listings.$get({ query: { externalRef: ref } }),
    listingListResponseSchema,
  );
  let matches = listings;
  if (brokerOption !== undefined) {
    const slug = brokerSlugOf(brokerOption);
    const broker = [...brokers.values()].find((candidate) => candidate.slug === slug);
    if (broker === undefined) {
      throw new CliError("BROKER_NOT_FOUND", `No existe el corredor ${slug}`);
    }
    matches = listings.filter((listing) => listing.brokerId === broker.id);
  }
  const [first, ...others] = matches;
  if (first === undefined) {
    throw new CliError(
      "LISTING_NOT_FOUND",
      `No existe la propiedad ${ref}${brokerOption === undefined ? "" : ` en ese corredor`}`,
      "Revisa el código con agentsales listings",
    );
  }
  if (others.length > 0) {
    const slugs = matches.map((listing) => brokers.get(listing.brokerId)?.slug ?? listing.brokerId);
    throw new CliError(
      "LISTING_AMBIGUOUS",
      `${ref} existe en ${matches.length} corredores (${slugs.join(", ")})`,
      "Indica cuál con --broker <slug>",
    );
  }
  return first.id;
}
