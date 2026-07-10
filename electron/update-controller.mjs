const UPDATE_CHECK_DELAY_MS = 10_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function cleanVersion(value) {
  if (typeof value !== "string") return null;
  const version = value.trim();
  return version && version.length <= 64 ? version : null;
}

function cleanProgress(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function genericUpdateError() {
  return "La recherche de mise à jour a échoué. Réessayez plus tard.";
}

export function createUpdateController({
  updater,
  isPackaged,
  currentVersion,
  onStateChange = () => {},
  prepareForInstall = async () => {},
  onInstallFailure = () => {},
  now = () => new Date(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (typeof isPackaged !== "boolean" || typeof currentVersion !== "string") {
    throw new TypeError("Configuration de mise à jour invalide.");
  }
  if (
    typeof onStateChange !== "function"
    || typeof prepareForInstall !== "function"
    || typeof onInstallFailure !== "function"
  ) {
    throw new TypeError("Callbacks de mise à jour invalides.");
  }
  if (isPackaged && (!updater || typeof updater.on !== "function")) {
    throw new TypeError("Moteur de mise à jour indisponible.");
  }

  let state = {
    status: isPackaged ? "idle" : "disabled",
    currentVersion,
    availableVersion: null,
    progressPercent: null,
    checkedAt: null,
    message: isPackaged ? null : "Les mises à jour sont disponibles dans l’application installée.",
  };
  let checkPromise = null;
  let restartPromise = null;
  let installPrepared = false;
  let installFailureHandled = false;
  let initialTimer = null;
  let intervalTimer = null;
  const listeners = [];

  const snapshot = () => ({ ...state });
  const publish = (patch) => {
    state = { ...state, ...patch };
    const next = snapshot();
    onStateChange(next);
    return next;
  };
  const listen = (eventName, listener) => {
    updater.on(eventName, listener);
    listeners.push([eventName, listener]);
  };
  const handleInstallFailure = () => {
    if (installFailureHandled) return;
    installFailureHandled = true;
    onInstallFailure();
  };

  if (isPackaged) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = null;

    listen("checking-for-update", () => {
      if (state.status !== "ready") {
        publish({ status: "checking", progressPercent: null, message: null });
      }
    });
    listen("update-available", (info) => {
      publish({
        status: "downloading",
        availableVersion: cleanVersion(info?.version),
        progressPercent: 0,
        message: null,
      });
    });
    listen("update-not-available", () => {
      publish({
        status: "up-to-date",
        availableVersion: null,
        progressPercent: null,
        checkedAt: now().toISOString(),
        message: null,
      });
    });
    listen("download-progress", (progress) => {
      if (state.status === "ready") return;
      publish({
        status: "downloading",
        progressPercent: cleanProgress(progress?.percent),
        message: null,
      });
    });
    listen("update-downloaded", (info) => {
      publish({
        status: "ready",
        availableVersion: cleanVersion(info?.version) ?? state.availableVersion,
        progressPercent: 100,
        checkedAt: now().toISOString(),
        message: null,
      });
    });
    listen("error", () => {
      if (restartPromise && installPrepared) {
        handleInstallFailure();
        return;
      }
      if (state.status === "ready") return;
      publish({
        status: "error",
        progressPercent: null,
        checkedAt: now().toISOString(),
        message: genericUpdateError(),
      });
    });
  }

  async function checkNow() {
    if (!isPackaged || state.status === "ready") return snapshot();
    if (checkPromise) return checkPromise;
    checkPromise = Promise.resolve()
      .then(() => updater.checkForUpdates())
      .then(() => snapshot())
      .catch(() => publish({
        status: "error",
        progressPercent: null,
        checkedAt: now().toISOString(),
        message: genericUpdateError(),
      }))
      .finally(() => {
        checkPromise = null;
      });
    return checkPromise;
  }

  function start() {
    if (!isPackaged || initialTimer || intervalTimer) return;
    initialTimer = setTimeoutImpl(() => {
      initialTimer = null;
      void checkNow();
    }, UPDATE_CHECK_DELAY_MS);
    intervalTimer = setIntervalImpl(() => void checkNow(), UPDATE_CHECK_INTERVAL_MS);
    initialTimer?.unref?.();
    intervalTimer?.unref?.();
  }

  function stop() {
    if (initialTimer) clearTimeoutImpl(initialTimer);
    if (intervalTimer) clearIntervalImpl(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
  }

  async function restartForUpdate() {
    if (!isPackaged || state.status !== "ready") {
      throw new Error("Aucune mise à jour téléchargée n’est prête.");
    }
    if (restartPromise) return restartPromise;
    restartPromise = Promise.resolve()
      .then(() => prepareForInstall())
      .then(() => {
        installPrepared = true;
        try {
          updater.quitAndInstall(false, true);
        } catch (error) {
          handleInstallFailure();
          throw error;
        }
      })
      .catch((error) => {
        if (!installPrepared) restartPromise = null;
        throw error;
      });
    return restartPromise;
  }

  function dispose() {
    stop();
    for (const [eventName, listener] of listeners) {
      updater.off?.(eventName, listener);
    }
    listeners.length = 0;
  }

  return {
    getState: snapshot,
    checkNow,
    restartForUpdate,
    start,
    stop,
    dispose,
  };
}

export { UPDATE_CHECK_DELAY_MS, UPDATE_CHECK_INTERVAL_MS };
