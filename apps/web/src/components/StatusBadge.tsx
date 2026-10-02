import { LISTING_STATUS_TEXT, type ListingStatus } from "@agentsales/core";
import { LISTING_STATUS_TONE } from "../labels.js";

export function StatusBadge({ status }: { status: ListingStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${LISTING_STATUS_TONE[status]}`}
    >
      {LISTING_STATUS_TEXT[status]}
    </span>
  );
}
