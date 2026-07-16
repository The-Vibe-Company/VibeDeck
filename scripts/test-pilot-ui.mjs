import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { _electron as electron } from "playwright-core";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// VIBEDECK_PILOT_UI_SHOW=1 affiche la fenêtre pour débugger ; sinon la suite
// tourne fenêtre cachée pour ne pas voler le focus de l'écran.
const showWindow = process.env.VIBEDECK_PILOT_UI_SHOW === "1";
const initialArticleCount = 90;
const secondaryArticleCount = 2;
const baselineArticleCount = initialArticleCount + secondaryArticleCount;
const MIN_PANEL_WIDTH = 256;
const SUBPIXEL_EPSILON = 0.5;
// Doit rester aligné sur HOVER_SEEN_DELAY_MS dans src/App.tsx.
const HOVER_SEEN_DELAY_MS = 1000;
const newArticleTitle = "ARRIVÉE CONTRÔLÉE — invariant du viewport";
const oldArrivalTitle = "ARRIVÉE ANCIENNE — rang chronologique";
const topArrivalTitle = "ARRIVÉE EN TÊTE — scroll nul";
const pillArrivalTitle = "ARRIVÉE PASTILLE — rappel vers le haut";
const sharedArrivalTitle = "ARRIVÉE PARTAGÉE — tampon indépendant par panel";
const sharedSecondArrivalTitle = "ARRIVÉE PARTAGÉE — deuxième insertion";

function escapeXml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&apos;",
    '"': "&quot;",
  })[character]);
}

