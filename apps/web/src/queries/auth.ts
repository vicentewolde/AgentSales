import {
  type LoginStepResponse,
  loginResponseSchema,
  loginStepResponseSchema,
  meResponseSchema,
  type TotpConfirmResponse,
  type TotpSetupResponse,
  totpConfirmResponseSchema,
  totpSetupResponseSchema,
  totpStatusResponseSchema,
} from "@agentsales/api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { clearAllOneTimeLinks } from "../components/brokers/one-time-link-store.js";

// Entrar, salir y quién soy en el panel (spec F7 §4.11, ADR-0021). La sesión va en una cookie
// `HttpOnly`: el panel nunca ve el token.

export const authKeys = { me: ["auth", "me"] as const, totp: ["auth", "totp"] as const };

/** El usuario de la sesión. Sin sesión, la consulta falla con `AUTH_REQUIRED` (y no reintenta). */
export function useMe() {
  const client = useApiClient();
  return useQuery({
    queryKey: authKeys.me,
    queryFn: async ({ signal }) =>
      (await unwrap(client.auth.me.$get(undefined, { init: { signal } }), meResponseSchema)).user,
    staleTime: 60_000,
  });
}

/**
 * `POST /auth/login`: al entrar, todo lo que se pidió sin sesión se vuelve a pedir. Con el doble
 * factor (F8-T16) responde el segundo paso (`totpRequired`) y la sesión todavía no existe; el
 * desafío no queda en la caché (`gcTime: 0`: la página lo pasa a su estado).
 */
export function useLogin() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; password: string }): Promise<LoginStepResponse> =>
      unwrap(client.auth.login.$post({ json: input }), loginStepResponseSchema),
    onSuccess: (result) => {
      // Entra otro usuario (o el mismo de nuevo): los enlaces guardados de la sesión anterior se van.
      clearAllOneTimeLinks();
      if (!("totpRequired" in result)) void queryClient.resetQueries();
    },
    gcTime: 0,
  });
}

/** `POST /auth/login/totp`: el segundo paso con el código de la app (o uno de recuperación). */
export function useLoginTotp() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { challenge: string; code: string }) =>
      (await unwrap(client.auth.login.totp.$post({ json: input }), loginResponseSchema)).user,
    onSuccess: () => {
      clearAllOneTimeLinks();
      return queryClient.resetQueries();
    },
    gcTime: 0,
  });
}

/** `GET /auth/totp`: si el doble factor está activo y cuántos códigos de recuperación quedan. */
export function useTotpStatus() {
  const client = useApiClient();
  return useQuery({
    queryKey: authKeys.totp,
    queryFn: async ({ signal }) =>
      unwrap(client.auth.totp.$get(undefined, { init: { signal } }), totpStatusResponseSchema),
  });
}

/**
 * Activar y desactivar el doble factor (F8-T16). La clave y los códigos de recuperación vuelven
 * una sola vez: la página los pasa a su estado y limpia la mutación (`gcTime: 0` y `reset()`), así
 * no quedan en la caché del panel.
 */
export function useStartTotp() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (): Promise<TotpSetupResponse> =>
      unwrap(client.auth.totp.setup.$post(), totpSetupResponseSchema),
    gcTime: 0,
  });
}

export function useConfirmTotp() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string): Promise<TotpConfirmResponse> =>
      unwrap(client.auth.totp.confirm.$post({ json: { code } }), totpConfirmResponseSchema),
    onSuccess: (result) => {
      // El estado nuevo de una vez (sin mostrar "Activar" mientras llega); solo la cuenta, nunca
      // los códigos.
      queryClient.setQueryData(authKeys.totp, {
        enabled: true,
        recoveryCodesLeft: result.recoveryCodes.length,
      });
      void queryClient.invalidateQueries({ queryKey: authKeys.totp });
      void queryClient.invalidateQueries({ queryKey: authKeys.me });
    },
    gcTime: 0,
  });
}

export function useDisableTotp() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const response = await client.auth.totp.disable.$post({ json: { code } });
      // 204 sin cuerpo; un error trae su código y su mensaje.
      if (!response.ok) await unwrap(response, totpStatusResponseSchema);
    },
    onSuccess: () => {
      queryClient.setQueryData(authKeys.totp, { enabled: false, recoveryCodesLeft: 0 });
      void queryClient.invalidateQueries({ queryKey: authKeys.totp });
      void queryClient.invalidateQueries({ queryKey: authKeys.me });
    },
  });
}

/** `POST /auth/invitations/accept`: elegir la contraseña con el enlace abre la sesión. */
export function useAcceptInvitation() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { token: string; password: string }) =>
      (await unwrap(client.auth.invitations.accept.$post({ json: input }), loginResponseSchema))
        .user,
    onSuccess: () => {
      clearAllOneTimeLinks();
      return queryClient.resetQueries();
    },
  });
}

/** `POST /auth/logout`: borra la sesión y todo lo guardado de ella. */
export function useLogout() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    // 204, o 401 si la sesión ya no valía: en los dos casos queda fuera.
    mutationFn: async () => {
      await client.auth.logout.$post();
    },
    onSuccess: () => {
      // Los enlaces de invitación guardados en esta pestaña son secretos del administrador.
      clearAllOneTimeLinks();
      queryClient.clear();
    },
  });
}
