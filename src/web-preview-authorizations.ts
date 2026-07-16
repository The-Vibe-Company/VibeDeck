export interface WebPreviewAuthorization {
  previewId: string;
  url: string;
}

type StoredAuthorization = WebPreviewAuthorization & { committing: boolean };

/** One main-window-owned preview, with an exclusive commit claim. */
export class WebPreviewAuthorizations {
  private currentAuthorization: StoredAuthorization | null = null;
  private readonly nativeUrls = new Map<string, string>();

  urls(): ReadonlyMap<string, string> {
    return this.nativeUrls;
  }

  current(): WebPreviewAuthorization | null {
    const current = this.currentAuthorization;
    return current ? { previewId: current.previewId, url: current.url } : null;
  }

  start(previewId: string, url: string) {
    const previous = this.currentAuthorization;
    if (previous?.committing || (previous && previous.previewId !== previewId)) {
      throw new Error("Un autre aperçu web est déjà ouvert.");
    }
    this.currentAuthorization = { previewId, url, committing: false };
    this.nativeUrls.clear();
    this.nativeUrls.set(previewId, url);
    return { previewId, url };
  }

  async commit<T>(
    previewId: string,
    operation: (authorization: WebPreviewAuthorization) => Promise<T>,
  ) {
    const authorization = this.currentAuthorization;
    if (!authorization || authorization.previewId !== previewId) {
      throw new Error("Cet aperçu web n’est plus disponible.");
    }
    if (authorization.committing) {
      throw new Error("La création de cet aperçu web est déjà en cours.");
    }
    authorization.committing = true;
    try {
      const result = await operation({
        previewId: authorization.previewId,
        url: authorization.url,
      });
      if (this.currentAuthorization === authorization) {
        this.currentAuthorization = null;
        this.nativeUrls.delete(previewId);
      }
      return result;
    } catch (error) {
      if (this.currentAuthorization === authorization) authorization.committing = false;
      throw error;
    }
  }

  cancel(previewId: string) {
    const authorization = this.currentAuthorization;
    if (
      !authorization ||
      authorization.previewId !== previewId ||
      authorization.committing
    ) {
      return null;
    }
    this.currentAuthorization = null;
    this.nativeUrls.delete(previewId);
    return { previewId: authorization.previewId, url: authorization.url };
  }
}
