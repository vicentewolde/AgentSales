import { z } from "zod";
import { MERCADOLIBRE_API_ORIGIN, MERCADOLIBRE_REQUEST_TIMEOUT_MS } from "./constants.js";
import { MERCADOLIBRE_ERRORS } from "./errors.js";
import {
  type MercadoLibreCallOptions,
  type MercadoLibreHttpOptions,
  mercadoLibreRequest,
} from "./http.js";

/**
 * Un usuario de prueba recién creado (nota §8 punto 2, doc leída el 2026-10-09). `password` sale
 * **una sola vez**: quien llama la entrega al operador sin imprimirla, loguearla ni guardarla.
 */
export type MercadoLibreTestUser = {
  id: string;
  nickname: string;
  password: string;
  siteStatus: string | null;
};

/**
 * Usuarios de prueba de Mercado Libre (spec F4-T25): `POST /users/test_user` con el token de la
 * cuenta real (OAuth). Errores: los `ML_*` de `mercadoLibreRequest`; una respuesta que no calza es
 * `ML_UNEXPECTED_RESPONSE` sin el cuerpo (traería la clave).
 */
export interface MercadoLibreTestUsers {
  create(
    accessToken: string,
    siteId: "MLC",
    options?: MercadoLibreCallOptions,
  ): Promise<MercadoLibreTestUser>;
}

const testUserSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d{1,20}$/)]).transform(String),
  nickname: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
  site_status: z.string().max(50).nullish(),
});

export function createMercadoLibreTestUsers(
  options: MercadoLibreHttpOptions = {},
): MercadoLibreTestUsers {
  const origin = options.origin ?? MERCADOLIBRE_API_ORIGIN;
  const timeoutMs = options.timeoutMs ?? MERCADOLIBRE_REQUEST_TIMEOUT_MS;
  return {
    async create(accessToken, siteId, { signal } = {}) {
      const body = await mercadoLibreRequest(
        "createTestUser",
        new URL("/users/test_user", origin),
        { method: "POST", accessToken, body: { json: { site_id: siteId } } },
        { signal, timeoutMs },
      );
      const parsed = testUserSchema.safeParse(body);
      // Nunca el cuerpo ni el detalle de zod en el error: traen la clave.
      if (!parsed.success) throw MERCADOLIBRE_ERRORS.unexpectedResponse("createTestUser");
      return {
        id: parsed.data.id,
        nickname: parsed.data.nickname,
        password: parsed.data.password,
        siteStatus: parsed.data.site_status ?? null,
      };
    },
  };
}
