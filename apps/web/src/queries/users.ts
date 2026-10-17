import {
  type UserLinkResponse,
  userLinkResponseSchema,
  userResponseSchema,
  usersResponseSchema,
} from "@agentsales/api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { brokerKeys } from "./brokers.js";

// Usuarios (F7-T18, solo el administrador). El enlace de invitación o de restablecer vuelve una
// sola vez: la página lo guarda en su estado para mostrarlo con su botón de copiar. Las mutaciones
// que lo traen no lo dejan en la caché (`gcTime: 0`, y la página las limpia con `reset()` en cuanto
// lo toma).

export const userKeys = { all: ["users"] as const };

/** `GET /users`. */
export function useUsers(enabled = true) {
  const client = useApiClient();
  return useQuery({
    queryKey: userKeys.all,
    enabled,
    queryFn: async ({ signal }) =>
      (await unwrap(client.users.$get(undefined, { init: { signal } }), usersResponseSchema)).users,
  });
}

/** Tras cambiar un usuario: la lista y la lista de alta de los corredores. */
function useRefreshUsers() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: userKeys.all });
    void queryClient.invalidateQueries({ queryKey: brokerKeys.all });
  };
}

/** `POST /users`: el usuario con su enlace (se muestra una vez). */
export function useInviteUser() {
  const client = useApiClient();
  const refresh = useRefreshUsers();
  return useMutation({
    mutationFn: async (input: {
      email: string;
      name: string;
      role: "admin" | "broker";
      brokerId: string | null;
    }): Promise<UserLinkResponse> =>
      unwrap(client.users.$post({ json: input }), userLinkResponseSchema),
    onSettled: refresh,
    gcTime: 0,
  });
}

/** `POST /users/:id/reset`: un enlace nuevo para elegir la contraseña (se muestra una vez). */
export function useResetUser() {
  const client = useApiClient();
  const refresh = useRefreshUsers();
  return useMutation({
    mutationFn: async (id: string): Promise<UserLinkResponse> =>
      unwrap(client.users[":id"].reset.$post({ param: { id } }), userLinkResponseSchema),
    onSettled: refresh,
    gcTime: 0,
  });
}

/** `POST /users/:id/disable` o `/enable`. */
export function useSetUserDisabled() {
  const client = useApiClient();
  const refresh = useRefreshUsers();
  return useMutation({
    mutationFn: async ({ id, disabled }: { id: string; disabled: boolean }) =>
      (
        await unwrap(
          (disabled ? client.users[":id"].disable : client.users[":id"].enable).$post({
            param: { id },
          }),
          userResponseSchema,
        )
      ).user,
    onSettled: refresh,
  });
}
