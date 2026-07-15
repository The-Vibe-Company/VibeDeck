import type { FeedItem, Source } from "./types";

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

function newestTimestampFirst(first: number, second: number) {
  if (first === second) return 0;
  return first > second ? -1 : 1;
}

/**
 * Keep genuine post-baseline arrival batches at the head of the monitoring
 * stream. Sources refreshed together share a batch and are interleaved by
 * publication chronology instead of appearing in completion-order blocks.
 */
export function compareFeedItems(first: FeedItem, second: FeedItem) {
  if (first.isBaseline !== second.isBaseline) return first.isBaseline ? 1 : -1;

  if (!first.isBaseline) {
    const batchOrder = newestTimestampFirst(
      firstTimestamp(first.arrivalBatchAt, first.observedAt, first.firstSeenAt),
      firstTimestamp(second.arrivalBatchAt, second.observedAt, second.firstSeenAt),
    );
    if (batchOrder !== 0) return batchOrder;
  }

  const chronologyOrder = newestTimestampFirst(
    firstTimestamp(first.publishedAt, first.updatedAt, first.observedAt, first.firstSeenAt),
    firstTimestamp(second.publishedAt, second.updatedAt, second.observedAt, second.firstSeenAt),
  );
  if (chronologyOrder !== 0) return chronologyOrder;

  const observationOrder = newestTimestampFirst(
    firstTimestamp(first.observedAt, first.firstSeenAt),
    firstTimestamp(second.observedAt, second.firstSeenAt),
  );
  if (observationOrder !== 0) return observationOrder;

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

/** Teinte d’identité stable d’une source (FNV-1a sur l’id), dans [0, 360). */
export function sourceHue(seed: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

/** « Le Monde » → « LM », « L’Équipe » → « LÉ », « Libération » → « LI », vide → « — ». */
export function abbreviateSourceName(name: string) {
  const segments = name
    .split(/[\s'’‐‑–—-]+/u)
    .filter((segment) => /[\p{L}\p{N}]/u.test(segment));
  if (segments.length === 0) return "—";
  const letters =
    segments.length >= 2
      ? segments.slice(0, 2).map((segment) => [...segment][0])
      : [...segments[0]].slice(0, 2);
  return letters.join("").toLocaleUpperCase("fr-FR");
}

export function formatDayLabel(value: Date, now = new Date()) {
  const dayDifference = Math.round((dayStart(now) - dayStart(value)) / 86_400_000);
  if (dayDifference === 0) return "AUJOURD’HUI";
  const formatted = new Intl.DateTimeFormat("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(value.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })
    .format(value)
    .replaceAll(".", "")
    .toLocaleUpperCase("fr-FR");
  return dayDifference === 1 ? `HIER · ${formatted}` : formatted;
}

export type FeedListRow =
  | { kind: "separator"; key: string; label: string }
  | { kind: "item"; item: FeedItem };

/**
 * Intercale un séparateur de journée quand le jour change entre deux rangées
 * consécutives. Le tri remonte les arrivées en tête quelle que soit leur date :
 * les jours peuvent donc être non monotones et un même libellé réapparaître.
 * Les rangées sans date héritent du jour courant et n’émettent jamais de séparateur.
 */
export function withDaySeparators(items: FeedItem[], now = new Date()): FeedListRow[] {
  const rows: FeedListRow[] = [];
  let currentDayKey: number | null = null;
  for (const item of items) {
    const date = firstDate(item.publishedAt, item.updatedAt);
    if (date) {
      const dayKey = dayStart(date);
      if (dayKey !== currentDayKey) {
        rows.push({ kind: "separator", key: `sep-${item.id}`, label: formatDayLabel(date, now) });
        currentDayKey = dayKey;
      }
    }
    rows.push({ kind: "item", item });
  }
  return rows;
}

export function formatCheckedAt(value: string | null, now = new Date()) {
  const date = validDate(value);
  if (!date) return "jamais";
  const minutes = Math.max(0, Math.round((now.valueOf() - date.valueOf()) / 60_000));
  if (minutes < 1) return "maintenant";
  if (minutes < 60) return `il y a ${minutes} min`;
  return absoluteDateTime(date, now);
}

export type NextRefreshPresentation = {
  full: string;
  compact: string;
};

type ScheduledRefresh = {
  at: number;
  kind: "refresh" | "retry";
};

function nextScheduledRefresh(source: Source, now: number): ScheduledRefresh {
  const retryAt = timestamp(source.nextRetryAt);
  if (Number.isFinite(retryAt) && retryAt > now) {
    return { at: retryAt, kind: "retry" };
  }

  const lastCheckedAt = timestamp(source.lastCheckedAt);
  if (!Number.isFinite(lastCheckedAt)) return { at: now, kind: "refresh" };
  const intervalSeconds = Math.max(30, Number(source.refreshIntervalSeconds) || 30);
  return { at: lastCheckedAt + intervalSeconds * 1_000, kind: "refresh" };
}

function formatCountdown(milliseconds: number) {
  const totalSeconds = Math.ceil(Math.max(0, milliseconds) / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return {
    full: minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`,
    compact: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
  };
}

/** Mirrors the main-process scheduler so each feed can show its nearest refresh. */
export function formatNextRefresh(sources: Source[], now = new Date()): NextRefreshPresentation | null {
  if (sources.length === 0) return null;
  if (sources.some(({ status }) => status === "refreshing")) {
    return { full: "actualisation…", compact: "actualisation…" };
  }

  const nowValue = now.valueOf();
  const next = sources
    .map((source) => nextScheduledRefresh(source, nowValue))
    .sort((first, second) => first.at - second.at)[0];
  if (!next || next.at <= nowValue) return { full: "imminente", compact: "immin." };

  const countdown = formatCountdown(next.at - nowValue);
  if (next.kind === "retry") {
    return {
      full: `réessai dans ${countdown.full}`,
      compact: `réessai ${countdown.compact}`,
    };
  }
  return {
    full: `mise à jour dans ${countdown.full}`,
    compact: `màj ${countdown.compact}`,
  };
}
