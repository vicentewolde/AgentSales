import {
  type BrokerDetailResponse,
  brokerDetailResponseSchema,
  brokerListResponseSchema,
  brokerResponseSchema,
  brokerTemplateDraftResponseSchema,
} from "@agentsales/api/contracts";
import { effectivePublishMode, type PublishMode, type PublishModeBroker } from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiClient, unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { healthKeys, useHealth } from "./health.js";
import { trackingKeys } from "./tracking.js";

export const brokerKeys = {
  all: ["brokers"] as const,
  detail: (id: string) => [...brokerKeys.all, "detail", id] as const,
};

/** `GET /brokers` (con el alcance de la sesión). */
export const fetchBrokerList = async (client: ApiClient, signal?: AbortSignal) =>
  (await unwrap(client.brokers.$get(undefined, { init: { signal } }), brokerListResponseSchema))
    .brokers;

/** Los corredores, para el selector de Importar y Cuentas. */
export function useBrokers() {
  const client = useApiClient();
  return useQuery({
    queryKey: brokerKeys.all,
    queryFn: ({ signal }) => fetchBrokerList(client, signal),
  });
}

/**
 * El modo con que publicaría hoy la marca `brokerId` (F9.5-T22, ADR-0036): el del servidor de
 * `/health` con la llave de la marca (`effectivePublishMode`). `undefined` si no se sabe: con el
 * servidor en vivo y sin marca (por ejemplo, «Todos» en una lista de varias) o con la marca sin
 * cargar, no se dice ni «simulación» ni «en vivo» (y las preguntas de «¿en vivo?» preguntan igual).
 * Con el servidor en simulación, siempre `dry-run`.
 */
export function publishModeOf(
  server: PublishMode | undefined,
  brokers: readonly (PublishModeBroker & { id: string })[] | undefined,
  brokerId: string | null | undefined,
): PublishMode | undefined {
  if (server === undefined) return undefined;
  const broker =
    brokerId === null || brokerId === undefined
      ? undefined
      : brokers?.find((item) => item.id === brokerId);
  if (broker !== undefined) return effectivePublishMode(server, broker);
  return server === "dry-run" ? "dry-run" : undefined;
}

/** `publishModeOf` para una marca, con `/health` y `GET /brokers` en caché. */
export function useBrokerPublishMode(brokerId: string | null | undefined) {
  const modeOf = useBrokerModeOf();
  return modeOf(brokerId);
}

/** `publishModeOf` para listas con varias marcas (Hoy, Seguimiento, Calendario). */
export function useBrokerModeOf() {
  const server = useHealth().data?.publishMode;
  const brokers = useBrokers().data;
  return (brokerId: string | null | undefined) => publishModeOf(server, brokers, brokerId);
}

/**
 * `PATCH /brokers/:id { autoPublish }` (spec F6 §4.10). Al terminar se vuelven a pedir los
 * corredores, `/health` (el aviso en rojo de `auto_publish` en vivo) y la agenda.
 */
export function useSetAutoPublish() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, autoPublish }: { id: string; autoPublish: boolean }) =>
      (
        await unwrap(
          client.brokers[":id"].$patch({ param: { id }, json: { autoPublish } }),
          brokerResponseSchema,
        )
      ).broker,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: brokerKeys.all });
      void queryClient.invalidateQueries({ queryKey: healthKeys.all });
      void queryClient.invalidateQueries({ queryKey: trackingKeys.all });
    },
  });
}

/** `GET /brokers/:id`: el corredor y su lista de alta (F7-T18). */
export function useBrokerDetail(id: string | undefined, enabled = true) {
  const client = useApiClient();
  return useQuery({
    queryKey: brokerKeys.detail(id ?? ""),
    enabled: enabled && id !== undefined,
    queryFn: async ({ signal }): Promise<BrokerDetailResponse> =>
      unwrap(
        client.brokers[":id"].$get({ param: { id: id ?? "" } }, { init: { signal } }),
        brokerDetailResponseSchema,
      ),
  });
}

/** Lo que se manda al crear o editar: la marca y, solo el administrador, los ajustes. */
export type BrokerFields = {
  name?: string;
  brandName?: string;
  primaryColor?: string;
  secondaryColor?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  instagramHandle?: string | null;
  website?: string | null;
  tone?: string | null;
  fixedHashtags?: string[];
  operatorOwned?: boolean;
  llmMonthlyCapUsd?: number | null;
  /** F9.5-T22 (ADR-0036): el modo en vivo de la marca; encender exige `liveConfirm` (el slug). */
  liveEnabled?: boolean;
  liveConfirm?: string;
};

/** `POST /brokers` (administrador). */
export function useCreateBroker() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      fields: BrokerFields & {
        slug: string;
        name: string;
        brandName: string;
        primaryColor: string;
        /** `brand`: una marca que solo publica posts (F9); no se cambia después. */
        kind?: "broker" | "brand";
      },
    ) => unwrap(client.brokers.$post({ json: fields }), brokerDetailResponseSchema),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: brokerKeys.all }),
  });
}

/**
 * `POST /brokers/parse-template` (administrador, F9.5-T16): lee la hoja Corredor de una planilla y
 * devuelve sus datos para llenar el formulario de crear un corredor. No guarda nada.
 */
export function useParseBrokerTemplate() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (file: File) =>
      (
        await unwrap(
          client.brokers["parse-template"].$post({ form: { file } }),
          brokerTemplateDraftResponseSchema,
        )
      ).draft,
  });
}

/** `PATCH /brokers/:id`: la marca (el corredor, la suya) y los ajustes del administrador. */
export function useUpdateBroker(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fields: BrokerFields) =>
      unwrap(
        client.brokers[":id"].$patch({ param: { id }, json: fields }),
        brokerDetailResponseSchema,
      ),
    onSuccess: (detail) => {
      queryClient.setQueryData(brokerKeys.detail(id), detail);
      void queryClient.invalidateQueries({ queryKey: brokerKeys.all });
      // El banner y el estado leen las marcas en vivo de `/health` (F9.5-T22).
      void queryClient.invalidateQueries({ queryKey: healthKeys.all });
    },
  });
}

/** `POST /brokers/:id/logo` (multipart): PNG, JPEG o WebP de hasta 5 MB. */
export function useUploadLogo(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (logo: File) =>
      (
        await unwrap(
          client.brokers[":id"].logo.$post({ param: { id }, form: { logo } }),
          brokerResponseSchema,
        )
      ).broker,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: brokerKeys.all }),
  });
}

/**
 * La planilla del corredor: un enlace directo (la cookie de la sesión viaja con él). El cliente del
 * panel usa una base relativa (`/api`, el proxy de Vite) que `$url` no sabe armar: la base vive aquí
 * y en `main.tsx` (F8 la cambia en los dos).
 */
export function useBrokerTemplateHref(id: string): string {
  return `/api/brokers/${encodeURIComponent(id)}/template.xlsx`;
}
