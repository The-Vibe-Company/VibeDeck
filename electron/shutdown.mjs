export async function closePersistenceAfterPending({
  pending,
  deadlineMs = null,
  closePersistence,
}) {
  if (!Array.isArray(pending) || typeof closePersistence !== "function") {
    throw new TypeError("Configuration de fermeture invalide.");
  }
  if (deadlineMs !== null && (!Number.isInteger(deadlineMs) || deadlineMs < 1)) {
    throw new RangeError("Délai de fermeture invalide.");
  }

  const settlement = Promise.allSettled(pending).then(() => true);
  let timer = null;
  const pendingSettled = deadlineMs === null
    ? await settlement
    : await Promise.race([
        settlement,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), deadlineMs);
        }),
      ]);
  if (timer) clearTimeout(timer);

  closePersistence();
  return { pendingSettled };
}
