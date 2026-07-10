import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = path.join(root, "release");
const checksumPath = path.join(releaseDirectory, "SHA256SUMS.txt");
const artifactExtensions = new Set([".dmg", ".exe"]);

async function sha256(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function releaseArtifacts() {
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && artifactExtensions.has(path.extname(entry.name).toLowerCase()),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function parseChecksums(source) {
  const records = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
    assert.ok(match, `Ligne SHA-256 invalide : ${line}`);
    const [, digest, fileName] = match;
    assert.doesNotMatch(fileName, /[\\/]/, "Un checksum ne peut viser que release/.");
    assert.notEqual(fileName, ".", "Nom d’artefact SHA-256 invalide.");
    assert.notEqual(fileName, "..", "Nom d’artefact SHA-256 invalide.");
    assert.equal(path.basename(fileName), fileName, "Un checksum ne peut viser que release/.");
    assert.ok(!records.has(fileName), `Artefact dupliqué dans SHA256SUMS.txt : ${fileName}`);
    records.set(fileName, digest);
  }
  assert.ok(records.size > 0, "SHA256SUMS.txt ne contient aucun artefact.");
  return records;
}

async function writeChecksums() {
  const artifacts = await releaseArtifacts();
  assert.ok(artifacts.length > 0, "Aucun DMG ou installateur EXE trouvé dans release/.");
  const lines = [];
  for (const fileName of artifacts) {
    lines.push(`${await sha256(path.join(releaseDirectory, fileName))}  ${fileName}`);
  }

  const temporaryPath = `${checksumPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o644 });
    await rename(temporaryPath, checksumPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  console.log(`✓ SHA-256 générés pour ${artifacts.length} artefact(s) : ${checksumPath}`);
}

async function verifyChecksums() {
  const artifacts = await releaseArtifacts();
  const records = parseChecksums(await readFile(checksumPath, "utf8"));
  assert.deepEqual(
    [...records.keys()].sort((left, right) => left.localeCompare(right, "en")),
    artifacts,
    "SHA256SUMS.txt doit couvrir exactement tous les DMG et EXE présents dans release/.",
  );

  for (const [fileName, expected] of records) {
    const actual = await sha256(path.join(releaseDirectory, fileName));
    assert.equal(actual, expected, `Checksum SHA-256 invalide : ${fileName}`);
  }
  console.log(`✓ SHA-256 validés pour ${records.size} artefact(s).`);
}

const command = process.argv[2];
if (command === "write") await writeChecksums();
else if (command === "verify") await verifyChecksums();
else throw new Error("Usage : node scripts/release-checksums.mjs <write|verify>");
