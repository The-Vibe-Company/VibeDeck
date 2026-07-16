export function sourceIsDue(source, now = Date.now()) {
  if (!source || typeof source !== "object") return false;
  if (source.status === "refreshing") return false;
  if (source.nextRetryAt) {
    const nextRetry = Date.parse(source.nextRetryAt);
    if (Number.isFinite(nextRetry) && nextRetry > now) return false;
  }
  if (!source.lastCheckedAt) return true;
  const lastChecked = Date.parse(source.lastCheckedAt);
  if (!Number.isFinite(lastChecked)) return true;
  return now - lastChecked >= Math.max(30, Number(source.refreshIntervalSeconds) || 30) * 1_000;
}

export function millisecondsUntilSourceIsDue(source, now = Date.now()) {
  if (!source || typeof source !== "object" || source.status === "refreshing") {
    return Number.POSITIVE_INFINITY;
  }
  if (source.nextRetryAt) {
    const nextRetry = Date.parse(source.nextRetryAt);
    if (Number.isFinite(nextRetry) && nextRetry > now) return nextRetry - now;
  }
  if (!source.lastCheckedAt) return 0;
  const lastChecked = Date.parse(source.lastCheckedAt);
  if (!Number.isFinite(lastChecked)) return 0;
  const intervalMs = Math.max(
    30,
    Number(source.refreshIntervalSeconds) || 30,
  ) * 1_000;
  return Math.max(0, lastChecked + intervalMs - now);
}

export function createRefreshScheduler({
  getSources,
  refreshSources,
  createArrivalBatchAt = (timestamp) => new Date(timestamp).toISOString(),
  onStateChange = () => undefined,
  now = () => Date.now(),
}) {
  if (
    typeof getSources !== "function" ||
    typeof refreshSources !== "function" ||
    typeof createArrivalBatchAt !== "function"
  ) {
    throw new TypeError("Dépendances du planificateur de veille invalides.");
  }
  let currentPass = null;
  let stopped = false;

  function run() {
    if (stopped) return Promise.resolve();
    if (currentPass) return currentPass;
    currentPass = (async () => {
      const timestamp = Number(now());
      if (!Number.isFinite(timestamp)) throw new Error("Horloge de rafraîchissement invalide.");
      const dueSources = getSources().filter((source) => sourceIsDue(source, timestamp));
      if (dueSources.length === 0) return;
      const arrivalBatchAt = createArrivalBatchAt(timestamp);
      const task = refreshSources(dueSources.map(({ id }) => id), { arrivalBatchAt });
      onStateChange();
      await Promise.allSettled([task]);
      onStateChange();
    })().finally(() => {
      currentPass = null;
    });
    return currentPass;
  }

  return {
    run,
    nextDelay({ minimumMs = 250, maximumMs = 15 * 60_000 } = {}) {
      if (!Number.isFinite(minimumMs) || !Number.isFinite(maximumMs)) {
        throw new TypeError("Bornes du planificateur invalides.");
      }
      const lower = Math.max(0, Math.trunc(minimumMs));
      const upper = Math.max(lower, Math.trunc(maximumMs));
      const timestamp = Number(now());
      if (!Number.isFinite(timestamp)) throw new Error("Horloge de rafraîchissement invalide.");
      const delay = getSources().reduce(
        (nearest, source) => Math.min(
          nearest,
          millisecondsUntilSourceIsDue(source, timestamp),
        ),
        Number.POSITIVE_INFINITY,
      );
      return Number.isFinite(delay) ? Math.min(upper, Math.max(lower, delay)) : upper;
    },
    stop() {
      stopped = true;
    },
    pending() {
      return currentPass;
    },
  };
}
