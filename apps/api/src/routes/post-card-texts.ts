import {
  getPostCardTexts,
  type PostCardTextsDeps,
  type PostLinkedInPdfDeps,
  postLinkedInPdf,
  savePostCardTexts,
} from "@agentsales/core";
import { Hono } from "hono";
import { type AppEnv, requireAuth } from "../auth.js";
import {
  idParamSchema,
  type PostCardTextsResponse,
  postCardTextsBodySchema,
  postCardTextsParamSchema,
  postLinkedInPdfQuerySchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";

/**
 * Los textos de las láminas de un post (spec F9.7 B5, ADR-0043): `GET /posts/:id/card-texts` (con
 * su revisión) y `PUT /posts/:id/card-texts/:language` (el operador los edita; `posts.manage`).
 */
export function postCardTextRoutes(deps: PostCardTextsDeps & PostLinkedInPdfDeps) {
  return (
    new Hono<AppEnv>()
      .get("/:id/card-texts", validated("param", idParamSchema), async (c) => {
        const body: PostCardTextsResponse = await getPostCardTexts(
          deps,
          requireAuth(c).user,
          c.req.valid("param").id,
        );
        return c.json(body, 200);
      })
      .put(
        "/:id/card-texts/:language",
        validated("param", postCardTextsParamSchema),
        validated("json", postCardTextsBodySchema),
        async (c) => {
          const { id, language } = c.req.valid("param");
          const body: PostCardTextsResponse = await savePostCardTexts(
            deps,
            requireAuth(c).user,
            id,
            language,
            c.req.valid("json").texts,
          );
          return c.json(body, 200);
        },
      )
      // F9.7 B7: las láminas de un idioma unidas en un PDF para LinkedIn.
      .get(
        "/:id/linkedin-pdf",
        validated("param", idParamSchema),
        validated("query", postLinkedInPdfQuerySchema),
        async (c) => {
          const { pdf, pages, skipped } = await postLinkedInPdf(
            deps,
            requireAuth(c).user,
            c.req.valid("param").id,
            c.req.valid("query").language,
          );
          return c.body(new Uint8Array(pdf), 200, {
            "content-type": "application/pdf",
            "content-disposition": `attachment; filename="carrusel-${c.req.valid("query").language}.pdf"`,
            "cache-control": "no-store",
            "x-agentsales-pages": String(pages),
            "x-agentsales-skipped": String(skipped),
          });
        },
      )
  );
}
