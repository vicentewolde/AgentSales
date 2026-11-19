import {
  type AcceptProposalBody,
  acceptProposalResponseSchema,
  type BrandKnowledgeBody,
  brandKnowledgeResponseSchema,
  discardProposalResponseSchema,
  type KnowledgeUpdateBody,
  knowledgeProposalsResponseSchema,
  knowledgeRunResponseSchema,
  knowledgeUpdateResponseSchema,
} from "@agentsales/api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { postKeys } from "./posts.js";

// El conocimiento de la marca (spec F9.7 B1 y B2, ADR-0043): postura, tono, ejemplos, novedades y
// las propuestas de la IA desde un texto. Las reglas son de core; aquí solo se piden y se refrescan.

export const knowledgeKeys = {
  all: ["brand-knowledge"] as const,
  knowledge: (brokerId: string) => [...knowledgeKeys.all, "knowledge", brokerId] as const,
  proposals: (brokerId: string) => [...knowledgeKeys.all, "proposals", brokerId] as const,
};

export function useBrandKnowledge(brokerId: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: knowledgeKeys.knowledge(brokerId),
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.brokers[":id"].knowledge.$get({ param: { id: brokerId } }, { init: { signal } }),
          brandKnowledgeResponseSchema,
        )
      ).knowledge,
  });
}

/** Refresca el conocimiento, las propuestas y el perfil editorial (un hecho aceptado lo cambia). */
function useRefresh(brokerId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.knowledge(brokerId) });
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.proposals(brokerId) });
    void queryClient.invalidateQueries({ queryKey: postKeys.all });
  };
}

export function useSaveBrandKnowledge(brokerId: string) {
  const client = useApiClient();
  const refresh = useRefresh(brokerId);
  return useMutation({
    mutationFn: (json: BrandKnowledgeBody) =>
      unwrap(
        client.brokers[":id"].knowledge.$put({ param: { id: brokerId }, json }),
        brandKnowledgeResponseSchema,
      ),
    onSuccess: refresh,
  });
}

export function useAddKnowledgeUpdate(brokerId: string) {
  const client = useApiClient();
  const refresh = useRefresh(brokerId);
  return useMutation({
    mutationFn: (json: KnowledgeUpdateBody) =>
      unwrap(
        client.brokers[":id"].knowledge.updates.$post({ param: { id: brokerId }, json }),
        knowledgeUpdateResponseSchema,
      ),
    onSuccess: refresh,
  });
}

export function useArchiveKnowledgeUpdate(brokerId: string) {
  const client = useApiClient();
  const refresh = useRefresh(brokerId);
  return useMutation({
    mutationFn: (updateId: string) =>
      unwrap(
        client.brokers[":id"].knowledge.updates[":updateId"].$delete({
          param: { id: brokerId, updateId },
        }),
        knowledgeUpdateResponseSchema,
      ),
    onSuccess: refresh,
  });
}

/** Las lecturas recientes y las propuestas pendientes; mientras una lectura corre, se sondea. */
export function useKnowledgeProposals(brokerId: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: knowledgeKeys.proposals(brokerId),
    queryFn: ({ signal }) =>
      unwrap(
        client.brokers[":id"].knowledge.proposals.$get(
          { param: { id: brokerId } },
          { init: { signal } },
        ),
        knowledgeProposalsResponseSchema,
      ),
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === "queued" || run.status === "running")
        ? 2000
        : false,
  });
}

export function useRequestProposals(brokerId: string) {
  const client = useApiClient();
  const refresh = useRefresh(brokerId);
  return useMutation({
    mutationFn: (text: string) =>
      unwrap(
        client.brokers[":id"].knowledge.proposals.$post({
          param: { id: brokerId },
          json: { text },
        }),
        knowledgeRunResponseSchema,
      ),
    onSuccess: refresh,
  });
}

export function useAcceptProposal(brokerId: string) {
  const client = useApiClient();
  const refresh = useRefresh(brokerId);
  return useMutation({
    mutationFn: ({ proposalId, json }: { proposalId: string; json: AcceptProposalBody }) =>
      unwrap(
        client.brokers[":id"].knowledge.proposals[":proposalId"].accept.$post({
          param: { id: brokerId, proposalId },
          json,
        }),
        acceptProposalResponseSchema,
      ),
    onSuccess: refresh,
  });
}

export function useDiscardProposal(brokerId: string) {
  const client = useApiClient();
  const refresh = useRefresh(brokerId);
  return useMutation({
    mutationFn: (proposalId: string) =>
      unwrap(
        client.brokers[":id"].knowledge.proposals[":proposalId"].discard.$post({
          param: { id: brokerId, proposalId },
        }),
        discardProposalResponseSchema,
      ),
    onSuccess: refresh,
  });
}
