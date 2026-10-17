import type { Broker } from "../broker.js";
import { AppError } from "../errors.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { LogoNormalizer } from "../ports/logo-normalizer.js";
import type { MediaRepository } from "../ports/media-repository.js";
import type { MediaStorage } from "../ports/media-storage.js";

/** El logo más grande que se acepta (spec F7 §4.6). */
export const MAX_LOGO_BYTES = 5 * 1024 * 1024;

export type SetBrokerLogoDeps = {
  brokers: Pick<BrokerRepository, "findById" | "setLogo">;
  media: Pick<MediaRepository, "findByStoragePath" | "create">;
  storage: Pick<MediaStorage, "put">;
  logos: LogoNormalizer;
  /** sha256 hexadecimal de unos bytes (core no usa `node:crypto`). */
  sha256Bytes: (bytes: Uint8Array) => string;
};

/**
 * Sube el logo de un corredor (spec F7 §4.6): lo normaliza a PNG, lo guarda en R2 como un medio
 * del corredor (`brokers/<id>/brand/<sha256>.png`, como el de la hoja Corredor) y lo fija en
 * `brokers.logo_media_id`. Subir el mismo logo otra vez no duplica nada. Más de `MAX_LOGO_BYTES`
 * es `REQUEST_TOO_LARGE` (413); una imagen que no sirve, `LOGO_INVALID` (415). Lo ya preparado no
 * se rehace: el panel sugiere preparar de nuevo solo las imágenes.
 */
export async function setBrokerLogo(
  deps: SetBrokerLogoDeps,
  input: { brokerId: string; bytes: Uint8Array },
): Promise<Broker> {
  if (input.bytes.byteLength > MAX_LOGO_BYTES) {
    throw new AppError("REQUEST_TOO_LARGE", "El logo pasa de 5 MB");
  }
  const broker = await deps.brokers.findById(input.brokerId);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${input.brokerId}`);
  }
  const logo = await deps.logos.normalize(input.bytes);
  const checksum = deps.sha256Bytes(logo.bytes);
  const storagePath = `brokers/${broker.id}/brand/${checksum}.png`;
  let record = await deps.media.findByStoragePath(storagePath);
  if (record === null) {
    await deps.storage.put(storagePath, logo.bytes, "image/png");
    record = await deps.media.create({
      listingId: null,
      brokerId: broker.id,
      kind: "image",
      storagePath,
      mime: "image/png",
      bytes: logo.bytes.byteLength,
      checksum,
      sortOrder: 0,
      isCover: false,
    });
  }
  await deps.brokers.setLogo(broker.id, record.id);
  return { ...broker, logoMediaId: record.id };
}
