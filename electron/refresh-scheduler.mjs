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

export function createRefreshScheduler({
  getSources,
  refreshSource,
  onStateChange = () => undefined,
  now = () => Date.now(),
}) {
  if (typeof getSources !== "function" || typeof refreshSource !== "function") {
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
      const tasks = dueSources.map(({ id }) => refreshSource(id));
      onStateChange();
      await Promise.allSettled(tasks);
      onStateChange();
    })().finally(() => {
      currentPass = null;
    });
    return currentPass;
  }

  return {
    run,
    stop() {
      stopped = true;
    },
    pending() {
      return currentPass;
    },
  };
}
