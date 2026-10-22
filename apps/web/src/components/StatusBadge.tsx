import {
  LISTING_STATUS_TEXT,
  type ListingStatus,
  PLATFORM_ACCOUNT_STATUS_TEXT,
  type PlatformAccountStatus,
  PUBLICATION_STATUS_TEXT,
  type PublicationStatus,
} from "@agentsales/core";
import { ACCOUNT_STATUS_TONE, LISTING_STATUS_TONE, PUBLICATION_STATUS_TONE } from "../labels.js";
import { Badge } from "./ui/Badge.js";

/** El estado de una propiedad. */
export function StatusBadge({ status }: { status: ListingStatus }) {
  return <Badge tone={LISTING_STATUS_TONE[status]}>{LISTING_STATUS_TEXT[status]}</Badge>;
}

/** El estado de una publicación (de un aviso o de un post). */
export function PublicationStatusBadge({ status }: { status: PublicationStatus }) {
  return <Badge tone={PUBLICATION_STATUS_TONE[status]}>{PUBLICATION_STATUS_TEXT[status]}</Badge>;
}

/** El estado de una cuenta conectada. */
export function AccountStatusBadge({ status }: { status: PlatformAccountStatus }) {
  return <Badge tone={ACCOUNT_STATUS_TONE[status]}>{PLATFORM_ACCOUNT_STATUS_TEXT[status]}</Badge>;
}