function renderFeed(origin, articles) {
  const items = articles.map((article) => `
    <item>
      <guid isPermaLink="false">${escapeXml(article.id)}</guid>
      <title>${escapeXml(article.title)}</title>
      <link>${escapeXml(`${origin}/articles/${article.id}`)}</link>
      <description>${escapeXml(article.summary)}</description>
      <pubDate>${article.publishedAt.toUTCString()}</pubDate>
    </item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Flux contrôlé VibeDeck</title>
        <link>${escapeXml(origin)}</link>
        <description>Flux local du test pilote</description>
        ${items}
      </channel>
    </rss>`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "Le serveur RSS local n’a pas démarré.");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function waitForLocalCondition(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Délai dépassé : ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function nativeWebViewSnapshots(electronApp, expectedUrl) {
  return electronApp.evaluate(async ({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("La fenêtre pilote est introuvable.");
    const views = window.contentView.children.filter(
      (view) => "webContents" in view && view.webContents.getURL() === url,
    );
    return Promise.all(views.map(async (view) => ({
        id: view.webContents.id,
        url: view.webContents.getURL(),
        visible: view.getVisible(),
        stateProbe: await view.webContents.executeJavaScript(
          "globalThis.__vibedeckPilotModalState ?? null",
        ),
        navigationStarts:
          view.webContents.__vibedeckPilotModalNavigationProbe?.starts ?? null,
      })));
  }, expectedUrl);
}

async function setNativeWebViewStateProbe(electronApp, expectedUrl, stateProbe) {
  await electronApp.evaluate(async ({ BrowserWindow }, { url, probe }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("La fenêtre pilote est introuvable.");
    const views = window.contentView.children.filter(
      (view) => "webContents" in view && view.webContents.getURL() === url,
    );
    if (views.length !== 1) {
      throw new Error(`Une vue web était attendue, ${views.length} trouvée(s).`);
    }
    const contents = views[0].webContents;
    const previousProbe = contents.__vibedeckPilotModalNavigationProbe;
    if (previousProbe) contents.off("did-start-navigation", previousProbe.listener);
    const navigationProbe = {
      starts: 0,
      listener: (_event, _url, _isInPlace, isMainFrame) => {
        if (isMainFrame !== false) navigationProbe.starts += 1;
      },
    };
    contents.__vibedeckPilotModalNavigationProbe = navigationProbe;
    contents.on("did-start-navigation", navigationProbe.listener);
    await contents.executeJavaScript(
      `globalThis.__vibedeckPilotModalState = ${JSON.stringify(probe)}`,
    );
  }, { url: expectedUrl, probe: stateProbe });
}

async function waitForNativeWebView(electronApp, expectedUrl, visible, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let snapshots = [];
  do {
    snapshots = await nativeWebViewSnapshots(electronApp, expectedUrl);
    if (snapshots.length === 1 && snapshots[0].visible === visible) return snapshots[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Délai dépassé : ${label}. Vues observées : ${JSON.stringify(snapshots)}`);
}

async function waitForDomFocus(page, locator, label, timeoutMs = 5_000) {
  const handle = await locator.elementHandle();
  assert.ok(handle, `${label} : élément introuvable.`);
  try {
    const wait = await page.waitForFunction(
      (element) => document.activeElement === element,
      handle,
      { polling: "raf", timeout: timeoutMs },
    );
    await wait.dispose();
  } catch (error) {
    throw new Error(`Délai dépassé : ${label}.`, { cause: error });
  } finally {
    await handle.dispose();
  }
}

async function waitForEnabled(page, locator, label, timeoutMs = 5_000) {
  const handle = await locator.elementHandle();
  assert.ok(handle, `${label} : élément introuvable.`);
  try {
    const wait = await page.waitForFunction(
      (element) =>
        element instanceof HTMLButtonElement &&
        !element.disabled &&
        element.getAttribute("aria-disabled") !== "true",
      handle,
      { polling: "raf", timeout: timeoutMs },
    );
    await wait.dispose();
  } catch (error) {
    throw new Error(`Délai dépassé : ${label}.`, { cause: error });
  } finally {
    await handle.dispose();
  }
}

async function waitForInputValue(page, locator, expectedValue, label, timeoutMs = 5_000) {
  const handle = await locator.elementHandle();
  assert.ok(handle, `${label} : champ introuvable.`);
  try {
    const wait = await page.waitForFunction(
      ({ element, value }) =>
        element instanceof HTMLInputElement && element.value === value,
      { element: handle, value: expectedValue },
      { polling: "raf", timeout: timeoutMs },
    );
    await wait.dispose();
  } catch (error) {
    throw new Error(`Délai dépassé : ${label}.`, { cause: error });
  } finally {
    await handle.dispose();
  }
}

async function hoverRow(row) {
  await row.hover();
  await row.dispatchEvent("pointermove", { pointerType: "mouse" });
}

function assertWithin(actual, expected, tolerance, label) {
  const difference = Math.abs(actual - expected);
  assert.ok(
    difference <= tolerance,
    `${label}: ${actual} diffère de ${expected} de ${difference}px (tolérance ${tolerance}px).`,
  );
}

async function readMetrics(page, articleId) {
  return page.evaluate((selectedArticleId) => {
    const list = document.querySelector(".article-list");
    const selected = document.getElementById(selectedArticleId);
    const focused = document.querySelector(".article-row--focused");
    if (!(list instanceof HTMLElement) || !(selected instanceof HTMLElement)) {
      throw new Error("Le fil ou l’article de référence est introuvable.");
    }
    const rows = [...document.querySelectorAll(".article-row")];
    const newRow = rows.find((row) => row.textContent?.includes(
      "ARRIVÉE CONTRÔLÉE — invariant du viewport",
    ));
    return {
      activeId: document.activeElement?.id ?? null,
      focusedId: focused?.id ?? null,
      selectedTop: selected.getBoundingClientRect().top,
      scrollTop: list.scrollTop,
      newInDom: Boolean(newRow),
      newRowIndex: newRow ? rows.indexOf(newRow) : -1,
    };
  }, articleId);
}

const baselineTime = Date.now() - 60_000;
let articles = Array.from({ length: initialArticleCount }, (_, index) => ({
  id: `baseline-${String(index).padStart(3, "0")}`,
  title: `Article de référence ${String(index + 1).padStart(2, "0")} — titre suffisamment long pour stabiliser la hauteur`,
  summary: `Résumé contrôlé de l’article ${index + 1}.`,
  publishedAt: new Date(baselineTime - index * 60_000),
}));
const secondaryArticles = [
  {
    id: "secondary-between-001",
    title: "Article secondaire interclassé 01",
    summary: "Publié entre les deux premiers articles de la source principale.",
    publishedAt: new Date(baselineTime - 30_000),
  },
  {
    id: "secondary-between-002",
    title: "Article secondaire interclassé 02",
    summary: "Publié entre les articles deux et trois de la source principale.",
    publishedAt: new Date(baselineTime - 90_000),
  },
];
let primaryRequestCount = 0;
let secondaryRequestCount = 0;
let redirectedFeedRequestCount = 0;
let primaryShouldFail = false;
let primaryDelayMs = 0;
let probeDelayMs = 0;
let delayedProbeRequestCount = 0;
let delayedProbeAbortCount = 0;
let retryProbeShouldFail = true;
let origin = "";

const server = createServer((request, response) => {
  if (request.url === "/feed-redirect.xml") {
    redirectedFeedRequestCount += 1;
    response.writeHead(307, { Location: "/feed.xml" }).end();
    return;
  }
  if (request.url === "/preview.html") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": "vibedeck-preview-session=active; Path=/; SameSite=Lax",
    });
    response.end(`<!doctype html>
      <html lang="fr"><head><title>Page web contrôlée</title></head>
      <body><main><h1>Aperçu web contrôlé</h1><p>Session locale de test.</p></main></body></html>`);
    return;
  }
  if (
    request.url !== "/feed.xml" &&
    request.url !== "/feed-secondary.xml" &&
    request.url !== "/feed-probe-delayed.xml" &&
    request.url !== "/feed-probe-retry.xml"
  ) {
    response.writeHead(404).end("Not found");
    return;
  }
  const isSecondary = request.url === "/feed-secondary.xml";
  const isDelayedProbe = request.url === "/feed-probe-delayed.xml";
  const isRetryProbe = request.url === "/feed-probe-retry.xml";
  if (isDelayedProbe) {
    delayedProbeRequestCount += 1;
    let abortCounted = false;
    const countAbort = () => {
      if (abortCounted || response.writableEnded) return;
      abortCounted = true;
      delayedProbeAbortCount += 1;
    };
    request.once("aborted", countAbort);
    response.once("close", countAbort);
  }
  if (isSecondary) secondaryRequestCount += 1;
  else if (!isDelayedProbe && !isRetryProbe) primaryRequestCount += 1;
  if (isRetryProbe && retryProbeShouldFail) {
    retryProbeShouldFail = false;
    response.writeHead(503, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Panne transitoire contrôlée");
    return;
  }
  if (!isSecondary && primaryShouldFail) {
    response.writeHead(503, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Panne contrôlée du flux principal");
    return;
  }
  const sendFeed = () => {
    if (response.destroyed) return;
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/rss+xml; charset=utf-8",
    });
    response.end(renderFeed(origin, isSecondary ? secondaryArticles : articles));
  };
  const delay = isDelayedProbe ? probeDelayMs : (isSecondary ? 0 : primaryDelayMs);
  if (delay > 0) {
    if (isDelayedProbe) probeDelayMs = 0;
    else primaryDelayMs = 0;
    setTimeout(sendFeed, delay);
    return;
  }
  sendFeed();
});

let electronApp;
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "vibedeck-pilot-ui-"));

try {
  origin = await listen(server);
  const databasePath = path.join(temporaryDirectory, "vibedeck.sqlite3");
  electronApp = await electron.launch({
    executablePath: electronExecutable,
    args: [`--user-data-dir=${path.join(temporaryDirectory, "profile")}`, projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      VIBEDECK_ALLOW_PRIVATE_NETWORK: "true",
      VIBEDECK_DB_PATH: databasePath,
      VIBEDECK_FAKE_SEMANTIC_SEARCH: "true",
      VIBEDECK_TEST_HEADLESS: showWindow ? "" : "true",
      VITE_DEV_SERVER_URL: "",
    },
    timeout: 30_000,
  });

  const page = await electronApp.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  if (showWindow) await page.bringToFront();
  await page.waitForFunction(() => Boolean(window.vibedeck?.getState));
  await page.evaluate(() => window.vibedeck.focusDashboard());
  const updateAnnouncement = page.locator(".update-announcement");
  assert.equal(await updateAnnouncement.getAttribute("role"), "status");
  assert.equal(await updateAnnouncement.getAttribute("aria-live"), "polite");
  assert.equal(await updateAnnouncement.getAttribute("aria-atomic"), "true");

  const browserWindow = await electronApp.browserWindow(page);
  await browserWindow.evaluate((window) => window.setSize(1280, 820));
  await browserWindow.dispose();

  async function publishUpdateState(status, overrides = {}) {
    await electronApp.evaluate(({ BrowserWindow }, nextState) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("La fenêtre pilote est introuvable.");
      window.webContents.send("updates:state-changed", nextState);
    }, {
      status,
      currentVersion: "0.3.0",
      availableVersion: null,
      progressPercent: null,
      checkedAt: "2026-07-10T08:00:00.000Z",
      message: null,
      ...overrides,
    });
  }

  const updateCta = page.getByRole("button", { name: "Mise à jour 0.4.0 prête", exact: true });
  await publishUpdateState("checking");
  assert.equal(await updateCta.count(), 0, "La détection ne doit pas interrompre la veille.");

  await publishUpdateState("downloading", {
    availableVersion: "0.4.0",
    progressPercent: 42,
  });
  assert.equal(await updateCta.count(), 0, "Le téléchargement reste silencieux.");

  const toolsButton = page.getByRole("button", { name: "Outils" });
  await toolsButton.click();
  const toolsDialog = page.getByRole("dialog", { name: "Outils du poste" });
  await toolsDialog.getByRole("progressbar", { name: "Téléchargement de la version 0.4.0" }).waitFor();
  await toolsDialog.locator("footer").getByRole("button", { name: "Fermer" }).click();
  await toolsDialog.waitFor({ state: "detached" });
  await waitForDomFocus(
    page,
    toolsButton,
    "la fermeture des outils doit restaurer le focus avant l’action clavier suivante",
  );
  assert.equal(
    await toolsButton.evaluate((button) => document.activeElement === button),
    true,
    "La fermeture des outils doit restaurer le focus avant l’action clavier suivante.",
  );

  await publishUpdateState("ready", { availableVersion: "0.4.0" });
  await updateCta.waitFor();
  await updateCta.focus();
  await page.keyboard.press("Enter");
  const updateDialog = page.getByRole("alertdialog", { name: "Installer VibeDeck 0.4.0 ?" });
  await updateDialog.waitFor();
  const laterButton = updateDialog.getByRole("button", { name: "Plus tard" });
  await waitForDomFocus(page, laterButton, "le report doit recevoir le focus initial");
  assert.equal(
    await laterButton.evaluate((button) => document.activeElement === button),
    true,
    "Le report doit recevoir le focus initial.",
  );
  await page.keyboard.press("Escape");
  await updateDialog.waitFor({ state: "detached" });
  await waitForDomFocus(page, updateCta, "la fermeture doit restaurer le focus du CTA");
  assert.equal(
    await updateCta.evaluate((button) => document.activeElement === button),
    true,
    "La fermeture doit restaurer le focus du CTA.",
  );

  await updateCta.click();
  await updateDialog.getByRole("button", { name: "Plus tard" }).click();
  await updateDialog.waitFor({ state: "detached" });
  await updateCta.waitFor({ state: "detached" });
  assert.equal(await updateCta.count(), 0, "Le report masque seulement le CTA de cette version.");
  const deferredTools = page.getByRole("button", { name: "Outils — mise à jour 0.4.0 prête" });
  await waitForDomFocus(
    page,
    deferredTools,
    "le report de la mise à jour doit rendre le focus aux outils",
  );
  await deferredTools.click();
  await toolsDialog.getByRole("button", { name: "Installer" }).waitFor();

  await publishUpdateState("error", { message: "Serveur de mise à jour indisponible." });
  await toolsDialog.getByText("Serveur de mise à jour indisponible.").waitFor();
  await publishUpdateState("up-to-date");
  await toolsDialog.getByText("Cette version est à jour.").waitFor();
  await publishUpdateState("ready", { availableVersion: "0.4.1" });
  const installFromTools = toolsDialog.getByRole("button", { name: "Installer" });
  await installFromTools.waitFor();
  await installFromTools.click();
  const nextUpdateDialog = page.getByRole("alertdialog", { name: "Installer VibeDeck 0.4.1 ?" });
  await nextUpdateDialog.waitFor();
  await toolsDialog.waitFor({ state: "detached" });
  await waitForDomFocus(
    page,
    nextUpdateDialog.getByRole("button", { name: "Plus tard" }),
    "la confirmation ouverte depuis les outils doit recevoir son focus initial",
  );
  await page.keyboard.press("Escape");
  await nextUpdateDialog.waitFor({ state: "detached" });
  await toolsDialog.waitFor({ state: "visible" });
  await waitForDomFocus(
    page,
    installFromTools,
    "la confirmation ouverte depuis les outils doit restaurer son focus",
  );
  assert.equal(
    await installFromTools.evaluate((button) => document.activeElement === button),
    true,
    "La confirmation ouverte depuis Outils doit restaurer son focus.",
  );
  await toolsDialog.locator("footer").getByRole("button", { name: "Fermer" }).click();
  await toolsDialog.waitFor({ state: "detached" });

  const nextUpdateCta = page.getByRole("button", { name: "Mise à jour 0.4.1 prête", exact: true });
  await nextUpdateCta.waitFor();
  const updateWidthWindow = await electronApp.browserWindow(page);
  await updateWidthWindow.evaluate((window) => window.setSize(860, 600));
  await updateWidthWindow.dispose();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    "Le CTA de mise à jour ne doit pas créer de débordement à la largeur minimale.",
  );
  const restoredWindow = await electronApp.browserWindow(page);
  await restoredWindow.evaluate((window) => window.setSize(1280, 820));
  await restoredWindow.dispose();
  await nextUpdateCta.click();
  const failedInstallDialog = page.getByRole("alertdialog", { name: "Installer VibeDeck 0.4.1 ?" });
  await failedInstallDialog.getByRole("button", { name: "Redémarrer et installer" }).click();
  await failedInstallDialog.getByRole("alert").waitFor();
  await failedInstallDialog.getByRole("button", { name: "Plus tard" }).click();
  await failedInstallDialog.waitFor({ state: "detached" });

  const panelId = await page.evaluate(async () => {
    const before = await window.vibedeck.getState();
    const existingIds = new Set(before.panels.map(({ id }) => id));
    const next = await window.vibedeck.createPanel({
      kind: "feed",
      name: "Preuve viewport",
      defaultRefreshIntervalSeconds: 1_800,
    });
    const panel = next.panels.find(({ id }) => !existingIds.has(id));
    if (!panel || panel.kind !== "feed") throw new Error("Le fil de test n’a pas été créé.");
    return panel.id;
  });

  const sourceId = await page.evaluate(
    async ({ targetPanelId, feedUrl }) => {
      const result = await window.vibedeck.addSource(targetPanelId, {
        url: feedUrl,
        connectorKind: "rss",
        refreshIntervalSeconds: 1_800,
      });
      return result.sourceId;
    },
    { targetPanelId: panelId, feedUrl: `${origin}/feed-redirect.xml` },
  );

  await page.waitForFunction(
    (count) => document.querySelectorAll(".article-row").length === count,
    initialArticleCount,
  );
  assert.equal(primaryRequestCount, 1, "Le flux principal doit être chargé une seule fois.");
  assert.equal(
    redirectedFeedRequestCount,
    1,
    "Le flux pilote doit traverser une redirection HTTP avec la pile Electron réelle.",
  );

  await page.evaluate(
    async ({ targetPanelId, feedUrl }) => window.vibedeck.addSource(targetPanelId, {
      url: feedUrl,
      connectorKind: "rss",
      refreshIntervalSeconds: 1_800,
    }),
    { targetPanelId: panelId, feedUrl: `${origin}/feed-secondary.xml` },
  );
  await page.waitForFunction(
    (count) => document.querySelectorAll(".article-row").length === count,
    baselineArticleCount,
  );
  assert.equal(secondaryRequestCount, 1, "Le flux secondaire doit être chargé une seule fois.");

  const baselineTitles = await page.locator(".article-copy > strong").evaluateAll(
    (titles) => titles.slice(0, 5).map((title) => title.textContent),
  );
  assert.deepEqual(
    baselineTitles,
    [
      "Article de référence 01 — titre suffisamment long pour stabiliser la hauteur",
      "Article secondaire interclassé 01",
      "Article de référence 02 — titre suffisamment long pour stabiliser la hauteur",
      "Article secondaire interclassé 02",
      "Article de référence 03 — titre suffisamment long pour stabiliser la hauteur",
    ],
    "La baseline doit être interclassée par publication et non regroupée par source.",
  );

  // Échelle de texte des fils : défaut global lisible, override par panel,
  // contrôles A±, raccourcis et bornes.
  const defaultTextScale = () => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--feed-text-scale").trim());
  const panelTextScaleOverride = () => page.locator(".dashboard-panel--fil").first()
    .evaluate((panel) => panel.style.getPropertyValue("--feed-text-scale").trim());
  const firstTitleFontSize = () => page.locator(".article-copy > strong").first()
    .evaluate((title) => getComputedStyle(title).fontSize);
  assert.equal(await defaultTextScale(), "1");
  assert.equal(await panelTextScaleOverride(), "", "Un fil neuf suit la taille par défaut.");
  assert.equal(await firstTitleFontSize(), "14px", "Le titre par défaut doit faire 14px.");
  const growTextButton = page.getByRole("button", { name: "Agrandir le texte des fils" });
  await growTextButton.click();
  assert.equal(await defaultTextScale(), "1.1");
  assert.equal(await firstTitleFontSize(), "15.4px", "A+ global doit agrandir les titres.");
  assert.equal(
    await page.evaluate(() => window.localStorage.getItem("vibedeck.feedTextScale")),
    "1.1",
    "La taille par défaut doit être persistée.",
  );
  // Raccourci clavier avec un fil ciblé : il surcharge ce fil, pas le défaut.
  await page.locator(".article-row").first().focus();
  await page.keyboard.press("ControlOrMeta+=");
  assert.equal(await panelTextScaleOverride(), "1.2", "Cmd/Ctrl = doit surcharger le fil ciblé.");
  assert.equal(await defaultTextScale(), "1.1", "La taille par défaut ne doit pas bouger.");
  assert.equal(await firstTitleFontSize(), "16.8px", "Le fil surchargé doit suivre son échelle.");
  const overridePersisted = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("vibedeck.feedTextScale.overrides") ?? "{}"));
  assert.deepEqual(Object.values(overridePersisted), [1.2], "L’override par fil doit être persisté.");
  const panelScaleReset = page.getByRole("button", { name: /revenir à la taille par défaut/ });
  assert.equal(await panelScaleReset.count(), 1, "Le fil surchargé doit afficher sa pastille de reset.");
  await page.keyboard.press("ControlOrMeta+0");
  assert.equal(await panelTextScaleOverride(), "", "Cmd/Ctrl 0 doit rendre le fil au défaut.");
  assert.equal(await firstTitleFontSize(), "15.4px", "Le fil doit suivre à nouveau le défaut.");
  // A− dans l’en-tête du fil : surcharge à la souris.
  await page.getByRole("button", { name: "Réduire le texte de ce fil" }).click();
  assert.equal(await panelTextScaleOverride(), "1", "A− du fil doit partir de l’échelle effective.");
  await page.getByRole("button", { name: /revenir à la taille par défaut/ }).click();
  assert.equal(await panelTextScaleOverride(), "", "La pastille doit retirer l’override.");
  // Bornes du défaut global.
  for (let step = 0; step < 10; step += 1) {
    if (await growTextButton.getAttribute("aria-disabled") === "true") break;
    await growTextButton.click();
  }
  assert.equal(await defaultTextScale(), "1.6", "Le défaut doit plafonner à 160 %.");
  assert.equal(
    await growTextButton.getAttribute("aria-disabled"),
    "true",
    "A+ doit s’annoncer désactivé au plafond sans perdre le focus clavier.",
  );
  await page.getByRole("button", { name: "Réinitialiser la taille du texte des fils" }).click();
  assert.equal(await defaultTextScale(), "1", "Le bouton pourcentage doit revenir à 100 %.");
  const zoomMenuRoles = await electronApp.evaluate(({ Menu }) => {
    const collect = (menu) => menu.items.flatMap((item) => [
      item.role ?? "",
      ...(item.submenu ? collect(item.submenu) : []),
    ]);
    const applicationMenu = Menu.getApplicationMenu();
    return applicationMenu
      ? collect(applicationMenu).filter((role) =>
          ["zoomin", "zoomout", "resetzoom"].includes(role.toLowerCase()))
      : [];
  });
  assert.deepEqual(
    zoomMenuRoles,
    [],
    "Les rôles de zoom fenêtre doivent être retirés du menu pour libérer Cmd/Ctrl +/−/0.",
  );

  // Mode d'affichage DENSE/CONFORT : défaut dense, bascule par fil, persistance.
  const filPanel = page.locator(".dashboard-panel--fil").first();
  assert.equal(
    await filPanel.getAttribute("data-density"),
    "dense",
    "Le mode dense doit être le défaut des fils.",
  );
  const firstDaySeparator = page.locator(".article-day-separator").first();
  await firstDaySeparator.waitFor({ state: "visible" });
  // « HIER » toléré : une suite qui enjambe minuit ne doit pas devenir rouge.
  assert.match(
    (await firstDaySeparator.textContent()) ?? "",
    /AUJOURD’HUI|HIER/,
    "Le fil dense doit ouvrir sur le séparateur du jour.",
  );
  assert.equal(
    await page.locator(".article-summary").first().isHidden(),
    true,
    "Le résumé doit être masqué en mode dense.",
  );
  assert.equal(
    await page.locator(".article-row .article-provider .provider-mark--fallback").count() > 0,
    true,
    "Une source personnalisée doit utiliser le pictogramme générique plutôt que des initiales.",
  );
  assert.equal(
    await page.locator(".article-copy > strong").first().evaluate(
      (title) => getComputedStyle(title).whiteSpace,
    ),
    "normal",
    "Le titre dense ne doit jamais être tronqué : il passe à la ligne.",
  );
  assert.equal(
    await page.locator(".article-source__abbr").count(),
    0,
    "Les initiales de source ne doivent plus être rendues.",
  );
  assert.equal(
    await page.locator(".article-source").first().evaluate(
      (element) => getComputedStyle(element).width,
    ),
    "1px",
    "Le nom complet de la source doit rester accessible sans occuper la rangée dense.",
  );
  const denseModeButton = filPanel.getByRole("button", { name: "Dense" });
  const comfortModeButton = filPanel.getByRole("button", { name: "Confort" });
  await comfortModeButton.click();
  await page.waitForFunction(() =>
    document.querySelector(".dashboard-panel--fil")?.getAttribute("data-density") === "comfort");
  await page.locator(".article-summary").first().waitFor({ state: "visible" });
  assert.equal(
    await page.locator(".article-day-separator").count(),
    0,
    "Le mode confort doit rester le layout historique, sans séparateurs.",
  );
  assert.deepEqual(
    Object.values(await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("vibedeck.feedDensity.overrides") ?? "{}"))),
    ["comfort"],
    "L'override de densité par fil doit être persisté.",
  );
  await denseModeButton.click();
  await page.waitForFunction(() =>
    document.querySelector(".dashboard-panel--fil")?.getAttribute("data-density") === "dense");
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("vibedeck.feedDensity.overrides") ?? "{}")),
    {},
    "Revenir au défaut doit retirer l'override du fil.",
  );
  await comfortModeButton.click({ modifiers: ["Alt"] });
  await page.waitForFunction(() =>
    document.querySelector(".dashboard-panel--fil")?.getAttribute("data-density") === "comfort");
  assert.equal(
    await page.evaluate(() => window.localStorage.getItem("vibedeck.feedDensity")),
    "comfort",
    "Alt+clic doit changer le défaut global de densité.",
  );
  await denseModeButton.click({ modifiers: ["Alt"] });
  await page.waitForFunction(() =>
    document.querySelector(".dashboard-panel--fil")?.getAttribute("data-density") === "dense");
  assert.equal(
    await page.evaluate(() => window.localStorage.getItem("vibedeck.feedDensity")),
    "dense",
    "Le défaut global doit revenir à dense pour la suite du parcours.",
  );

  assert.equal(
    await page.locator('.article-row[tabindex="0"]').count(),
    1,
    "Un seul article doit être accessible par Tab dans le fil.",
  );
  assert.equal(
    await page.locator('.article-row[tabindex="-1"]').count(),
    baselineArticleCount - 1,
  );
  const firstArticleId = await page.locator(".article-row").first().getAttribute("id");
  assert.ok(firstArticleId, "Le premier article doit avoir un identifiant stable.");
  const secondArticleId = await page.locator(".article-row").nth(1).getAttribute("id");
  assert.ok(secondArticleId, "Le deuxième article doit avoir un identifiant stable.");
  await page.locator(".article-row").first().focus();
  await page.waitForFunction(
    (articleId) => document.querySelector(".article-row--focused")?.id === articleId,
    firstArticleId,
  );
  const activeArticleIdAfterKeyDown = await page.locator(".article-row").first().evaluate((row) => {
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    return document.activeElement?.id ?? null;
  });
  assert.equal(
    activeArticleIdAfterKeyDown,
    secondArticleId,
    "La navigation doit déplacer le focus dans le même tour d’événement.",
  );
  await page.waitForFunction(
    (articleId) => document.getElementById(articleId)?.getAttribute("tabindex") === "0",
    secondArticleId,
    { polling: 20 },
  );
  assert.equal(
    await page.locator(".article-row").nth(1).getAttribute("tabindex"),
    "0",
    "La cible des flèches doit devenir l’unique point d’entrée roving.",
  );
  assert.equal(
    await page.locator(".article-row").nth(1).evaluate((row) => document.activeElement === row),
    true,
    "La navigation roving doit déplacer le focus DOM.",
  );
  const allFilter = page.getByRole("button", { name: /^Toutes/ });
  await allFilter.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await allFilter.evaluate((button) => document.activeElement === button),
    true,
    "Une flèche utilisée depuis un contrôle ne doit pas être détournée par le fil.",
  );
  await page.locator(".global-bar").hover();
  await page.locator(".dashboard-panel").hover();
  assert.equal(
    await allFilter.evaluate((button) => document.activeElement === button),
    true,
    "Revenir à la souris dans un panel ne doit pas interrompre un contrôle actif.",
  );
  await allFilter.evaluate((button) => button.blur());
  await page.locator(".global-bar").hover();
  // Hover a row distinct from the prior keyboard anchor (nth(1)) so the assertion
  // truly isolates hover-preselect: only onPointerMove can move the selection to nth(3).
  const hoveredRow = page.locator(".article-row").nth(3);
  const hoveredRowId = await hoveredRow.getAttribute("id");
  await hoverRow(hoveredRow);
  assert.equal(
    await page.locator(".dashboard-panel").evaluate((panel) => document.activeElement === panel),
    true,
    "Le survol doit rendre le panel prêt pour les raccourcis sans voler ensuite les contrôles.",
  );
  await page.waitForFunction(
    (articleId) => document.querySelector(".article-row--focused")?.id === articleId,
    hoveredRowId,
  );
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.locator(".article-row").nth(4).evaluate((row) => document.activeElement === row),
    true,
    "Après survol, les flèches doivent partir de la ligne survolée et avancer d’un cran.",
  );
  // Relâcher le survol du fil pour ne pas laisser de minuteur « vu » armé.
  await page.locator(".global-bar").hover();

  await page.keyboard.press("ControlOrMeta+N");
  const draftLeaf = page.locator('.split-layout__leaf[data-panel-id^="draft:"]');
  await draftLeaf.waitFor({ state: "visible" });
  await draftLeaf.getByRole("button", { name: /Fil agrégé/ }).click();
  const draftFeedName = draftLeaf.getByLabel("Nom du fil");
  await waitForDomFocus(
    page,
    draftFeedName,
    "entrer dans le constructeur de Fil doit focaliser son premier champ",
  );
  assert.equal(
    await draftFeedName.evaluate((input) => document.activeElement === input),
    true,
    "Entrer dans le constructeur de Fil doit placer le vrai focus dans son premier champ.",
  );
  const categoryButtons = draftLeaf.locator(".provider-group__heading");
  assert.equal(await categoryButtons.count(), 6, "Le catalogue doit être regroupé par langue et type.");
  for (let index = 0; index < await categoryButtons.count(); index += 1) {
    const categoryButton = categoryButtons.nth(index);
    assert.equal(await categoryButton.getAttribute("aria-expanded"), "false");
    await categoryButton.click();
  }
  assert.equal(await draftLeaf.locator(".provider-row").count(), 30, "Ouvrir les catégories doit révéler les trente publications.");
  assert.equal(
    await draftLeaf.locator(".provider-row .provider-mark img").count(),
    30,
    "Chaque publication optimisée doit disposer de sa véritable icône locale.",
  );
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll(
      '.split-layout__leaf[data-panel-id^="draft:"] .provider-row .provider-mark img',
    )];
    return images.length === 30 && images.every((image) =>
      image.complete && image.naturalWidth === 96 && image.naturalHeight === 96);
  });
  assert.deepEqual(
    await draftLeaf.locator(".provider-row .provider-mark img").evaluateAll((images) =>
      images.map((image) => ({
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      }))),
    Array.from({ length: 30 }, () => ({ complete: true, naturalWidth: 96, naturalHeight: 96 })),
    "Les trente fichiers d’icône doivent réellement être décodés par le renderer.",
  );
  assert.equal(await draftLeaf.locator('.provider-language-group[aria-label="Français"] .provider-row').count(), 20);
  assert.equal(
    await draftLeaf.locator('.provider-language-group[aria-label="Anglais"] .provider-row').count(),
    10,
  );
  const catalogSearch = draftLeaf.getByLabel("Rechercher un connecteur optimisé");
  await catalogSearch.fill("BBC");
  assert.equal(await draftLeaf.locator(".provider-row").count(), 1, "La recherche doit filtrer les deux sections.");
  const bbcRow = draftLeaf.getByRole("button", { name: /BBC/ });
  await catalogSearch.focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await bbcRow.evaluate((button) => document.activeElement === button),
    true,
    "La publication filtrée doit être atteignable directement au clavier.",
  );
  await page.keyboard.press("Space");
  assert.equal(await bbcRow.getAttribute("aria-pressed"), "true");
  await page.keyboard.press("Space");
  await catalogSearch.fill("");
  const customSourceInput = draftLeaf.getByLabel("Adresse du site ou du flux");
  await customSourceInput.fill(`${origin}/feed-probe-retry.xml`);
  await draftLeaf.getByRole("button", { name: "Réessayer" }).waitFor({ state: "visible" });
  await draftLeaf.getByRole("button", { name: "Réessayer" }).click();
  await draftLeaf.locator(".source-probe").filter({ hasText: "Flux contrôlé VibeDeck" })
    .waitFor({ state: "visible" });
  await draftLeaf.getByRole("button", { name: new RegExp(`Retirer ${origin}/feed-probe-retry\\.xml`) }).click();

  await bbcRow.click();
  assert.equal(await bbcRow.getAttribute("aria-pressed"), "true");
  probeDelayMs = 1_200;
  await customSourceInput.fill(`${origin}/feed-probe-delayed.xml`);
  assert.equal(
    await draftLeaf.getByRole("button", { name: "Créer le fil" }).isDisabled(),
    true,
    "La création doit attendre la résolution de l’URL dès le début du délai de 700 ms.",
  );
  await draftLeaf.locator(".source-probe--loading").waitFor({ state: "visible" });
  assert.equal(
    await draftLeaf.getByRole("button", { name: "Créer le fil" }).isDisabled(),
    true,
    "La création doit rester bloquée pendant le téléchargement de vérification.",
  );
  await waitForLocalCondition(
    () => delayedProbeRequestCount === 1,
    "le premier test de source doit atteindre le serveur",
  );
  await customSourceInput.fill(`${origin}/feed-secondary.xml`);
  await waitForLocalCondition(
    () => delayedProbeAbortCount === 1,
    "modifier l’URL doit interrompre le premier téléchargement",
  );
  await draftLeaf.locator(".source-probe").filter({ hasText: "Flux contrôlé VibeDeck" })
    .waitFor({ state: "visible" });
  assert.equal(
    await draftLeaf.locator(".source-probe li").filter({ hasText: "Article secondaire interclassé 01" }).count(),
    1,
    "La réponse du second test doit rester la seule preview affichée.",
  );
  assert.equal(
    await draftLeaf.locator(".source-probe li").filter({ hasText: "Article de référence 01" }).count(),
    0,
    "Une réponse tardive ne doit pas remplacer le résultat du test courant.",
  );
  assert.equal(
    await draftLeaf.locator(".queued-source-list").filter({ hasText: "test réussi" }).count(),
    1,
    "Une source testée doit être mise en attente sans créer le fil.",
  );
  assert.equal(
    await bbcRow.getAttribute("aria-pressed"),
    "true",
    "La résolution asynchrone ne doit pas écraser une sélection effectuée pendant la sonde.",
  );
  await bbcRow.click();
  const advancedSummary = draftLeaf.locator("summary").filter({ hasText: "Options avancées" });
  await advancedSummary.focus();
  await page.locator(".global-bar").hover();
  await draftLeaf.locator(".dashboard-panel").hover();
  assert.equal(
    await advancedSummary.evaluate((summary) => document.activeElement === summary),
    true,
    "Le survol ne doit pas interrompre le contrôle natif Options avancées.",
  );
  const customFeedName = "Fil temporaire du catalogue";
  await draftFeedName.fill(customFeedName);
  await draftLeaf.getByRole("button", { name: "Créer le fil" }).click();
  await draftLeaf.waitFor({ state: "detached" });
  const customFeedPanelId = await page.evaluate(({ name, inputUrl }) => {
    return window.vibedeck.getState().then((state) => {
      const panel = state.panels.find((candidate) => candidate.kind === "feed" && candidate.name === name);
      const source = state.sources.find((candidate) => candidate.inputUrl === inputUrl);
      if (!panel || panel.kind !== "feed" || !source || !panel.sourceIds.includes(source.id)) return null;
      return panel.id;
    });
  }, { name: customFeedName, inputUrl: `${origin}/feed-secondary.xml` });
  assert.ok(
    customFeedPanelId,
    "Créer un Fil depuis une URL testée doit persister son rattachement exact.",
  );
  const customFeedLeaf = page.locator(
    `.split-layout__leaf[data-panel-id="${customFeedPanelId}"]`,
  );
  await customFeedLeaf.getByLabel("Configurer les sources").click();
  let customFeedDialog = page.getByRole("dialog", { name: "Configuration du fil" });
  await customFeedDialog.waitFor({ state: "visible" });
  const attachedSource = customFeedDialog.locator(".current-source-list > button");
  assert.equal(await attachedSource.getAttribute("aria-pressed"), "true");
  const attachedSourceMarkSize = await attachedSource.locator(".provider-mark").evaluate((mark) => ({
    width: mark.getBoundingClientRect().width,
    height: mark.getBoundingClientRect().height,
  }));
  assertWithin(
    attachedSourceMarkSize.width,
    34,
    0.1,
    "largeur du logo d’une source existante",
  );
  assertWithin(
    attachedSourceMarkSize.height,
    34,
    0.1,
    "hauteur du logo d’une source existante",
  );
  await attachedSource.click();
  assert.equal(await attachedSource.getAttribute("aria-pressed"), "false");
  await customFeedDialog.getByRole("button", { name: "Enregistrer les sources" }).click();
  await customFeedDialog.waitFor({ state: "detached" });
  assert.deepEqual(
    await page.evaluate((panelId) => window.vibedeck.getState().then((state) => {
      const panel = state.panels.find((candidate) => candidate.id === panelId);
      return panel?.kind === "feed" ? panel.sourceIds : null;
    }), customFeedPanelId),
    [],
    "L’édition par le sélecteur partagé doit retirer la source après enregistrement.",
  );

  await customFeedLeaf.getByLabel("Configurer les sources").click();
  customFeedDialog = page.getByRole("dialog", { name: "Configuration du fil" });
  await customFeedDialog.waitFor({ state: "visible" });
  probeDelayMs = 5_000;
  await customFeedDialog.getByLabel("Adresse du site ou du flux")
    .fill(`${origin}/feed-probe-delayed.xml`);
  assert.equal(
    await customFeedDialog.getByRole("button", { name: "Enregistrer les sources" }).isDisabled(),
    true,
    "Enregistrer doit attendre une URL encore dans son délai de vérification.",
  );
  await customFeedDialog.locator(".source-probe--loading").waitFor({ state: "visible" });
  assert.equal(
    await customFeedDialog.getByRole("button", { name: "Enregistrer les sources" }).isDisabled(),
    true,
    "Enregistrer doit rester bloqué pendant une sonde réseau.",
  );
  await waitForLocalCondition(
    () => delayedProbeRequestCount === 2,
    "le test lancé depuis l’édition doit atteindre le serveur",
  );
  await customFeedDialog.getByLabel("Fermer").click();
  await customFeedDialog.waitFor({ state: "detached" });
  await waitForLocalCondition(
    () => delayedProbeAbortCount === 2,
    "fermer l’éditeur doit interrompre le téléchargement en cours",
  );
  assert.equal(
    await page.evaluate((inputUrl) => window.vibedeck.getState().then((state) =>
      state.sources.some((source) => source.inputUrl === inputUrl)), `${origin}/feed-probe-delayed.xml`),
    false,
    "Un test annulé ne doit créer aucune source.",
  );
  await customFeedLeaf.getByLabel("Fermer le panel").click();
  const closeCustomFeedDialog = page.getByRole("alertdialog", { name: /Fermer/ });
  await closeCustomFeedDialog.getByRole("button", { name: "Fermer le panel" }).click();
  await customFeedLeaf.waitFor({ state: "detached" });
  await page.locator(".global-bar").hover();

  await page.keyboard.press("ControlOrMeta+N");
  const webDraftLeaf = page.locator('.split-layout__leaf[data-panel-id^="draft:"]');
  await webDraftLeaf.waitFor({ state: "visible" });
  await webDraftLeaf.getByRole("button", { name: /Page web/ }).click();
  const webNameInput = webDraftLeaf.getByLabel("Nom du panel web");
  await waitForDomFocus(
    page,
    webNameInput,
    "entrer dans le constructeur de page web doit focaliser son premier champ",
  );
  const previewUrl = `${origin}/preview.html`;
  const webUrlInput = webDraftLeaf.getByLabel("URL de la page web");
  const previewButton = webDraftLeaf.getByRole("button", { name: "Prévisualiser" });
  await webUrlInput.fill(previewUrl);
  await waitForInputValue(
    page,
    webUrlInput,
    previewUrl,
    "l’URL de prévisualisation doit être reflétée par l’état contrôlé du formulaire",
  );
  await waitForEnabled(
    page,
    previewButton,
    "le bouton Prévisualiser doit être activé avant le clic",
  );
  await previewButton.click();
  await webDraftLeaf.locator(".web-preview-frame__status").filter({ hasText: "Prêt" })
    .waitFor({ state: "visible" });
  await webDraftLeaf.getByRole("button", { name: "Créer ce panel" }).click();
  await webDraftLeaf.waitFor({ state: "detached" });
  const previewWebPanelId = await page.evaluate(async (expectedUrl) => {
    const state = await window.vibedeck.getState();
    return state.panels.find((panel) => panel.kind === "web" && panel.url === expectedUrl)?.id ?? null;
  }, `${origin}/preview.html`);
  assert.ok(previewWebPanelId, "La preview doit être confirmée depuis son URL main-owned.");
  const previewWebLeaf = page.locator(
    `.split-layout__leaf[data-panel-id="${previewWebPanelId}"]`,
  );
  await waitForNativeWebView(
    electronApp,
    previewUrl,
    true,
    "le panel web du layout splitté doit être visible avant la modale",
  );
  const expectedWebStateProbe = "état de page conservé pendant la modale";
  await setNativeWebViewStateProbe(electronApp, previewUrl, expectedWebStateProbe);
  const visibleWebView = await waitForNativeWebView(
    electronApp,
    previewUrl,
    true,
    "le marqueur d’état doit être lisible avant la modale",
  );
  assert.equal(visibleWebView.stateProbe, expectedWebStateProbe);
  assert.equal(visibleWebView.navigationStarts, 0);
  await publishUpdateState("ready", { availableVersion: "0.4.2" });
  const splitUpdateCta = page.getByRole(
    "button",
    { name: "Mise à jour 0.4.2 prête", exact: true },
  );
  await splitUpdateCta.click();
  const splitUpdateDialog = page.getByRole(
    "alertdialog",
    { name: "Installer VibeDeck 0.4.2 ?" },
  );
  await splitUpdateDialog.waitFor();
  const hiddenWebView = await waitForNativeWebView(
    electronApp,
    previewUrl,
    false,
    "la confirmation de mise à jour doit masquer la vue web native",
  );
  assert.deepEqual(
    {
      id: hiddenWebView.id,
      url: hiddenWebView.url,
      stateProbe: hiddenWebView.stateProbe,
      navigationStarts: hiddenWebView.navigationStarts,
    },
    {
      id: visibleWebView.id,
      url: visibleWebView.url,
      stateProbe: visibleWebView.stateProbe,
      navigationStarts: visibleWebView.navigationStarts,
    },
    "Masquer la vue web ne doit ni la recréer, ni la faire naviguer, ni perdre son état.",
  );
  await page.keyboard.press("Escape");
  await splitUpdateDialog.waitFor({ state: "detached" });
  await page.waitForTimeout(200);
  const restoredWebView = await waitForNativeWebView(
    electronApp,
    previewUrl,
    true,
    "fermer la confirmation doit restaurer la vue web native",
  );
  assert.deepEqual(
    restoredWebView,
    visibleWebView,
    "La vue web restaurée doit conserver son identité, son URL et sa visibilité.",
  );
  await previewWebLeaf.getByLabel("Fermer le panel").click();
  const closePreviewDialog = page.getByRole("alertdialog", { name: /Fermer/ });
  await closePreviewDialog.getByRole("button", { name: "Fermer le panel" }).click();
  await previewWebLeaf.waitFor({ state: "detached" });
  await page.locator(".global-bar").hover();

  const reference = await page.evaluate(async () => {
    const list = document.querySelector(".article-list");
    const rows = [...document.querySelectorAll(".article-row")];
    if (!(list instanceof HTMLElement) || rows.length < 40) {
      throw new Error("Le fil ne contient pas assez d’articles pour tester le scroll.");
    }
    const row = rows[35];
    if (!(row instanceof HTMLElement)) throw new Error("Article de référence invalide.");
    list.scrollTop = row.offsetTop - Math.round(list.clientHeight * 0.3);
    row.focus();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { id: row.id };
  });

  await page.waitForFunction(
    (articleId) => document.querySelector(".article-row--focused")?.id === articleId,
    reference.id,
  );
  const beforeArrival = await readMetrics(page, reference.id);
  assert.ok(beforeArrival.scrollTop > 0, "Le scénario doit commencer dans un fil déjà scrollé.");
  assert.equal(beforeArrival.activeId, reference.id, "L’article doit posséder le focus DOM initial.");
  assert.equal(beforeArrival.focusedId, reference.id, "L’article doit être la sélection clavier initiale.");
  assert.equal(beforeArrival.newInDom, false);

  await page.waitForTimeout(80);
  articles = [
    {
      id: "new-controlled-arrival",
      title: newArticleTitle,
      summary: "Une arrivée ajoutée après la baseline.",
      publishedAt: new Date(),
    },
    ...articles,
  ];
  await page.keyboard.press("r");
  await page.waitForFunction(
    (title) => [...document.querySelectorAll(".article-row")]
      .some((row) => row.textContent?.includes(title)),
    newArticleTitle,
  );
  await page.evaluate(() => new Promise(
    (resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)),
  ));

  const revealed = await readMetrics(page, reference.id);
  assert.equal(primaryRequestCount, 2, "Le rafraîchissement doit relire le flux contrôlé.");
  assert.equal(await page.locator(".feed-arrivals").count(), 0, "Aucun bouton d’arrivée ne doit rester affiché.");
  assert.equal(revealed.newInDom, true, "L’arrivée doit être rendue automatiquement.");
  assert.equal(revealed.newRowIndex, 0, "L’arrivée doit être insérée en tête du fil.");
  assert.equal(revealed.activeId, reference.id, "L’arrivée ne doit pas voler le focus DOM.");
  assert.equal(revealed.focusedId, reference.id, "La sélection clavier doit rester sur le même article.");
  assertWithin(revealed.selectedTop, beforeArrival.selectedTop, 1, "position après insertion");
  assert.ok(revealed.scrollTop > beforeArrival.scrollTop, "Le scroll doit compenser la ligne insérée.");
  const arrivalsPill = page.locator(".arrivals-pill");
  await arrivalsPill.waitFor({ state: "visible" });
  assert.match(
    (await arrivalsPill.textContent()) ?? "",
    /1 nouveau · Afficher/,
    "La pastille doit compter l'arrivée insérée au-dessus du viewport.",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.id ?? null),
    reference.id,
    "La pastille ne doit pas voler le focus à son apparition.",
  );
  const expectedAfterArrowDown = await page.evaluate(
    (articleId) => {
      // Sauter les séparateurs de jour : autour de minuit, l'un d'eux peut
      // s'intercaler entre deux articles adjacents du fil dense.
      let sibling = document.getElementById(articleId)?.nextElementSibling ?? null;
      while (sibling && !sibling.classList.contains("article-row")) {
        sibling = sibling.nextElementSibling;
      }
      return sibling?.id ?? null;
    },
    reference.id,
  );
  assert.ok(expectedAfterArrowDown, "L’article suivant après insertion doit exister.");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    (articleId) => document.activeElement?.id === articleId,
    expectedAfterArrowDown,
  );

  await page.evaluate(() => {
    const list = document.querySelector(".article-list");
    if (!(list instanceof HTMLElement)) throw new Error("Le fil principal est introuvable.");
    list.scrollTop = 0;
  });
  await arrivalsPill.waitFor({ state: "detached" });
  articles = [
    {
      id: "old-controlled-arrival",
      title: oldArrivalTitle,
      summary: "Cette arrivée reste nouvelle sans devancer une arrivée éditorialement plus récente.",
      publishedAt: new Date(baselineTime - 10 * 24 * 60 * 60 * 1_000),
    },
    ...articles,
  ];
  await page.evaluate((id) => window.vibedeck.refreshSource(id), sourceId);
  const oldArrivalRow = page.locator(".article-row").filter({ hasText: oldArrivalTitle });
  await oldArrivalRow.waitFor({ state: "visible" });
  assert.deepEqual(
    await page.locator(".article-row").evaluateAll((rows, titles) => titles.map((title) =>
      rows.findIndex((row) => row.textContent?.includes(title))), [newArticleTitle, oldArrivalTitle]),
    [0, 1],
    "Une arrivée ancienne doit suivre l’arrivée éditorialement plus récente tout en restant devant la baseline.",
  );
  assert.match(
    (await oldArrivalRow.locator("time").textContent()) ?? "",
    /^\d{2}\/\d{2}(?:\/\d{2})? \d{2}:\d{2}$/,
    "Une date éditoriale ancienne doit rester explicite dans le fil.",
  );
  assert.equal(
    await page.locator(".article-list").evaluate((list) => list.scrollTop),
    0,
    "Une arrivée classée sous la première ligne ne doit pas déplacer le viewport déjà en tête.",
  );
  assert.equal(
    await arrivalsPill.count(),
    0,
    "Une arrivée ancienne déjà visible ne doit pas afficher de pastille.",
  );

  articles = [
    {
      id: "top-arrival",
      title: topArrivalTitle,
      summary: "Cette arrivée doit rester visible au sommet du fil.",
      publishedAt: new Date(),
    },
    ...articles,
  ];
  await page.evaluate((id) => window.vibedeck.refreshSource(id), sourceId);
  await page.locator(".article-row").filter({ hasText: topArrivalTitle }).waitFor({ state: "visible" });
  assert.equal(
    await page.locator(".article-list").evaluate((list) => list.scrollTop),
    0,
    "Une arrivée reçue en haut du fil doit conserver scrollTop à zéro.",
  );
  assert.equal(
    await arrivalsPill.count(),
    0,
    "Une arrivée déjà visible en haut du fil ne doit pas afficher de pastille.",
  );

  // Pastille « nouveaux » : cliquer ramène en haut du fil et sélectionne la
  // première rangée ; l'insertion, elle, n'attend jamais ce clic.
  const pillReference = await page.evaluate(async () => {
    const list = document.querySelector(".article-list");
    const rows = [...document.querySelectorAll(".article-row")];
    const row = rows[30];
    if (!(list instanceof HTMLElement) || !(row instanceof HTMLElement)) {
      throw new Error("La référence du scénario de pastille est introuvable.");
    }
    list.scrollTop = row.offsetTop - Math.round(list.clientHeight * 0.3);
    row.focus();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { id: row.id };
  });
  articles = [
    {
      id: "pill-arrival",
      title: pillArrivalTitle,
      summary: "Cette arrivée alimente la pastille de rappel.",
      publishedAt: new Date(),
    },
    ...articles,
  ];
  await page.evaluate((id) => window.vibedeck.refreshSource(id), sourceId);
  await page.locator(".article-row").filter({ hasText: pillArrivalTitle }).first()
    .waitFor({ state: "attached" });
  await arrivalsPill.waitFor({ state: "visible" });
  assert.match(
    (await arrivalsPill.textContent()) ?? "",
    /1 nouveau · Afficher/,
    "La pastille doit compter la nouvelle arrivée hors viewport.",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.id ?? null),
    pillReference.id,
    "L'arrivée comptée par la pastille ne doit pas déplacer le focus.",
  );
  await arrivalsPill.click();
  await page.waitForFunction(
    () => document.querySelector(".article-list")?.scrollTop === 0,
  );
  await arrivalsPill.waitFor({ state: "detached" });
  const firstRowIdAfterPill = await page.locator(".article-row").first().getAttribute("id");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id ?? null),
    firstRowIdAfterPill,
    "Cliquer la pastille doit sélectionner la première rangée du fil.",
  );
  assert.equal(
    await page.locator(".feed-arrivals").count(),
    0,
    "La pastille ne doit jamais devenir un bouton-barrière d'insertion.",
  );

  const readerSourceRow = page.locator(".article-row").first();
  const readerSourceId = await readerSourceRow.getAttribute("id");
  await readerSourceRow.focus();
  const readerDecisionStartedAt = performance.now();
  await page.keyboard.press("Enter");
  await page.locator(".link-reader").waitFor({ state: "visible" });
  await page
    .locator(".link-reader__toolbar .web-address")
    .filter({ hasText: "Page originale · lecture simplifiée indisponible" })
    .waitFor({ state: "visible" });
  assert.ok(
    performance.now() - readerDecisionStartedAt < 1_000,
    "La décision du lecteur doit rester sous une seconde.",
  );
  // Fenêtre cachée : le focus OS n'existe pas, isFocused() reste faux côté
  // main process. Le contrat de focus est prouvé après Échap par le retour de
  // document.activeElement sur la ligne du fil ; ici on attend seulement que
  // le lecteur soit chargé (et focalisé quand la fenêtre est affichée).
  await electronApp.evaluate(async ({ webContents }, { articlePrefix, requireFocus }) => {
    let reader;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      reader = webContents
        .getAllWebContents()
        .find((contents) =>
          contents.getURL().startsWith(articlePrefix) &&
          !contents.isLoading() &&
          (!requireFocus || contents.isFocused()));
      if (reader) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!reader) throw new Error("Le lecteur natif focalisé est introuvable.");
    reader.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    reader.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  }, { articlePrefix: `${origin}/articles/`, requireFocus: showWindow });
  await page.locator(".link-reader").waitFor({ state: "detached" });
  await page.waitForFunction(
    (articleId) => document.activeElement?.id === articleId,
    readerSourceId,
  );
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    (previousId) => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active.classList.contains("article-row") && active.id !== previousId;
    },
    readerSourceId,
  );

  const narrowPanelId = await page.evaluate(async (targetPanelId) => {
    const before = await window.vibedeck.getState();
    const existingIds = new Set(before.panels.map(({ id }) => id));
    const next = await window.vibedeck.createPanel(
      {
        kind: "feed",
        name: "Panel étroit témoin",
        defaultRefreshIntervalSeconds: 1_800,
      },
      { targetPanelId, side: "right" },
    );
    return next.panels.find(({ id }) => !existingIds.has(id))?.id ?? null;
  }, panelId);
  assert.ok(narrowPanelId, "Le panel témoin étroit doit être créé.");
  await page.evaluate(
    async ({ targetPanelId, feedUrl }) => window.vibedeck.addSource(targetPanelId, {
      url: feedUrl,
      connectorKind: "rss",
      refreshIntervalSeconds: 1_800,
    }),
    { targetPanelId: narrowPanelId, feedUrl: `${origin}/feed-redirect.xml` },
  );
  assert.equal(
    primaryRequestCount,
    5,
    "Réutiliser un connecteur existant dans un autre panel ne doit pas le retélécharger.",
  );
  const narrowWindow = await electronApp.browserWindow(page);
  await narrowWindow.evaluate((window) => window.setSize(900, 820));
  await narrowWindow.dispose();
  const panelLeaf = page.locator(`.split-layout__leaf[data-panel-id="${panelId}"]`);
  const narrowLeaf = page.locator(`.split-layout__leaf[data-panel-id="${narrowPanelId}"]`);
  await page.waitForFunction(
    ({ targetPanelId, count }) =>
      document.querySelectorAll(
        `.split-layout__leaf[data-panel-id="${targetPanelId}"] .article-row`,
      ).length === count,
    { targetPanelId: narrowPanelId, count: initialArticleCount + 4 },
  );
  await page.waitForFunction(
    (targetPanelId) => {
      const panel = document.querySelector(
        `.split-layout__leaf[data-panel-id="${targetPanelId}"] .dashboard-panel`,
      );
      return panel instanceof HTMLElement && panel.getBoundingClientRect().width < 520;
    },
    panelId,
  );
  await panelLeaf.locator(".feed-toolbar__freshness-compact").waitFor({ state: "visible" });
  assert.equal(
    await panelLeaf.locator(".feed-toolbar__freshness-full").isHidden(),
    true,
    "Le libellé long doit céder la place au résumé compact dans un panel étroit.",
  );
  assert.equal(
    await panelLeaf.locator(".feed-toolbar__freshness").isVisible(),
    true,
    "La fraîcheur doit rester visible dans un dashboard splitté.",
  );
  const compactRefreshCountdown = panelLeaf.locator(".feed-toolbar__freshness-compact");
  const refreshCountdownBefore = await compactRefreshCountdown.textContent();
  await page.waitForFunction(
    ({ targetPanelId, previous }) => {
      const current = document.querySelector(
        `.split-layout__leaf[data-panel-id="${targetPanelId}"] .feed-toolbar__freshness-compact`,
      )?.textContent;
      return Boolean(current && current !== previous);
    },
    { targetPanelId: panelId, previous: refreshCountdownBefore },
  );

  const divider = page.getByRole("separator", { name: "Redimensionner les panels" }).first();
  await divider.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const separator = document.querySelector('[role="separator"]');
    return separator?.getAttribute("aria-valuenow") === separator?.getAttribute("aria-valuemax");
  });
  const splitWidths = await page.locator(".split-layout__leaf").evaluateAll((leaves) =>
    leaves.map((leaf) => leaf.getBoundingClientRect().width),
  );
  assert.ok(
    splitWidths.every((width) => width + SUBPIXEL_EPSILON >= MIN_PANEL_WIDTH),
    `Chaque panel doit conserver au moins 256 px utiles après redimensionnement : ${splitWidths.join(", ")}`,
  );
  const compactReadState = narrowLeaf.locator(".article-meta em").first();
  await compactReadState.waitFor({ state: "visible" });
  assert.match(
    (await compactReadState.textContent()) ?? "",
    /Nouveau|Vu|Ouvert/,
    "L’état de lecture doit rester explicite dans le panel le plus étroit.",
  );

  // L'icône reste lisible dans un fil étroit et ne provoque aucun débordement.
  assert.equal(
    await narrowLeaf.locator(".article-provider .provider-mark").first().isVisible(),
    true,
    "L'icône de source doit rester visible dans le panel le plus étroit.",
  );
  assert.equal(
    await narrowLeaf.locator(".article-list").evaluate(
      (list) => list.scrollWidth <= list.clientWidth,
    ),
    true,
    "Le fil dense étroit ne doit jamais déborder horizontalement.",
  );

  const searchOrigin = panelLeaf.locator(".article-row").nth(12);
  const searchOriginId = await searchOrigin.getAttribute("id");
  assert.ok(searchOriginId, "L’article d’origine de la recherche doit être identifiable.");
  await searchOrigin.evaluate((row) => {
    const list = row.closest(".article-list");
    if (!(list instanceof HTMLElement) || !(row instanceof HTMLElement)) {
      throw new Error("Origine de recherche invalide.");
    }
    list.scrollTop = row.offsetTop - 60;
    row.focus({ preventScroll: true });
  });
  const searchOriginScrollTop = await panelLeaf.locator(".article-list").evaluate(
    (list) => list.scrollTop,
  );

  await page.keyboard.press("ControlOrMeta+K");
  const searchPalette = page.locator("dialog.search-palette");
  await searchPalette.waitFor({ state: "visible" });
  const searchInput = searchPalette.getByLabel("Requête");
  assert.equal(
    await searchInput.evaluate((input) => document.activeElement === input),
    true,
    "Cmd/Ctrl + K doit donner le vrai focus DOM au champ de recherche.",
  );
  await searchInput.fill("article");
  const chronologicalSearchResults = searchPalette.locator(".search-palette__result");
  await chronologicalSearchResults.first().waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    document.querySelector("#semantic-search-results")?.getAttribute("data-result-mode") === "hybrid");
  assert.deepEqual(
    await chronologicalSearchResults.locator(".search-palette__result-copy > b").evaluateAll(
      (titles) => titles.slice(0, 5).map((title) => title.textContent),
    ),
    [
      "Article de référence 01 — titre suffisamment long pour stabiliser la hauteur",
      "Article secondaire interclassé 01",
      "Article de référence 02 — titre suffisamment long pour stabiliser la hauteur",
      "Article secondaire interclassé 02",
      "Article de référence 03 — titre suffisamment long pour stabiliser la hauteur",
    ],
    "La recherche doit reprendre la chronologie globale du fil sans regrouper les journaux.",
  );
  await searchInput.fill("référence 42");
  await searchPalette.locator(".search-palette__result").first().waitFor({ state: "visible" });
  assert.equal(
    await searchInput.evaluate((input) => document.activeElement === input),
    true,
    "L’arrivée des résultats ne doit pas retirer le focus du champ.",
  );
  const sharedResultMeta = await searchPalette
    .locator(".search-palette__result-meta")
    .first()
    .textContent();
  assert.match(sharedResultMeta ?? "", /Preuve viewport/);
  assert.match(sharedResultMeta ?? "", /Panel étroit témoin/);
  await page.screenshot({ path: path.join(projectRoot, ".context", "search-palette.png") });

  await page.keyboard.press("Enter");
  await searchPalette.waitFor({ state: "detached" });
  await page.locator(".search-filter-summary").waitFor({ state: "visible" });
  assert.equal(
    await page.locator(".feed-toolbar__search-state").count(),
    2,
    "Chaque Fil concerné doit signaler le filtre actif.",
  );
  assert.equal(
    await panelLeaf.locator(".article-row").count(),
    1,
    "Entrée depuis le champ doit appliquer le filtre au Fil principal.",
  );
  assert.equal(
    await narrowLeaf.locator(".article-row").count(),
    1,
    "Le même filtre doit s’appliquer au Fil partageant la source.",
  );

  await page.locator(".search-filter-summary").click();
  await searchPalette.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await searchPalette.waitFor({ state: "detached" });
  assert.equal(
    await page.locator(".search-filter-summary").isVisible(),
    true,
    "Le premier Échap doit fermer la palette sans retirer le filtre actif.",
  );
  await page.keyboard.press("Escape");
  await page.locator(".search-filter-summary").waitFor({ state: "detached" });
  await page.waitForFunction(
    (articleId) => document.activeElement?.id === articleId,
    searchOriginId,
  );
  assertWithin(
    await panelLeaf.locator(".article-list").evaluate((list) => list.scrollTop),
    searchOriginScrollTop,
    1,
    "scrollTop restauré après retrait du filtre",
  );

  await page.keyboard.press("ControlOrMeta+K");
  await searchPalette.waitFor({ state: "visible" });
  await searchPalette.getByLabel("Requête").fill("référence 42");
  await searchPalette.locator(".search-palette__result").first().hover();
  await searchPalette.getByRole("button", { name: "Filtrer" }).click();
  await searchPalette.waitFor({ state: "detached" });
  await page.locator(".search-filter-summary").waitFor({ state: "visible" });
  assert.equal(
    await page.locator(".link-reader").count(),
    0,
    "Le bouton Filtrer doit appliquer la recherche même après le survol d’un résultat.",
  );
  await page.keyboard.press("Escape");
  await page.locator(".search-filter-summary").waitFor({ state: "detached" });

  await page.keyboard.press("ControlOrMeta+K");
  await searchPalette.waitFor({ state: "visible" });
  await searchPalette.getByLabel("Requête").fill("référence 42");
  await searchPalette.locator(".search-palette__result").first().waitFor({ state: "visible" });
  await page.keyboard.press("ArrowDown");
  assert.match(
    (await searchPalette.getByLabel("Requête").getAttribute("aria-activedescendant")) ?? "",
    /^semantic-search-result-/,
    "ArrowDown doit activer un résultat sans déplacer le focus hors du champ.",
  );
  await page.keyboard.press("ArrowUp");
  assert.equal(
    await searchPalette.getByLabel("Requête").getAttribute("aria-activedescendant"),
    null,
    "ArrowUp depuis le premier résultat doit revenir à l’état de saisie.",
  );
  await page.keyboard.press("Enter");
  await searchPalette.waitFor({ state: "detached" });
  await page.locator(".search-filter-summary").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator(".search-filter-summary").waitFor({ state: "detached" });

  await page.keyboard.press("ControlOrMeta+K");
  await searchPalette.waitFor({ state: "visible" });
  await searchPalette.getByLabel("Requête").fill("article");
  const firstChronologicalResult = searchPalette.locator(".search-palette__result").first();
  const secondChronologicalResult = searchPalette.locator(".search-palette__result").nth(1);
  await firstChronologicalResult.waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    document.querySelector("#semantic-search-results")?.getAttribute("data-result-mode") === "hybrid");
  const firstChronologicalResultId = await firstChronologicalResult.getAttribute("id");
  const secondChronologicalResultId = await secondChronologicalResult.getAttribute("id");
  assert.ok(firstChronologicalResultId, "Le premier résultat chronologique doit être identifiable.");
  assert.ok(secondChronologicalResultId, "Le deuxième résultat chronologique doit être identifiable.");
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await searchPalette.getByLabel("Requête").getAttribute("aria-activedescendant"),
    firstChronologicalResultId,
    "ArrowDown doit sélectionner le premier résultat dans l’ordre chronologique affiché.",
  );
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await searchPalette.getByLabel("Requête").getAttribute("aria-activedescendant"),
    secondChronologicalResultId,
    "Le deuxième ArrowDown doit suivre l’interclassement chronologique affiché.",
  );
  await page.keyboard.press("Enter");
  await searchPalette.waitFor({ state: "detached" });
  const chronologicalReader = page.locator(".link-reader");
  await chronologicalReader.waitFor({ state: "visible" });
  assert.equal(
    (await chronologicalReader.locator(".link-reader__title").textContent())?.trim(),
    "Article secondaire interclassé 01",
    "Entrée doit ouvrir le deuxième résultat interclassé de la chronologie affichée.",
  );
  await page.keyboard.press("Escape");
  await chronologicalReader.waitFor({ state: "detached" });

  await page.keyboard.press("ControlOrMeta+K");
  await searchPalette.waitFor({ state: "visible" });
  await searchPalette.getByLabel("Requête").fill("article");
  await page.waitForFunction(() =>
    document.querySelector("#semantic-search-results")?.getAttribute("data-result-mode") === "hybrid");
  const hoveredChronologicalResult = searchPalette.locator(".search-palette__result").nth(1);
  const hoveredChronologicalResultId = await hoveredChronologicalResult.getAttribute("id");
  assert.ok(hoveredChronologicalResultId, "Le résultat interclassé survolé doit être identifiable.");
  await hoveredChronologicalResult.hover();
  assert.equal(
    await searchPalette.getByLabel("Requête").getAttribute("aria-activedescendant"),
    hoveredChronologicalResultId,
    "Le survol doit sélectionner l’article rendu à cette position chronologique.",
  );
  await page.keyboard.press("Enter");
  await searchPalette.waitFor({ state: "detached" });
  await chronologicalReader.waitFor({ state: "visible" });
  assert.equal(
    (await chronologicalReader.locator(".link-reader__title").textContent())?.trim(),
    "Article secondaire interclassé 01",
    "Entrée après survol doit ouvrir le résultat interclassé sélectionné.",
  );
  await page.keyboard.press("Escape");
  await chronologicalReader.waitFor({ state: "detached" });
  console.log("✓ recherche live: focus direct, source partagée, filtre explicite et navigation clavier");

  await panelLeaf.locator(".dashboard-panel").focus();
  await page.waitForFunction(
    (targetPanelId) => document
      .querySelector(`.split-layout__leaf[data-panel-id="${targetPanelId}"] .dashboard-panel`)
      ?.classList.contains("dashboard-panel--focused"),
    panelId,
  );
  // Les deux événements doivent partager le même tour du renderer : deux
  // appels CDP successifs peuvent dépasser le seuil produit de 360 ms sous
  // charge en CI, sans reproduire la cadence réelle d'une double-flèche.
  await panelLeaf.locator(".dashboard-panel").evaluate((panel) => {
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  await page.waitForFunction(
    (targetPanelId) =>
      document
        .querySelector(`.split-layout__leaf[data-panel-id="${targetPanelId}"] .dashboard-panel`)
        ?.classList.contains("dashboard-panel--focused"),
    narrowPanelId,
  );
  assert.equal(
    await narrowLeaf.locator(".dashboard-panel").evaluate(
      (panel) => document.activeElement === panel,
    ),
    true,
    "Changer de panel au clavier doit lui transférer le focus DOM.",
  );
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    (targetPanelId) => {
      const leaf = document.querySelector(
        `.split-layout__leaf[data-panel-id="${targetPanelId}"]`,
      );
      return leaf?.querySelector(".article-row")?.closest(".split-layout__leaf") === leaf &&
        document.activeElement?.closest(".split-layout__leaf") === leaf &&
        document.activeElement?.classList.contains("article-row");
    },
    narrowPanelId,
  );
  const sharedReaderSourceId = await page.evaluate(() => document.activeElement?.id ?? null);
  assert.ok(sharedReaderSourceId, "Le panel partagé doit exposer un article actif.");
  await page.keyboard.press("Enter");
  await page.locator(".link-reader").waitFor({ state: "visible" });
  await electronApp.evaluate(async ({ webContents }, articlePrefix) => {
    let reader;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      reader = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(articlePrefix));
      if (reader) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!reader) throw new Error("Le lecteur du panel partagé est introuvable.");
    reader.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    reader.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  }, `${origin}/articles/`);
  await page.locator(".link-reader").waitFor({ state: "detached" });
  await page.waitForFunction(
    ({ articleId, targetPanelId }) =>
      document.activeElement?.id === articleId &&
      document.activeElement?.closest(".split-layout__leaf")?.getAttribute("data-panel-id") ===
        targetPanelId,
    { articleId: sharedReaderSourceId, targetPanelId: narrowPanelId },
  );

  await narrowLeaf.getByLabel("Agrandir", { exact: true }).click();
  await page.waitForFunction(
    (targetPanelId) =>
      document.querySelector(".split-layout")?.getAttribute("data-maximized-panel-id") ===
      targetPanelId,
    narrowPanelId,
  );
  await narrowLeaf.locator(".dashboard-panel").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    (targetPanelId) => {
      const layout = document.querySelector(".split-layout");
      const panel = document.querySelector(
        `.split-layout__leaf[data-panel-id="${targetPanelId}"] .dashboard-panel`,
      );
      return layout?.getAttribute("data-maximized-panel-id") === targetPanelId &&
        document.activeElement === panel;
    },
    panelId,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector(".split-layout")?.hasAttribute("data-maximized-panel-id"),
  );

  const primaryTitle = panelLeaf.locator(".panel-title");
  const primarySplitAction = panelLeaf.getByLabel("Diviser côte à côte");
  await primarySplitAction.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForFunction(
    (targetPanelId) =>
      document.querySelector(".split-layout__leaf")?.getAttribute("data-panel-id") !== targetPanelId,
    panelId,
  );
  assert.equal(
    await primaryTitle.evaluate((title) => document.activeElement === title),
    true,
    "Une action masquée dans le panel étroit doit rendre le focus au titre durable.",
  );
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForFunction(
    (targetPanelId) =>
      document.querySelector(".split-layout__leaf")?.getAttribute("data-panel-id") === targetPanelId,
    panelId,
  );
  await primaryTitle.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForFunction(
    (targetPanelId) =>
      document.querySelector(".split-layout__leaf")?.getAttribute("data-panel-id") !== targetPanelId,
    panelId,
  );
  assert.equal(
    await primaryTitle.evaluate((title) => document.activeElement === title),
    true,
    "Le titre déplacé doit conserver le focus clavier.",
  );
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForFunction(
    (targetPanelId) =>
      document.querySelector(".split-layout__leaf")?.getAttribute("data-panel-id") === targetPanelId,
    panelId,
  );
  assert.equal(
    await primaryTitle.evaluate((title) => document.activeElement === title),
    true,
    "Le focus doit suivre le panel après le déplacement inverse.",
  );

  const sourceFilters = panelLeaf.locator('[data-panel-focus-key^="feed-filter:source:"]');
  assert.equal(
    await sourceFilters.count(),
    2,
    "Le scénario doit contenir deux filtres homonymes mais identifiés séparément.",
  );
  const secondSourceFilter = sourceFilters.nth(1);
  const secondSourceFocusKey = await secondSourceFilter.getAttribute("data-panel-focus-key");
  assert.ok(secondSourceFocusKey, "Le filtre source doit avoir une clé de focus stable.");
  await secondSourceFilter.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForFunction(
    ({ targetPanelId, focusKey }) => {
      const panel = document.querySelector(
        `.split-layout__leaf[data-panel-id="${targetPanelId}"] .dashboard-panel`,
      );
      return panel?.querySelector(`[data-panel-focus-key="${focusKey}"]`) === document.activeElement;
    },
    { targetPanelId: panelId, focusKey: secondSourceFocusKey },
  );
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForFunction(
    ({ targetPanelId, focusKey }) => {
      const panel = document.querySelector(
        `.split-layout__leaf[data-panel-id="${targetPanelId}"] .dashboard-panel`,
      );
      return panel?.querySelector(`[data-panel-focus-key="${focusKey}"]`) === document.activeElement;
    },
    { targetPanelId: panelId, focusKey: secondSourceFocusKey },
  );

  primaryDelayMs = 350;
  await panelLeaf.getByLabel("Actualiser ce panel").click();
  await panelLeaf.locator('[aria-label*="actualisation en cours"]').first()
    .waitFor({ state: "visible" });
  await page.locator(".toast").filter({ hasText: "Panel actualisé" })
    .waitFor({ state: "visible" });

  primaryShouldFail = true;
  await panelLeaf.getByLabel("Actualiser ce panel").click();
  await page.locator(".toast").filter({ hasText: "1 source indisponible · cache conservé" })
    .waitFor({ state: "visible" });
  const errorNotice = panelLeaf.locator('.panel-notice[aria-label="Sources indisponibles"]');
  await errorNotice.waitFor({ state: "visible" });
  assert.match(
    (await errorNotice.textContent()) ?? "",
    /échec.+dernière réussite.+Le cache reste affiché\./,
    "L’échec manuel doit indiquer sa date, la dernière réussite et la conservation du cache.",
  );
  assert.equal(
    await panelLeaf.locator(".article-row").count(),
    baselineArticleCount + 4,
    "Une panne de rafraîchissement ne doit retirer aucun article en cache.",
  );

  primaryShouldFail = false;
  await page.evaluate((id) => window.vibedeck.refreshSource(id), sourceId);
  await errorNotice.waitFor({ state: "detached" });
  const sharedViewportBefore = await page.evaluate(({ firstPanelId, secondPanelId }) => {
    const measure = (panelId) => {
      const leaf = document.querySelector(`.split-layout__leaf[data-panel-id="${panelId}"]`);
      const list = leaf?.querySelector(".article-list");
      const rows = [...(leaf?.querySelectorAll(".article-row") ?? [])];
      const reference = rows[20];
      if (!(list instanceof HTMLElement) || !(reference instanceof HTMLElement)) {
        throw new Error("Le panel partagé ne contient pas assez d’articles.");
      }
      list.scrollTop = reference.offsetTop - Math.round(list.clientHeight * 0.3);
      return {
        panelId,
        referenceId: reference.id,
        scrollTop: list.scrollTop,
        referenceTop: reference.getBoundingClientRect().top,
      };
    };
    return [measure(firstPanelId), measure(secondPanelId)];
  }, { firstPanelId: panelId, secondPanelId: narrowPanelId });
  articles = [
    {
      id: "shared-panel-arrival",
      title: sharedArrivalTitle,
      summary: "Cette arrivée doit préserver chaque viewport partagé.",
      publishedAt: new Date(),
    },
    {
      id: "shared-panel-arrival-second",
      title: sharedSecondArrivalTitle,
      summary: "Une deuxième arrivée simultanée pour la compensation.",
      publishedAt: new Date(),
    },
    ...articles,
  ];
  await page.evaluate((id) => window.vibedeck.refreshSource(id), sourceId);
  const sharedRows = panelLeaf.locator(".article-row").filter({ hasText: sharedArrivalTitle });
  const sharedSiblingRow = narrowLeaf.locator(".article-row").filter({ hasText: sharedArrivalTitle });
  await sharedRows.waitFor({ state: "visible" });
  await sharedSiblingRow.waitFor({ state: "visible" });
  assert.equal(await page.locator(".feed-arrivals").count(), 0, "Aucune arrivée ne doit attendre une action utilisateur.");
  const sharedViewportAfter = await page.evaluate((before) => before.map(({ panelId, referenceId }) => {
    const leaf = document.querySelector(`.split-layout__leaf[data-panel-id="${panelId}"]`);
    const list = leaf?.querySelector(".article-list");
    const reference = document.getElementById(referenceId);
    if (!(list instanceof HTMLElement) || !(reference instanceof HTMLElement)) {
      throw new Error("La référence de viewport partagé est introuvable.");
    }
    return {
      panelId,
      scrollTop: list.scrollTop,
      referenceTop: reference.getBoundingClientRect().top,
    };
  }), sharedViewportBefore);
  for (const before of sharedViewportBefore) {
    const after = sharedViewportAfter.find(({ panelId: candidate }) => candidate === before.panelId);
    assert.ok(after, "Chaque panel partagé doit conserver sa mesure de viewport.");
    assertWithin(after.referenceTop, before.referenceTop, 1, `position partagée ${before.panelId}`);
    assert.ok(after.scrollTop > before.scrollTop, `Le panel ${before.panelId} doit compenser ses arrivées simultanées.`);
  }

  await narrowLeaf.getByLabel("Configurer les sources").click();
  const feedConfigDialog = page.getByRole("dialog", { name: "Configuration du fil" });
  const configFeedName = feedConfigDialog.getByLabel("Nom du fil");
  assert.equal(
    await configFeedName.evaluate((input) => document.activeElement === input),
    true,
    "La configuration doit focaliser le nom du Fil et enfermer le clavier dans la modale.",
  );
  const saveFeedConfiguration = feedConfigDialog.getByRole("button", { name: "Enregistrer" });
  await saveFeedConfiguration.focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await feedConfigDialog.getByRole("button", { name: "Fermer" }).evaluate(
      (button) => document.activeElement === button,
    ),
    true,
    "Tab depuis le dernier contrôle doit reboucler dans la modale.",
  );
  await saveFeedConfiguration.click();
  await feedConfigDialog.waitFor({ state: "detached" });
  await sharedSiblingRow.waitFor({ state: "visible" });

  const temporaryPanelId = await page.evaluate(async (targetPanelId) => {
    const before = await window.vibedeck.getState();
    const knownIds = new Set(before.panels.map(({ id }) => id));
    const next = await window.vibedeck.createPanel(
      { kind: "feed", name: "Panel temporaire", defaultRefreshIntervalSeconds: 1_800 },
      { targetPanelId, side: "bottom" },
    );
    return next.panels.find(({ id }) => !knownIds.has(id))?.id ?? null;
  }, panelId);
  assert.ok(temporaryPanelId, "Le panel temporaire doit être créé.");
  const temporaryLeaf = page.locator(
    `.split-layout__leaf[data-panel-id="${temporaryPanelId}"]`,
  );
  await temporaryLeaf.getByLabel("Fermer le panel").click();
  const closeDialog = page.getByRole("alertdialog", { name: /Fermer « Panel temporaire »/ });
  await closeDialog.getByRole("button", { name: "Fermer le panel" }).click();
  await temporaryLeaf.waitFor({ state: "detached" });
  await sharedSiblingRow.waitFor({ state: "visible" });

  const sharedItemId = await page.evaluate(async (title) => {
    const state = await window.vibedeck.getState();
    const item = state.items.find((candidate) => candidate.title === title);
    if (!item) throw new Error("L’arrivée partagée est introuvable.");
    await window.vibedeck.markItemOpened(item.id);
    return item.id;
  }, sharedArrivalTitle);
  assert.ok(sharedItemId, "L’arrivée partagée doit posséder un identifiant.");
  await sharedSiblingRow.waitFor({ state: "visible" });
  assert.match(
    (await sharedSiblingRow.locator(".article-meta em").textContent()) ?? "",
    /Ouvert/,
    "Le panel voisin doit révéler à la demande l’état global déjà ouvert.",
  );

  const panelOrderBeforeDrag = await page.locator(".split-layout__leaf").evaluateAll((leaves) =>
    leaves.map((leaf) => leaf.getAttribute("data-panel-id")),
  );
  const externalDragResult = await page.evaluate((targetPanelId) => {
    const target = document.querySelector(
      `.split-layout__leaf[data-panel-id="${targetPanelId}"]`,
    );
    if (!(target instanceof HTMLElement)) throw new Error("Panel cible introuvable.");
    const dispatch = (transfer) => {
      const over = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      const drop = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      target.dispatchEvent(over);
      target.dispatchEvent(drop);
      return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented };
    };
    const plainTransfer = new DataTransfer();
    plainTransfer.setData("text/plain", "https://external.test/article");
    const forgedTransfer = new DataTransfer();
    forgedTransfer.setData("application/x-vibedeck-panel", "panel-inconnu");
    return {
      plain: dispatch(plainTransfer),
      forgedWithoutActiveDrag: dispatch(forgedTransfer),
    };
  }, narrowPanelId);
  assert.deepEqual(
    externalDragResult,
    {
      plain: { overPrevented: false, dropPrevented: false },
      forgedWithoutActiveDrag: { overPrevented: false, dropPrevented: false },
    },
    "Un glisser externe doit être ignoré sans MIME interne et drag actif concordants.",
  );
  assert.deepEqual(
    await page.locator(".split-layout__leaf").evaluateAll((leaves) =>
      leaves.map((leaf) => leaf.getAttribute("data-panel-id")),
    ),
    panelOrderBeforeDrag,
    "Un texte externe ne doit jamais remplacer un identifiant de panel.",
  );

  await page.evaluate(async ({ sourcePanelId, targetPanelId }) => {
    const source = document.querySelector(
      `.split-layout__leaf[data-panel-id="${sourcePanelId}"] .panel-header`,
    );
    if (!(source instanceof HTMLElement)) throw new Error("En-tête source introuvable.");
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const target = document.querySelector(
      `.split-layout__leaf[data-panel-id="${targetPanelId}"]`,
    );
    if (!(target instanceof HTMLElement)) throw new Error("Panel cible introuvable.");
    target.dispatchEvent(new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    target.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, { sourcePanelId: panelId, targetPanelId: narrowPanelId });
  await page.waitForFunction(
    (expectedFirstPanelId) =>
      document.querySelector(".split-layout__leaf")?.getAttribute("data-panel-id") ===
      expectedFirstPanelId,
    narrowPanelId,
  );
  assert.deepEqual(
    await page.locator(".split-layout__leaf").evaluateAll((leaves) =>
      leaves.map((leaf) => leaf.getAttribute("data-panel-id")),
    ),
    [...panelOrderBeforeDrag].reverse(),
    "Le MIME interne et le drag actif doivent continuer à échanger les deux panels.",
  );

  // Marquage « vu » par survol : seule une immobilité prolongée sur une ligne compte.
  const dwellTitle = "ARRIVÉE DWELL — survol prolongé marque « vu »";
  const globalBar = page.locator(".global-bar");
  const globalBarBox = await globalBar.boundingBox();
  const dwellProbeAttempts = 3;
  let dwellRow = null;
  let dwellId = null;
  let dwellProbeExitDelay = null;
  for (let attempt = 1; attempt <= dwellProbeAttempts; attempt += 1) {
    const probeTitle = `${dwellTitle} (essai ${attempt})`;
    articles = [
      {
        id: `dwell-arrival-${attempt}`,
        title: probeTitle,
        summary: "Doit passer « vue » uniquement après un survol maintenu.",
        publishedAt: new Date(),
      },
      ...articles,
    ];
    await page.evaluate((id) => window.vibedeck.refreshSource(id), sourceId);
    dwellRow = page.locator(".article-row").filter({ hasText: probeTitle }).first();
    await dwellRow.waitFor({ state: "visible" });
    dwellId = await dwellRow.getAttribute("id");
    assert.equal(
      await dwellRow.evaluate((row) => row.classList.contains("article-row--seen")),
      false,
      "Une arrivée fraîche doit être non vue avant tout survol.",
    );
    // Survol bref puis sortie du fil avant le délai : le marquage est annulé.
    // Deux mouvements souris bruts dos à dos, sans checks d'actionabilité
    // entre l'armement du minuteur et la sortie, pour que la sortie précède
    // largement le délai de dwell même sur un runner lent. Si la sortie est
    // quand même trop tardive pour prouver l'annulation, nouvel article et
    // nouvel essai plutôt qu'un verdict ambigu.
    await dwellRow.scrollIntoViewIfNeeded();
    const dwellRowBox = await dwellRow.boundingBox();
    const enteredAt = Date.now();
    await page.mouse.move(
      dwellRowBox.x + dwellRowBox.width / 2,
      dwellRowBox.y + dwellRowBox.height / 2,
    );
    await page.mouse.move(
      globalBarBox.x + globalBarBox.width / 2,
      globalBarBox.y + globalBarBox.height / 2,
    );
    dwellProbeExitDelay = Date.now() - enteredAt;
    if (dwellProbeExitDelay > HOVER_SEEN_DELAY_MS - 300) {
      dwellProbeExitDelay = null;
      continue;
    }
    await page.waitForTimeout(HOVER_SEEN_DELAY_MS + 300);
    assert.equal(
      await dwellRow.evaluate((row) => row.classList.contains("article-row--seen")),
      false,
      `Quitter le fil avant le délai de dwell doit annuler le marquage « vu » (sortie après ${dwellProbeExitDelay}ms).`,
    );
    break;
  }
  assert.ok(
    dwellProbeExitDelay !== null,
    `Impossible de sortir du fil en moins de ${HOVER_SEEN_DELAY_MS - 300}ms après ${dwellProbeAttempts} essais : runner trop lent pour prouver l'annulation du dwell.`,
  );
  // Survol immobile maintenu au-delà du délai : la ligne devient « vue ».
  await hoverRow(dwellRow);
  await page.waitForFunction(
    (articleId) => document.getElementById(articleId)?.classList.contains("article-row--seen") === true,
    dwellId,
  );
  await globalBar.hover();

  console.log(`✓ baseline: ${baselineArticleCount} articles interclassés, roving tabindex actif`);
  console.log("✓ échelle de texte: défaut global 14px, override par fil (clavier, en-tête, pastille), plafond annoncé, menu sans rôles zoom");
  console.log(`✓ viewport initial: scrollTop ${beforeArrival.scrollTop.toFixed(1)}px`);
  console.log(`✓ arrivée automatique: même article à ${revealed.selectedTop.toFixed(1)}px, compensation ${(revealed.scrollTop - beforeArrival.scrollTop).toFixed(1)}px`);
  console.log("✓ arrivée en tête: scrollTop reste à zéro");
  console.log("✓ mode dense par défaut: titre jamais tronqué, source réduite à son icône, bascule Confort persistée");
  console.log("✓ pastille « nouveaux »: compte hors viewport, clic ramène en haut, jamais de barrière d'insertion");
  console.log("✓ date ancienne explicite et fraîcheur compacte dans un fil étroit");
  console.log("✓ lecteur natif: Échap rend le focus au fil et les flèches reprennent immédiatement");
  console.log("✓ contrôles protégés, double-flèche entre panels et Alt+flèche pour les réordonner");
  console.log("✓ arrivées partagées: insertion automatique et viewport restent indépendants par panel");
  console.log("✓ état d’actualisation diffusé pendant une réponse réseau lente");
  console.log("✓ panne manuelle explicite: toast honnête, diagnostic daté et cache conservé");
  console.log("✓ glisser-déposer: texte externe ignoré, MIME interne conservé");
  console.log("✓ survol immobile: la ligne passe « vue » après le délai, un survol bref l’annule");
} finally {
  if (electronApp) await electronApp.close().catch(() => undefined);
  await closeServer(server).catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
