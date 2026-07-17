import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./downloads.js", import.meta.url), "utf8");
const context = { AbortController, clearTimeout, setTimeout, URL };
vm.runInNewContext(source, context, { filename: "site/downloads.js" });
const downloads = context.VibeDeckDownloads;

function release(overrides = {}) {
  return {
    tag_name: "v1.2.3",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "VibeDeck-1.2.3-universal.dmg",
        browser_download_url: "https://github.com/The-Vibe-Company/VibeDeck/releases/download/v1.2.3/VibeDeck-1.2.3-universal.dmg",
      },
      {
        name: "vibedeck-setup-1.2.3.exe",
        browser_download_url: "https://github.com/The-Vibe-Company/VibeDeck/releases/download/v1.2.3/vibedeck-setup-1.2.3.exe",
      },
      {
        name: "vibedeck-setup-1.2.3.exe.blockmap",
        browser_download_url: "https://github.com/The-Vibe-Company/VibeDeck/releases/download/v1.2.3/vibedeck-setup-1.2.3.exe.blockmap",
      },
    ],
    ...overrides,
  };
}

class FakeButton {
  constructor(platform) {
    this.dataset = { downloadPlatform: platform };
    this.attributes = new Map();
    this.classes = new Set(["btn-ghost"]);
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
    };
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  click() {
    if (this.disabled) return Promise.resolve();
    return this.listeners.get("click")({ currentTarget: this });
  }
}

function setup({ navigator = {}, fetchImpl, nowImpl, requestTimeoutMs, downloadLockMs } = {}) {
  const macos = new FakeButton("macos");
  const windows = new FakeButton("windows");
  const group = {
    children: [macos, windows],
    get firstElementChild() { return this.children[0]; },
    insertBefore(node, reference) {
      this.children = this.children.filter((candidate) => candidate !== node);
      this.children.splice(this.children.indexOf(reference), 0, node);
    },
  };
  const status = { textContent: "", dataset: {} };
  const navigations = [];
  const controller = downloads.createDownloadController({
    buttons: [macos, windows],
    group,
    status,
    navigator,
    fetchImpl: fetchImpl || (async () => ({ ok: true, json: async () => release() })),
    location: { assign: (url) => navigations.push(url) },
    AbortControllerImpl: AbortController,
    clearTimeoutImpl: clearTimeout,
    setTimeoutImpl: setTimeout,
    nowImpl,
    requestTimeoutMs,
    downloadLockMs,
  });
  return { controller, group, macos, navigations, status, windows };
}

test("détecte uniquement macOS et Windows sur les postes de bureau", () => {
  assert.equal(downloads.detectPlatform({ userAgentData: { platform: "macOS" } }), "macos");
  assert.equal(downloads.detectPlatform({ platform: "Win32" }), "windows");
  assert.equal(downloads.detectPlatform({ platform: "Linux x86_64" }), null);
  assert.equal(
    downloads.detectPlatform({ platform: "MacIntel", maxTouchPoints: 5, userAgent: "Mozilla/5.0 (iPad)" }),
    null,
  );
  assert.equal(downloads.detectPlatform({ userAgentData: { platform: "Android" } }), null);
  assert.equal(downloads.detectPlatform({ platform: "Win32", userAgent: "Windows Phone Mobile" }), null);
});

test("met la plateforme détectée en premier et garde les deux choix", async () => {
  const mac = setup({ navigator: { platform: "MacIntel", maxTouchPoints: 0 } });
  await mac.controller.ready;
  assert.equal(mac.controller.platform, "macos");
  assert.equal(mac.group.firstElementChild, mac.macos);
  assert.ok(mac.macos.classes.has("btn-amber"));
  assert.ok(mac.windows.classes.has("btn-ghost"));
  assert.match(mac.status.textContent, /macOS détecté/);

  const win = setup({ navigator: { userAgentData: { platform: "Windows" } } });
  await win.controller.ready;
  assert.equal(win.group.firstElementChild, win.windows);
  assert.ok(win.windows.classes.has("btn-amber"));

  const linux = setup({ navigator: { platform: "Linux x86_64" } });
  await linux.controller.ready;
  assert.equal(linux.group.firstElementChild, linux.macos);
  assert.ok(linux.macos.classes.has("btn-ghost"));
  assert.ok(linux.windows.classes.has("btn-ghost"));
  assert.equal(linux.status.textContent, "Choisissez votre plateforme.");
});

