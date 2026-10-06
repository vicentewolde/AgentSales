import type { ContentView, ListingPublicationView } from "@agentsales/api/contracts";
import {
  ACTIVE_PUBLICATION_STATUSES,
  type ListingStatus,
  PUBLICATION_FORMAT_TEXT,
  type PublishMode,
} from "@agentsales/core";
import { useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client.js";
import { usePublishListing } from "../../queries/publications.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { PublicationItem } from "./PublicationItem.js";
import { publishBlockedReason } from "./publications.js";

const PRIMARY =
  "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";
const DANGER =
  "rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";

const shown = new Set<string>([...ACTIVE_PUBLICATION_STATUSES, "failed"]);

/**
 * Las publicaciones de Instagram de un aviso (spec F3 §4.9): Publicar el canal (en vivo, con
 * confirmación) y cada publicación con su estado y acciones. Las descartadas y retiradas van aparte.
 */
export function PublicationsPanel({
  listingId,
  listingStatus,
  content,
  publications,
  publishMode,
  runActive,
}: {
  listingId: string;
  listingStatus: ListingStatus;
  content: ContentView | undefined;
  publications: readonly ListingPublicationView[];
  publishMode: PublishMode | undefined;
  runActive: boolean;
}) {
  const publish = usePublishListing(listingId);
  const [confirming, setConfirming] = useState(false);
  const [requestedAt, setRequestedAt] = useState<Date | null>(null);
  const current = publications.filter((publication) => shown.has(publication.status));
  const past = publications.filter((publication) => !shown.has(publication.status));
  const ofContent = publications.filter((publication) => publication.contentId === content?.id);
  // Hay algo que publicar si el texto está aprobado y no todas sus publicaciones salieron o están
  // saliendo (sin ninguna, nacen al publicar: la cuenta se conectó después de aprobar).
  const publishable =
    content?.status === "approved" &&
    (ofContent.length === 0 ||
      ofContent.some((p) => p.status === "approved" || p.status === "failed"));
  const blocked = publishBlockedReason(listingStatus, runActive);
  const live = publishMode === "live";

  const start = () => {
    setConfirming(false);
    setRequestedAt(new Date());
    publish.mutate("instagram");
  };

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-slate-700">Publicaciones</h3>
      {content?.status !== "approved" && publications.length === 0 && (
        <p className="mt-1 text-sm text-slate-500">Aprueba el texto para poder publicarlo.</p>
      )}
      {publishable && (
        <div className="mt-2">
          {confirming ? (
            <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm">
              <p className="font-semibold text-red-800">
                La API está en vivo: se publicará de verdad en Instagram.
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" className={DANGER} onClick={start}>
                  Sí, publicar en vivo
                </button>
                <button type="button" className="underline" onClick={() => setConfirming(false)}>
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={PRIMARY}
              disabled={publish.isPending || blocked !== null}
              onClick={() => (live ? setConfirming(true) : start())}
            >
              {live ? "Publicar en Instagram (en vivo)" : "Publicar en Instagram (simulación)"}
            </button>
          )}
          {blocked !== null && <p className="mt-1 text-xs text-amber-800">{blocked}</p>}
        </div>
      )}
      {publish.data?.skipped.map((skipped) => (
        <p key={skipped.publicationId} className="mt-2 text-sm text-amber-800">
          El {PUBLICATION_FORMAT_TEXT[skipped.format]} tiene una publicación activa de un texto
          anterior: retírala o descártala para publicar el nuevo.
        </p>
      ))}
      {publish.data !== undefined && publish.data.stranded.length > 0 && (
        <p className="mt-2 text-sm text-amber-800">
          Hay publicaciones de una cuenta desconectada: descártalas o reconéctala en{" "}
          <Link to="/cuentas" className="underline">
            Cuentas
          </Link>
          .
        </p>
      )}
      {publish.error && (
        <>
          <ErrorAlert error={publish.error} />
          {publish.error instanceof ApiError && publish.error.code === "ACCOUNT_NOT_CONNECTED" && (
            <p className="mt-2 text-sm">
              Conecta la cuenta de Instagram del corredor en{" "}
              <Link to="/cuentas" className="underline">
                Cuentas
              </Link>
              .
            </p>
          )}
        </>
      )}
      <div className="mt-3 flex flex-col gap-3">
        {current.map((publication) => (
          <PublicationItem
            key={publication.id}
            publication={publication}
            listingId={listingId}
            publishMode={publishMode}
            requestedAt={requestedAt}
          />
        ))}
      </div>
      {past.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-slate-600">
            Descartadas y retiradas ({past.length})
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            {past.map((publication) => (
              <PublicationItem
                key={publication.id}
                publication={publication}
                listingId={listingId}
                publishMode={publishMode}
                requestedAt={null}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
