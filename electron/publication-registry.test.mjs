import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CURATED_PROXY_ROOTS,
  PUBLICATIONS,
  SOURCE_CATALOG,
  definePublication,
  publicSourceCatalog,
} from "./publication-registry.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateCatalogKeys = ["feedUrl", "hostnames", "reader", "enrichment"];

test("freezes an exact 20/10 publication snapshot with consecutive ranks", () => {
  assert.equal(PUBLICATIONS.length, 30);
  assert.equal(Object.isFrozen(PUBLICATIONS), true);
  assert.equal(new Set(PUBLICATIONS.map(({ id }) => id)).size, 30);

  for (const [group, expectedCount] of [["france", 20], ["english-world", 10]]) {
    const publications = PUBLICATIONS.filter((publication) => publication.group === group);
    assert.equal(publications.length, expectedCount);
    assert.deepEqual(publications.map(({ rank }) => rank),
      Array.from({ length: expectedCount }, (_, index) => index + 1));
  }

  for (const publication of PUBLICATIONS) {
    assert.equal(Object.isFrozen(publication), true);
    assert.equal(Object.isFrozen(publication.reader), true);
    assert.equal(Object.isFrozen(publication.hostnames), true);
    assert.notDeepEqual(publication.reader.blockedPhrases, []);
    if (!publication.reader.requireDeclaredFreeAccess) {
      assert.notDeepEqual(publication.reader.premiumSelectors, [], publication.id);
      assert.notDeepEqual(publication.reader.premiumPhrases, [], publication.id);
    }
  }
  assert.deepEqual(
    [...new Set(PUBLICATIONS.map(({ category }) => category))].sort(),
    ["business", "culture", "general", "local", "sports"],
  );
});

test("keeps all network roots exact, HTTPS and credential-free", () => {
  const expectedRoots = PUBLICATIONS.flatMap((publication) => [
    publication.feedUrl,
    ...(publication.enrichment ? [publication.enrichment.url] : []),
  ]);
  assert.deepEqual(CURATED_PROXY_ROOTS, expectedRoots);
  assert.equal(new Set(CURATED_PROXY_ROOTS).size, CURATED_PROXY_ROOTS.length);

  for (const value of [
    ...CURATED_PROXY_ROOTS,
    ...PUBLICATIONS.map(({ homepageUrl }) => homepageUrl),
  ]) {
    const url = new URL(value);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(url.hash, "");
  }
});

test("projects only bounded public metadata across the Electron boundary", () => {
  assert.equal(Object.isFrozen(SOURCE_CATALOG), true);
  assert.equal(SOURCE_CATALOG.length, 30);
  for (const entry of SOURCE_CATALOG) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.capabilities), true);
    for (const key of privateCatalogKeys) assert.equal(Object.hasOwn(entry, key), false);
    assert.match(entry.iconPath, /^\.\/provider-icons\/[a-z0-9-]+\.png$/);
  }

  const projection = publicSourceCatalog();
  projection[0].capabilities.push("mutation-test");
  assert.equal(SOURCE_CATALOG[0].capabilities.includes("mutation-test"), false);
});

test("ships one bounded 96px PNG icon for every publication", () => {
  for (const publication of PUBLICATIONS) {
    const iconPath = path.join(repositoryRoot, "public", publication.iconPath.slice(2));
    const stats = statSync(iconPath);
    const png = readFileSync(iconPath);
    assert.ok(stats.size > 100 && stats.size <= 64 * 1024, publication.id);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 96, publication.id);
    assert.equal(png.readUInt32BE(20), 96, publication.id);
  }
});

test("definePublication rejects unsafe or incomplete additions", () => {
  const valid = {
    id: "publication-test",
    name: "Publication test",
    description: "Une publication utilisée uniquement par ce test.",
    group: "france",
    category: "general",
    rank: 21,
    iconPath: "./provider-icons/publication-test.png",
    homepageUrl: "https://publication.test/",
    hostnames: ["publication.test"],
    feedUrl: "https://publication.test/rss.xml",
    connectorKind: "rss",
    refreshIntervalSeconds: 300,
  };
  assert.equal(Object.isFrozen(definePublication(valid)), true);
  assert.throws(() => definePublication({ ...valid, feedUrl: "http://publication.test/rss.xml" }), /HTTPS/);
  assert.throws(() => definePublication({ ...valid, feedUrl: "https://user:secret@publication.test/rss.xml" }), /HTTPS/);
  assert.throws(() => definePublication({ ...valid, hostnames: ["publication.test/path"] }), /Domaines/);
  assert.throws(() => definePublication({ ...valid, category: "autre" }), /Catégorie/);
  assert.throws(() => definePublication({ ...valid, iconPath: "https://publication.test/icon.png" }), /icône/);
});
