import {
  type BrokerView,
  brokerListResponseSchema,
  listingListResponseSchema,
} from "@agentsales/api/contracts";
import {
  type Broker,
  isListingPlatform,
  isPostPlatform,
  LANGUAGES,
  type Language,
  type ListingPlatform,
  MUSIC_TRACK_IDS,
  type MusicTrackId,
  manualConfirmCommands,
  musicTrackOf,
  PLATFORM_SHORT_NAMES,
  type Platform,
  type PlatformShortName,
  type PostPlatform,
  slugify,
} from "@agentsales/core";
import { z } from "zod";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import type { Terminal } from "../context.js";
import { CliError, type Io } from "../output.js";

/** Lo que usan varios comandos. */

const isShortName = (name: string): name is PlatformShortName =>
  Object.hasOwn(PLATFORM_SHORT_NAMES, name);

/** Todos los nombres cortos de `--platform`, también los de las redes de F9. */
const ALL_PLATFORM_OPTION_NAMES = Object.keys(PLATFORM_SHORT_NAMES).filter(isShortName);

/**
 * Los nombres cortos de `--platform` en los comandos de propiedades (`instagram`, `portal`,
 * `marketplace`): las redes de F9 son de los posts.
 */
export const PLATFORM_OPTION_NAMES: readonly string[] = ALL_PLATFORM_OPTION_NAMES.filter((name) =>
  isListingPlatform(PLATFORM_SHORT_NAMES[name]),
);

/**
 * `--platform portal` → `portal_inmobiliario` en los comandos de propiedades; `PLATFORM_INVALID` si
 * no es uno de sus nombres cortos (las redes de F9 tampoco: son de los posts).
 */
export function platformOption(option: string): ListingPlatform {
  const name = option.trim().toLowerCase();
  const platform = isShortName(name) ? PLATFORM_SHORT_NAMES[name] : null;
  if (platform === null || !isListingPlatform(platform)) {
    throw new CliError(
      "PLATFORM_INVALID",
      `--platform debe ser ${PLATFORM_OPTION_NAMES.join(", ")}: "${option}"`,
    );
  }
  return platform;
}

/** Los nombres de `--platform` en los comandos de posts (F9-T12): las redes de `POST_PLATFORMS`. */
export const POST_PLATFORM_OPTION_NAMES: readonly string[] = ALL_PLATFORM_OPTION_NAMES.filter(
  (name) => isPostPlatform(PLATFORM_SHORT_NAMES[name]),
);

/** `--platform discord` en los comandos de posts; `PLATFORM_INVALID` si no es una red de posts. */
export function postPlatformOption(option: string): PostPlatform {
  const name = option.trim().toLowerCase();
  const platform = isShortName(name) ? PLATFORM_SHORT_NAMES[name] : null;
  if (platform === null || !isPostPlatform(platform)) {
    throw new CliError(
      "PLATFORM_INVALID",
      `--platform debe ser ${POST_PLATFORM_OPTION_NAMES.join(", ")}: "${option}"`,
    );
  }
  return platform;
}

/** `--language es|en` (F9): el idioma de un texto de post. */
export function languageOption(option: string): Language {
  const language = option.trim().toLowerCase();
  const found = LANGUAGES.find((candidate) => candidate === language);
  if (found === undefined) {
    throw new CliError(
      "LANGUAGE_INVALID",
      `--language debe ser ${LANGUAGES.join(" o ")}: "${option}"`,
    );
  }
  return found;
}

/** `portal_inmobiliario` → `portal`: el nombre corto que acepta `--platform`. */
export function platformShortName(platform: Platform): PlatformShortName {
  const found = ALL_PLATFORM_OPTION_NAMES.find((name) => PLATFORM_SHORT_NAMES[name] === platform);
  if (found === undefined) throw new Error(`sin nombre corto para ${platform}`);
  return found;
}

/** `--broker` como slug (`Mi-Corredor` → `mi-corredor`), igual que el que sale de la hoja. */
export function brokerSlugOf(broker: string): string {
  const slug = slugify(broker);
  if (slug === "") {
    throw new CliError("BROKER_INVALID", `--broker "${broker}" no tiene letras ni números`);
  }
  return slug;
}

/** Los corredores por id, para mostrar de quién es cada aviso. */
export async function fetchBrokers(client: ApiClient): Promise<Map<string, BrokerView>> {
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

/**
 * Qué hacer con una publicación de Marketplace que espera el clic final (`MANUAL_CONFIRM_PENDING`,
 * `MARKETPLACE_FORM_OPEN`): los dos comandos para cerrarla, si la API dijo cuál es; si no, cómo
 * encontrarla.
 */
export function manualConfirmHint(publicationId: string | undefined): string {
  if (publicationId === undefined) {
    return "Mírala con agentsales publications <propiedad> y di si la publicaste (publications confirm) o no (publications not-published)";
  }
  const commands = manualConfirmCommands(publicationId);
  return `Si la publicaste: ${commands.confirm}\n    Si no: ${commands.notPublished}`;
}

/**
 * Pide sin confirmar y, si la API responde que falta confirmar (uno de `codes`, F6-T11), muestra su
 * motivo, pregunta y repite con `confirmed`. Con `yes` confirma de una. `null` si el operador dijo
 * que no (ya se le avisó cómo seguir): no se cambió nada.
 */
export async function withConfirmation<T>(
  deps: Io & Pick<Terminal, "confirm">,
  {
    yes = false,
    codes,
    call,
  }: { yes?: boolean; codes: readonly string[]; call: (confirmed: boolean) => Promise<T> },
): Promise<T | null> {
  if (yes) return call(true);
  try {
    return await call(false);
  } catch (error) {
    if (!(error instanceof ApiCallError) || !codes.includes(error.code ?? "")) throw error;
    const confirmed = await deps.confirm(`${error.apiMessage ?? error.message}. ¿Seguir?`);
    if (!confirmed) {
      deps.printError(deps.colors.yellow("No se cambió nada: confirma en la terminal o usa --yes"));
      return null;
    }
    return call(true);
  }
}

/** Lo que se escribe para «sin música» (`listing music`, `post edit --music`). */
export const NO_MUSIC_WORD = "ninguna";

/**
 * La pista que escribió el operador: un id del catálogo, o `ninguna` (sin música). Otra cosa es
 * `MUSIC_TRACK_INVALID`, con la lista de pistas (F9.5-T19).
 */
export function parseMusicTrack(value: string): MusicTrackId | null {
  const word = value.trim().toLowerCase();
  if (word === NO_MUSIC_WORD) return null;
  const track = musicTrackOf(word);
  if (track === null) {
    throw new CliError(
      "MUSIC_TRACK_INVALID",
      `No existe la pista «${value.trim()}». Elige una de: ${MUSIC_TRACK_IDS.join(", ")}, o ${NO_MUSIC_WORD}`,
    );
  }
  return track.id;
}
