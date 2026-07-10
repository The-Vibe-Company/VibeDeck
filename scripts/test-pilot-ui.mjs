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
// Doit rester aligné sur HOVER_SEEN_DELAY_MS dans src/App.tsx.
const HOVER_SEEN_DELAY_MS = 1000;
const newArticleTitle = "ARRIVÉE CONTRÔLÉE — invariant du viewport";
const topArrivalTitle = "ARRIVÉE EN TÊTE — scroll nul";
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
      MEDIAGEN_FAKE_SEMANTIC_SEARCH: "true",
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
      // An old editorial timestamp must not demote a genuinely new detection.
      publishedAt: new Date(baselineTime - 10 * 24 * 60 * 60 * 1_000),
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
  assertWithin(
    revealed.scrollTop - beforeArrival.scrollTop,
    revealed.newRowHeight,
    1,
    "compensation du scroll",
  );
  const expectedAfterJ = await page.evaluate(
    (articleId) => document.getElementById(articleId)?.nextElementSibling?.id ?? null,
    reference.id,
  );
  assert.ok(expectedAfterJ, "L’article suivant après insertion doit exister.");
  await page.keyboard.press("j");
  await page.waitForFunction(
    (articleId) => document.activeElement?.id === articleId,
    expectedAfterJ,
  );

  assert.match(
    (await page.locator(".article-row").first().locator("time").textContent()) ?? "",
    /^\d{2}\/\d{2}(?:\/\d{2})? \d{2}:\d{2}$/,
    "Une date ancienne doit rester explicite dans le fil.",
  );

  await page.evaluate(() => {
    const list = document.querySelector(".article-list");
    if (!(list instanceof HTMLElement)) throw new Error("Le fil principal est introuvable.");
    list.scrollTop = 0;
  });
  articles = [
    {
      id: "top-arrival",
      title: topArrivalTitle,
      summary: "Cette arrivée doit rester visible au sommet du fil.",
      publishedAt: new Date(),
    },
    ...articles,
  ];
  await page.evaluate((id) => window.mediagen.refreshSource(id), sourceId);
  await page.locator(".article-row").filter({ hasText: topArrivalTitle }).waitFor({ state: "visible" });
  assert.equal(
    await page.locator(".article-list").evaluate((list) => list.scrollTop),
    0,
    "Une arrivée reçue en haut du fil doit conserver scrollTop à zéro.",
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
  await electronApp.evaluate(async ({ webContents }, articlePrefix) => {
    let reader;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      reader = webContents
        .getAllWebContents()
        .find((contents) =>
          contents.getURL().startsWith(articlePrefix) && contents.isFocused());
      if (reader) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!reader) throw new Error("Le lecteur natif focalisé est introuvable.");
    reader.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    reader.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  }, `${origin}/articles/`);
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
    3,
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
    { targetPanelId: narrowPanelId, count: initialArticleCount + 2 },
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
    0.5,
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
  await searchPalette.getByLabel("Requête").fill("référence 42");
  await searchPalette.locator(".search-palette__result").first().waitFor({ state: "visible" });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await searchPalette.waitFor({ state: "detached" });
  await page.locator(".link-reader").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator(".link-reader").waitFor({ state: "detached" });
  console.log("✓ recherche live: focus direct, source partagée, filtre explicite et navigation clavier");

  await panelLeaf.locator(".dashboard-panel").focus();
  await page.waitForFunction(
    (targetPanelId) => document
      .querySelector(`.split-layout__leaf[data-panel-id="${targetPanelId}"] .dashboard-panel`)
      ?.classList.contains("dashboard-panel--focused"),
    panelId,
  );
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
    baselineArticleCount + 2,
    "Une panne de rafraîchissement ne doit retirer aucun article en cache.",
  );

  primaryShouldFail = false;
  await page.evaluate((id) => window.mediagen.refreshSource(id), sourceId);
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
  await page.evaluate((id) => window.mediagen.refreshSource(id), sourceId);
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
  await feedConfigDialog.getByRole("button", { name: "Enregistrer" }).click();
  await feedConfigDialog.waitFor({ state: "detached" });
  await sharedSiblingRow.waitFor({ state: "visible" });

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
  await sharedSiblingRow.waitFor({ state: "visible" });

  const sharedItemId = await page.evaluate(async (title) => {
    const state = await window.mediagen.getState();
    const item = state.items.find((candidate) => candidate.title === title);
    if (!item) throw new Error("L’arrivée partagée est introuvable.");
    await window.mediagen.markItemOpened(item.id);
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

  // Marquage « vu » par survol : seule une immobilité prolongée sur une ligne compte.
  const dwellTitle = "ARRIVÉE DWELL — survol prolongé marque « vu »";
  articles = [
    {
      id: "dwell-arrival",
      title: dwellTitle,
      summary: "Doit passer « vue » uniquement après un survol maintenu.",
      publishedAt: new Date(),
    },
    ...articles,
  ];
  await page.evaluate((id) => window.mediagen.refreshSource(id), sourceId);
  const dwellRow = page.locator(".article-row").filter({ hasText: dwellTitle }).first();
  await dwellRow.waitFor({ state: "visible" });
  const dwellId = await dwellRow.getAttribute("id");
  assert.equal(
    await dwellRow.evaluate((row) => row.classList.contains("article-row--seen")),
    false,
    "Une arrivée fraîche doit être non vue avant tout survol.",
  );
  // Survol bref puis sortie du fil avant le délai : le marquage est annulé.
  await hoverRow(dwellRow);
  await page.locator(".global-bar").hover();
  await page.waitForTimeout(HOVER_SEEN_DELAY_MS + 300);
  assert.equal(
    await dwellRow.evaluate((row) => row.classList.contains("article-row--seen")),
    false,
    "Quitter le fil avant le délai de dwell doit annuler le marquage « vu ».",
  );
  // Survol immobile maintenu au-delà du délai : la ligne devient « vue ».
  await hoverRow(dwellRow);
  await page.waitForFunction(
    (articleId) => document.getElementById(articleId)?.classList.contains("article-row--seen") === true,
    dwellId,
  );
  await page.locator(".global-bar").hover();

  console.log(`✓ baseline: ${baselineArticleCount} articles interclassés, roving tabindex actif`);
  console.log(`✓ viewport initial: scrollTop ${beforeArrival.scrollTop.toFixed(1)}px`);
  console.log(`✓ arrivée automatique: même article à ${revealed.selectedTop.toFixed(1)}px, compensation ${revealed.newRowHeight.toFixed(1)}px`);
  console.log("✓ arrivée en tête: scrollTop reste à zéro");
  console.log("✓ date ancienne explicite et fraîcheur compacte visible sous 520px");
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