test("ne contacte GitHub qu’au premier clic", async () => {
  let attempts = 0;
  const view = setup({
    fetchImpl: async () => {
      attempts += 1;
      return { ok: true, json: async () => release() };
    },
  });

  await view.controller.ready;
  assert.equal(attempts, 0);
  await view.macos.click();
  assert.equal(attempts, 1);
});

test("sélectionne uniquement le DMG et l’EXE de la release stable", () => {
  const assets = downloads.extractDownloadUrls(release());
  assert.match(assets.macos, /\.dmg$/);
  assert.match(assets.windows, /\.exe$/);
  assert.doesNotMatch(assets.windows, /blockmap/);
});

test("refuse les assets absents, ambigus ou hors du dépôt", () => {
  assert.throws(() => downloads.extractDownloadUrls(release({ assets: release().assets.slice(1) })));
  assert.throws(() => downloads.extractDownloadUrls(release({ assets: [...release().assets, release().assets[0]] })));
  assert.throws(() => downloads.extractDownloadUrls(release({ prerelease: true })));
  assert.throws(() => downloads.extractDownloadUrls(release({
    assets: release().assets.map((asset, index) => index === 0
      ? { ...asset, browser_download_url: "https://example.com/VibeDeck-1.2.3-universal.dmg" }
      : asset),
  })));
});

test("télécharge directement l’asset choisi sans ouvrir une page GitHub", async () => {
  const view = setup({ navigator: { platform: "Win32" } });
  await view.controller.ready;
  await view.windows.click();
  assert.deepEqual(view.navigations, [
    "https://github.com/The-Vibe-Company/VibeDeck/releases/download/v1.2.3/vibedeck-setup-1.2.3.exe",
  ]);
  assert.equal(view.status.textContent, "Téléchargement pour Windows lancé.");
});

test("ignore un double clic pendant le lancement du téléchargement", async () => {
  const view = setup({ navigator: { platform: "Win32" }, downloadLockMs: 5 });
  await Promise.all([view.windows.click(), view.windows.click()]);
  assert.equal(view.navigations.length, 1);
});

test("reste sur le site après un échec puis retente au clic suivant", async () => {
  let attempts = 0;
  const view = setup({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("indisponible");
      return { ok: true, json: async () => release() };
    },
  });

  await view.macos.click();
  assert.equal(view.status.dataset.state, "error");
  assert.deepEqual(view.navigations, []);

  await view.macos.click();
  assert.equal(attempts, 2);
  assert.deepEqual(view.navigations, [
    "https://github.com/The-Vibe-Company/VibeDeck/releases/download/v1.2.3/VibeDeck-1.2.3-universal.dmg",
  ]);
});

test("annule une requête bloquée puis permet un retry", async () => {
  let attempts = 0;
  const view = setup({
    requestTimeoutMs: 5,
    fetchImpl: (_url, options) => {
      attempts += 1;
      if (attempts > 1) return Promise.resolve({ ok: true, json: async () => release() });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });

  await view.windows.click();
  assert.equal(view.status.dataset.state, "error");
  assert.equal(view.windows.disabled, false);
  await view.windows.click();
  assert.equal(attempts, 2);
  assert.equal(view.navigations.length, 1);
});

test("annule aussi une lecture JSON bloquée", async () => {
  let attempts = 0;
  const view = setup({
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) => {
      attempts += 1;
      if (attempts > 1) return { ok: true, json: async () => release() };
      return {
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      };
    },
  });

  await view.windows.click();
  assert.equal(view.status.dataset.state, "error");
  await view.windows.click();
  assert.equal(attempts, 2);
  assert.equal(view.navigations.length, 1);
});

test("respecte le backoff GitHub après les limitations 403 et 429", async (t) => {
  for (const status of [403, 429]) {
    await t.test(String(status), async () => {
      let attempts = 0;
      const now = 1_000_000;
      const view = setup({
        nowImpl: () => now,
        fetchImpl: async () => {
          attempts += 1;
          return {
            ok: false,
            status,
            headers: { get: (name) => name === "retry-after" ? "120" : null },
            json: async () => ({}),
          };
        },
      });

      await view.macos.click();
      await view.macos.click();
      assert.equal(attempts, 1);
      assert.match(view.status.textContent, /limite temporairement/);
    });
  }
});
