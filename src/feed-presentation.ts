import type { FeedItem } from "./types";

function timestamp(value: string | null | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function firstTimestamp(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const parsed = timestamp(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

function stableIdOrder(first: FeedItem, second: FeedItem) {
  if (first.id === second.id) return 0;
  return first.id < second.id ? -1 : 1;
}

/**
 * Keep genuine post-baseline arrivals at the head of the monitoring stream.
 * Within the baseline, use the publication chronology so sources loaded a few
 * milliseconds apart are genuinely interleaved instead of appearing in blocks.
 */
export function compareFeedItems(first: FeedItem, second: FeedItem) {
  if (first.isBaseline !== second.isBaseline) return first.isBaseline ? 1 : -1;

  if (!first.isBaseline) {
    const detectionDifference =
      firstTimestamp(second.observedAt, second.firstSeenAt) -
      firstTimestamp(first.observedAt, first.firstSeenAt);
    if (detectionDifference !== 0) return detectionDifference;
  }

  const chronologyDifference =
    firstTimestamp(second.publishedAt, second.updatedAt, second.observedAt, second.firstSeenAt) -
    firstTimestamp(first.publishedAt, first.updatedAt, first.observedAt, first.firstSeenAt);
  if (chronologyDifference !== 0) return chronologyDifference;

  const observationDifference =
    firstTimestamp(second.observedAt, second.firstSeenAt) -
    firstTimestamp(first.observedAt, first.firstSeenAt);
  if (observationDifference !== 0) return observationDifference;

  return stableIdOrder(first, second);
}

function validDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date : null;
}

function firstDate(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const date = validDate(value);
    if (date) return date;
  }
  return null;
}

function dayStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).valueOf();
}

function absoluteDateTime(value: Date, now: Date) {
  const time = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
  const dayDifference = Math.round((dayStart(now) - dayStart(value)) / 86_400_000);
  if (dayDifference === 0) return `auj. ${time}`;
  if (dayDifference === 1) return `hier ${time}`;

  const day = String(value.getDate()).padStart(2, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const year = value.getFullYear() === now.getFullYear()
    ? ""
    : `/${String(value.getFullYear()).slice(-2)}`;
  return `${day}/${month}${year} ${time}`;
}

export function formatItemTime(item: FeedItem, now = new Date()) {
  const value = firstDate(item.publishedAt, item.updatedAt);
  if (!value) return "—";
  const minutes = Math.max(0, Math.floor((now.valueOf() - value.valueOf()) / 60_000));
  if (minutes < 1) return "maint.";
  if (minutes < 60) return `${minutes} min`;
  return absoluteDateTime(value, now);
}

export function formatCheckedAt(value: string | null, now = new Date()) {
  const date = validDate(value);
  if (!date) return "jamais";
  const minutes = Math.max(0, Math.round((now.valueOf() - date.valueOf()) / 60_000));
  if (minutes < 1) return "maintenant";
  if (minutes < 60) return `il y a ${minutes} min`;
  return absoluteDateTime(date, now);
}
