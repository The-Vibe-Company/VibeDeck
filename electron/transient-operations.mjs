function cleanUuid(value, { prefix = "", label }) {
  if (typeof value !== "string") throw new TypeError(`${label} invalide.`);
  const id = value.trim();
  const uuid = "[a-f\\d]{8}-[a-f\\d]{4}-[1-8][a-f\\d]{3}-[89ab][a-f\\d]{3}-[a-f\\d]{12}";
  if (!new RegExp(`^${prefix}${uuid}$`, "i").test(id)) {
    throw new TypeError(`${label} invalide.`);
  }
  return id;
}

export function cleanWebPreviewId(value) {
  return cleanUuid(value, {
    prefix: "draft:",
    label: "Identifiant d’aperçu web",
  });
}

export function cleanSourceProbeId(value) {
  return cleanUuid(value, {
    label: "Identifiant de test de source",
  });
}

export function cleanFeedPanelCreationId(value) {
  return cleanUuid(value, {
    prefix: "draft:",
    label: "Identifiant de création du fil",
  });
}

export function createLatestAbortOperationRegistry({
  createController = () => new AbortController(),
} = {}) {
  const operations = new Map();

  function cancel(owner, operationId = null) {
    const operation = operations.get(owner);
    if (!operation || (operationId !== null && operation.operationId !== operationId)) {
      return false;
    }
    operations.delete(owner);
    operation.controller.abort();
    return true;
  }

  return Object.freeze({
    start(owner, operationId) {
      cancel(owner);
      const operation = {
        operationId,
        controller: createController(),
      };
      operations.set(owner, operation);
      return operation;
    },
    cancel,
    finish(owner, operation) {
      if (operations.get(owner) !== operation) return false;
      operations.delete(owner);
      return true;
    },
    current(owner) {
      return operations.get(owner) ?? null;
    },
  });
}

export function createWebPreviewAuthorizationStore() {
  const authorizations = new Map();

  function requireAuthorization(owner, previewId) {
    const authorization = authorizations.get(owner);
    if (!authorization || authorization.previewId !== previewId) {
      throw new Error("Cet aperçu web n’est plus disponible.");
    }
    return authorization;
  }

  return Object.freeze({
    start(owner, authorization, startPreview) {
      const previous = authorizations.get(owner) ?? null;
      if (previous?.committing || (previous && previous.previewId !== authorization.previewId)) {
        throw new Error("Un autre aperçu web est déjà ouvert.");
      }
      const next = {
        previewId: authorization.previewId,
        url: authorization.url,
        committing: false,
      };
      authorizations.set(owner, next);
      try {
        startPreview(next);
      } catch (error) {
        if (previous) authorizations.set(owner, previous);
        else authorizations.delete(owner);
        throw error;
      }
      return next;
    },
    current(owner) {
      return authorizations.get(owner) ?? null;
    },
    require(owner, previewId) {
      return requireAuthorization(owner, previewId);
    },
    async commit(owner, previewId, commitPreview) {
      const authorization = requireAuthorization(owner, previewId);
      if (authorization.committing) {
        throw new Error("La création de cet aperçu web est déjà en cours.");
      }
      authorization.committing = true;
      let result;
      try {
        result = await commitPreview(authorization);
      } catch (error) {
        if (authorizations.get(owner) === authorization) authorization.committing = false;
        throw error;
      }
      if (authorizations.get(owner) === authorization) authorizations.delete(owner);
      return result;
    },
    cancel(owner, previewId = null) {
      const authorization = authorizations.get(owner);
      if (!authorization || (previewId !== null && authorization.previewId !== previewId)) {
        return null;
      }
      if (authorization.committing) return null;
      authorizations.delete(owner);
      return authorization;
    },
    clear(owner) {
      const authorization = authorizations.get(owner) ?? null;
      authorizations.delete(owner);
      return authorization;
    },
  });
}
