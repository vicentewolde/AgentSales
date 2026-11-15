import { type PostCardTextsBody, postCardTextsResponseSchema } from "@agentsales/api/contracts";
import type { Language } from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";

// Los textos de las láminas de un post (spec F9.7 B5).

export const cardTextKeys = {
  all: ["post-card-texts"] as const,
  post: (postId: string) => [...cardTextKeys.all, postId] as const,
};

export function usePostCardTexts(postId: string, enabled = true) {
  const client = useApiClient();
  return useQuery({
    queryKey: cardTextKeys.post(postId),
    enabled,
    queryFn: ({ signal }) =>
      unwrap(
        client.posts[":id"]["card-texts"].$get({ param: { id: postId } }, { init: { signal } }),
        postCardTextsResponseSchema,
      ),
  });
}

export function useSavePostCardTexts(postId: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ language, texts }: { language: Language; texts: PostCardTextsBody["texts"] }) =>
      unwrap(
        client.posts[":id"]["card-texts"][":language"].$put({
          param: { id: postId, language },
          json: { texts },
        }),
        postCardTextsResponseSchema,
      ),
    onSuccess: (data) => queryClient.setQueryData(cardTextKeys.post(postId), data),
  });
}
