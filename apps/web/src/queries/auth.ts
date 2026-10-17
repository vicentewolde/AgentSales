import { loginResponseSchema, meResponseSchema } from "@agentsales/api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";

// Entrar, salir y quién soy en el panel (spec F7 §4.11, ADR-0021). La sesión va en una cookie
// `HttpOnly`: el panel nunca ve el token.

export const authKeys = { me: ["auth", "me"] as const };

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

/** `POST /auth/login`: al entrar, todo lo que se pidió sin sesión se vuelve a pedir. */
export function useLogin() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; password: string }) =>
      (await unwrap(client.auth.login.$post({ json: input }), loginResponseSchema)).user,
    onSuccess: () => queryClient.resetQueries(),
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
    onSuccess: () => queryClient.resetQueries(),
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
    onSuccess: () => queryClient.clear(),
  });
}
