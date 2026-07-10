import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { _electron as electron } from "playwright-core";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const initialArticleCount = 90;
const secondaryArticleCount = 2;
const baselineArticleCount = initialArticleCount + secondaryArticleCount;
const MIN_PANEL_WIDTH = 256;
const SUBPIXEL_EPSILON = 0.5;
const newArticleTitle = "ARRIVÉE CONTRÔLÉE — invariant du viewport";
const sharedArrivalTitle = "ARRIVÉE PARTAGÉE — tampon indépendant par panel";

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
        <title>Flux contrôlé MediaGen</title>
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
      scrollHeight: list.scrollHeight,
      scrollTop: list.scrollTop,
      newInDom: Boolean(newRow),
      newRowHeight: newRow instanceof HTMLElement ? newRow.getBoundingClientRect().height : 0,
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
let primaryShouldFail = false;
let primaryDelayMs = 0;
let origin = "";

const server = createServer((request, response) => {
  if (request.url !== "/feed.xml" && request.url !== "/feed-secondary.xml") {
    response.writeHead(404).end("Not found");
    return;
  }
  const isSecondary = request.url === "/feed-secondary.xml";
  if (isSecondary) secondaryRequestCount += 1;
  else primaryRequestCount += 1;
  if (!isSecondary && primaryShouldFail) {
    response.writeHead(503, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Panne contrôlée du flux principal");
    return;
  }
  const sendFeed = () => {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/rss+xml; charset=utf-8",
    });
    response.end(renderFeed(origin, isSecondary ? secondaryArticles : articles));
  };
  if (!isSecondary && primaryDelayMs > 0) {
    const delay = primaryDelayMs;
    primaryDelayMs = 0;
    setTimeout(sendFeed, delay);
    return;
  }
  sendFeed();
});

let electronApp;
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "mediagen-pilot-ui-"));

