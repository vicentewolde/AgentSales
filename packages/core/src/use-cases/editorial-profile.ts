import { inScope } from "../access.js";
import {
  type EditorialProfileInput,
  type EditorialProfileView,
  editorialProfileView,
  normalizeEditorialProfile,
} from "../editorial-profile.js";
import { AppError } from "../errors.js";
import { assertCan, type Permission, scopeOf } from "../permissions.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import type { User } from "../user.js";

// El perfil editorial de una marca (spec F9 §4.3 y §4.10, F9-T09). Sin permiso nuevo (revisión del
// arquitecto): leer es `broker.view` y editar es `brand.edit`, como la marca del corredor. El
// corredor del perfil es siempre el de la ruta ya verificada, nunca uno que venga en el cuerpo.

type Actor = Pick<User, "role" | "brokerId">;

/**
 * El corredor del perfil, con el alcance de ADR-0022: lo de otro corredor no existe
 * (`BROKER_NOT_FOUND`, el mismo error que un id que no existe); lo suyo sin el permiso es
 * `FORBIDDEN` (403).
 */
async function brokerFor(
  brokers: Pick<BrokerRepository, "findById">,
  actor: Actor,
  brokerId: string,
  permission: Permission,
): Promise<void> {
  const notFound = () =>
    new AppError("BROKER_NOT_FOUND", `No existe el corredor ${brokerId}`, {
      details: { id: brokerId },
    });
  if (!inScope(scopeOf(actor), brokerId)) throw notFound();
  assertCan(actor, permission, brokerId);
  if ((await brokers.findById(brokerId)) === null) throw notFound();
}

/**
 * El perfil editorial del corredor (`broker.view`). Uno que todavía no tiene perfil recibe el
 * vacío por defecto (`updatedAt: null`), no un 404: así el panel y la CLI muestran un formulario
 * para llenarlo. `BROKER_NOT_FOUND` si el corredor no existe o es de otro.
 */
export async function getEditorialProfile(
  deps: {
    brokers: Pick<BrokerRepository, "findById">;
    editorialProfiles: Pick<EditorialProfileRepository, "get">;
  },
  actor: Actor,
  brokerId: string,
): Promise<EditorialProfileView> {
  await brokerFor(deps.brokers, actor, brokerId, "broker.view");
  return editorialProfileView(brokerId, await deps.editorialProfiles.get(brokerId));
}

/**
 * Guarda el perfil completo del corredor (`brand.edit`: el administrador o el usuario de ese
 * corredor), validado y normalizado con `normalizeEditorialProfile` antes de escribir
 * (`EDITORIAL_PROFILE_INVALID`, 400, sin cambiar nada). Reemplaza el anterior: lo que no viene,
 * queda vacío (la CLI lee el vigente y combina antes de mandar). El permiso se revisa antes de
 * validar: un corredor ajeno recibe 404 aunque el perfil sea inválido.
 */
export async function saveEditorialProfile(
  deps: {
    brokers: Pick<BrokerRepository, "findById">;
    editorialProfiles: Pick<EditorialProfileRepository, "upsert">;
  },
  actor: Actor,
  brokerId: string,
  input: EditorialProfileInput,
): Promise<EditorialProfileView> {
  await brokerFor(deps.brokers, actor, brokerId, "brand.edit");
  const data = normalizeEditorialProfile(input);
  return editorialProfileView(brokerId, await deps.editorialProfiles.upsert(brokerId, data));
}