try {
  origin = await listen(server);
  const databasePath = path.join(temporaryDirectory, "veille.sqlite3");
  electronApp = await electron.launch({
    executablePath: electronExecutable,
    args: [`--user-data-dir=${path.join(temporaryDirectory, "profile")}`, projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      MEDIAGEN_ALLOW_PRIVATE_NETWORK: "true",
      MEDIAGEN_DB_PATH: databasePath,
      VITE_DEV_SERVER_URL: "",
    },
    timeout: 30_000,
  });

  const page = await electronApp.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  await page.bringToFront();
  await page.waitForFunction(() => Boolean(window.mediagen?.getState));
  await page.evaluate(() => window.mediagen.focusDashboard());

  const browserWindow = await electronApp.browserWindow(page);
  await browserWindow.evaluate((window) => window.setSize(1280, 820));
  await browserWindow.dispose();

  const panelId = await page.evaluate(async () => {
    const before = await window.mediagen.getState();
    const existingIds = new Set(before.panels.map(({ id }) => id));
    const next = await window.mediagen.createPanel({
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
      const result = await window.mediagen.addSource(targetPanelId, {
        url: feedUrl,
        connectorKind: "rss",
        refreshIntervalSeconds: 1_800,
      });
      return result.sourceId;
    },
    { targetPanelId: panelId, feedUrl: `${origin}/feed.xml` },
  );

  await page.waitForFunction(
    (count) => document.querySelectorAll(".article-row").length === count,
    initialArticleCount,
  );
  assert.equal(primaryRequestCount, 1, "Le flux principal doit être chargé une seule fois.");

  await page.evaluate(
    async ({ targetPanelId, feedUrl }) => window.mediagen.addSource(targetPanelId, {
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

  assert.equal(
    await page.locator('.article-row[tabindex="0"]').count(),
    1,
    "Un seul article doit être accessible par Tab dans le fil.",
  );
  assert.equal(
    await page.locator('.article-row[tabindex="-1"]').count(),
    baselineArticleCount - 1,
  );
  const secondArticleId = await page.locator(".article-row").nth(1).getAttribute("id");
  assert.ok(secondArticleId, "Le deuxième article doit avoir un identifiant stable.");
  const activeArticleIdAfterKeyDown = await page.locator(".article-row").first().evaluate((row) => {
    row.focus();
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
  await page.locator(".dashboard-panel").hover();
  assert.equal(
    await page.locator(".dashboard-panel").evaluate((panel) => document.activeElement === panel),
    true,
    "Le survol doit rendre le panel prêt pour les raccourcis sans voler ensuite les contrôles.",
  );
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.locator(".article-row").nth(2).evaluate((row) => document.activeElement === row),
    true,
    "Après survol, les flèches doivent reprendre la navigation dans les articles.",
  );

  await page.keyboard.press("ControlOrMeta+N");
  const draftLeaf = page.locator('.split-layout__leaf[data-panel-id^="draft:"]');
  await draftLeaf.waitFor({ state: "visible" });
  await draftLeaf.getByRole("button", { name: /Fil agrégé/ }).click();
  const advancedSummary = draftLeaf.locator("summary").filter({ hasText: "Options avancées" });
  await advancedSummary.focus();
  await page.locator(".global-bar").hover();
  await draftLeaf.locator(".dashboard-panel").hover();
  assert.equal(
    await advancedSummary.evaluate((summary) => document.activeElement === summary),
    true,
    "Le survol ne doit pas interrompre le contrôle natif Options avancées.",
  );
  await draftLeaf.getByLabel("Fermer le panel").click();
  await draftLeaf.waitFor({ state: "detached" });

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
      // An old editorial timestamp must not demote a genuinely new detection.
      publishedAt: new Date(baselineTime - 10 * 24 * 60 * 60 * 1_000),
    },
    ...articles,
  ];
  await page.evaluate((id) => window.mediagen.refreshSource(id), sourceId);
  await page.locator(".feed-arrivals").waitFor({ state: "visible" });

  const buffered = await readMetrics(page, reference.id);
  assert.equal(primaryRequestCount, 2, "Le rafraîchissement doit relire le flux contrôlé.");
  assert.equal(buffered.newInDom, false, "L’arrivée ne doit pas entrer dans le DOM avant confirmation.");
  assert.equal(buffered.activeId, reference.id, "L’arrivée ne doit pas voler le focus DOM.");
  assert.equal(buffered.focusedId, reference.id, "L’arrivée ne doit pas changer la sélection clavier.");
  assertWithin(buffered.scrollTop, beforeArrival.scrollTop, 0.5, "scrollTop avant confirmation");
  assertWithin(buffered.selectedTop, beforeArrival.selectedTop, 1, "position avant confirmation");

  await page.locator(".feed-arrivals").click();
  await page.waitForFunction(
    (title) => [...document.querySelectorAll(".article-row")]
      .some((row) => row.textContent?.includes(title)),
    newArticleTitle,
  );
  await page.evaluate(() => new Promise(
    (resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)),
  ));

  const revealed = await readMetrics(page, reference.id);
  assert.equal(revealed.newInDom, true, "L’arrivée doit être rendue après confirmation.");
  assert.equal(revealed.newRowIndex, 0, "L’arrivée doit être insérée en tête du fil.");
  assert.equal(revealed.focusedId, reference.id, "La sélection clavier doit rester sur le même article.");
  assertWithin(revealed.selectedTop, beforeArrival.selectedTop, 1, "position après insertion");
  assert.ok(revealed.scrollTop > beforeArrival.scrollTop, "Le scroll doit compenser la ligne insérée.");
  assertWithin(
    revealed.scrollTop - beforeArrival.scrollTop,
    revealed.newRowHeight,
    1,
    "compensation du scroll",
  );

  assert.match(
    (await page.locator(".article-row").first().locator("time").textContent()) ?? "",
    /^\d{2}\/\d{2}(?:\/\d{2})? \d{2}:\d{2}$/,
    "Une date ancienne doit rester explicite dans le fil.",
  );

  const readerSourceRow = page.locator(".article-row").first();
  const readerSourceId = await readerSourceRow.getAttribute("id");
  await readerSourceRow.focus();
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
    if (!reader) throw new Error("Le WebContentsView du lecteur est introuvable.");
    reader.focus();
    reader.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    reader.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  }, `${origin}/articles/`);
  await page.locator(".link-reader").waitFor({ state: "detached" });
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    (previousId) => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active.classList.contains("article-row") && active.id !== previousId;
    },
    readerSourceId,
  );

  const narrowPanelId = await page.evaluate(async (targetPanelId) => {
    const before = await window.mediagen.getState();
    const existingIds = new Set(before.panels.map(({ id }) => id));
    const next = await window.mediagen.createPanel(
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
    async ({ targetPanelId, feedUrl }) => window.mediagen.addSource(targetPanelId, {
      url: feedUrl,
      connectorKind: "rss",
      refreshIntervalSeconds: 1_800,
    }),
    { targetPanelId: narrowPanelId, feedUrl: `${origin}/feed.xml` },
  );
  assert.equal(
    primaryRequestCount,
    2,
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
    { targetPanelId: narrowPanelId, count: initialArticleCount },
  );
  await narrowLeaf.locator(".feed-arrivals").click();
  await page.waitForFunction(
    ({ targetPanelId, count }) =>
      document.querySelectorAll(
        `.split-layout__leaf[data-panel-id="${targetPanelId}"] .article-row`,
      ).length === count,
    { targetPanelId: narrowPanelId, count: initialArticleCount + 1 },
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

  await panelLeaf.locator(".dashboard-panel").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
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

  await narrowLeaf.getByLabel("Agrandir").click();
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
    baselineArticleCount + 1,
    "Une panne de rafraîchissement ne doit retirer aucun article en cache.",
  );

  primaryShouldFail = false;
  articles = [
    {
      id: "shared-panel-arrival",
      title: sharedArrivalTitle,
      summary: "Cette arrivée doit rester tamponnée séparément dans chaque panel.",
      publishedAt: new Date(),
    },
    ...articles,
  ];
  await page.evaluate((id) => window.mediagen.refreshSource(id), sourceId);
  await panelLeaf.locator(".feed-arrivals").waitFor({ state: "visible" });
  await narrowLeaf.locator(".feed-arrivals").waitFor({ state: "visible" });

  await narrowLeaf.getByLabel("Configurer les sources").click();
  const feedConfigDialog = page.getByRole("dialog", { name: "Configuration du fil" });
  await feedConfigDialog.getByRole("button", { name: "Enregistrer" }).click();
  await feedConfigDialog.waitFor({ state: "detached" });
  await narrowLeaf.locator(".feed-arrivals").waitFor({ state: "visible" });
  assert.equal(
    await narrowLeaf.locator(".article-row").filter({ hasText: sharedArrivalTitle }).count(),
    0,
    "Enregistrer la configuration ne doit pas vider le tampon d’arrivées du panel.",
  );

  const temporaryPanelId = await page.evaluate(async (targetPanelId) => {
    const before = await window.mediagen.getState();
    const knownIds = new Set(before.panels.map(({ id }) => id));
    const next = await window.mediagen.createPanel(
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
  await narrowLeaf.locator(".feed-arrivals").waitFor({ state: "visible" });
  assert.equal(
    await narrowLeaf.locator(".article-row").filter({ hasText: sharedArrivalTitle }).count(),
    0,
    "Fermer un panel voisin ne doit pas révéler une arrivée tamponnée.",
  );

  await panelLeaf.locator(".feed-arrivals").click();
  await panelLeaf.locator(".article-row").filter({ hasText: sharedArrivalTitle })
    .waitFor({ state: "visible" });
  const sharedItemId = await page.evaluate(async (title) => {
    const state = await window.mediagen.getState();
    const item = state.items.find((candidate) => candidate.title === title);
    if (!item) throw new Error("L’arrivée partagée est introuvable.");
    await window.mediagen.markItemOpened(item.id);
    return item.id;
  }, sharedArrivalTitle);
  assert.ok(sharedItemId, "L’arrivée partagée doit posséder un identifiant.");
  await narrowLeaf.locator(".feed-arrivals").waitFor({ state: "visible" });
  assert.equal(
    await narrowLeaf.locator(".article-row").filter({ hasText: sharedArrivalTitle }).count(),
    0,
    "L’accusé de lecture d’un panel ne doit pas révéler l’arrivée dans son voisin.",
  );
  await narrowLeaf.locator(".feed-arrivals").click();
  const sharedSiblingRow = narrowLeaf.locator(".article-row").filter({ hasText: sharedArrivalTitle });
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
    forgedTransfer.setData("application/x-mediagen-panel", "panel-inconnu");
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

  console.log(`✓ baseline: ${baselineArticleCount} articles interclassés, roving tabindex actif`);
  console.log(`✓ viewport initial: scrollTop ${beforeArrival.scrollTop.toFixed(1)}px`);
  console.log("✓ arrivée tamponnée: DOM, focus, sélection, scroll et position inchangés");
  console.log(`✓ arrivée révélée: même article à ${revealed.selectedTop.toFixed(1)}px, compensation ${revealed.newRowHeight.toFixed(1)}px`);
  console.log("✓ date ancienne explicite et fraîcheur compacte visible sous 520px");
  console.log("✓ lecteur natif: Échap rend le focus au fil et les flèches reprennent immédiatement");
  console.log("✓ contrôles protégés, double-flèche entre panels et Alt+flèche pour les réordonner");
  console.log("✓ arrivées partagées: tampon et révélation restent indépendants par panel");
  console.log("✓ état d’actualisation diffusé pendant une réponse réseau lente");
  console.log("✓ panne manuelle explicite: toast honnête, diagnostic daté et cache conservé");
  console.log("✓ glisser-déposer: texte externe ignoré, MIME interne conservé");
} finally {
  if (electronApp) await electronApp.close().catch(() => undefined);
  await closeServer(server).catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
