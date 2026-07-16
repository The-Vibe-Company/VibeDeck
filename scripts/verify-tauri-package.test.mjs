import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertEmbeddedLocalFrontend,
  assertMacUpdaterMatchesBundle,
  assertNoNodeElectronRuntime,
  assertNoUnsignedUpdaterArtifacts,
  assertWindowsUpdaterMatchesInstaller,
  assertWindowsPayloadMatchesExecutable,
  listPackageEntries,
  parsePeMachine,
  validatePackageInvocation,
  verifyUpdaterArtifactSignature,
} from "./verify-tauri-package.mjs";

const UPDATER_KEY_ID = Buffer.from("efcdab8967452301", "hex");

test("les marqueurs du frontend local courant doivent être embarqués", () => {
  const dist = mkdtempSync(path.join(tmpdir(), "vibedeck-dist-"));
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(
    path.join(dist, "index.html"),
    '<!doctype html><script src="./assets/index-ABC.js"></script><link href="./assets/index-DEF.css" rel="stylesheet">',
  );
  writeFileSync(path.join(dist, "assets/index-ABC.js"), "export {};");
  writeFileSync(path.join(dist, "assets/index-DEF.css"), ":root{}");
  const binary = Buffer.from(
    "native\0tauri://localhost\0/index.html\0/assets/index-ABC.js\0/assets/index-DEF.css\0",
  );
  assert.doesNotThrow(() => assertEmbeddedLocalFrontend(binary, dist, "macos"));
  assert.throws(
    () => assertEmbeddedLocalFrontend(Buffer.from("https://remote.invalid"), dist, "macos"),
    /protocole frontend local/,
  );
});

test("les runtimes Node et Electron sont refusés dans le bundle et les dépendances", () => {
  assert.doesNotThrow(() => assertNoNodeElectronRuntime([
    "Contents/MacOS/vibedeck",
    "Contents/Resources/icon.icns",
  ], "/System/Library/Frameworks/WebKit.framework/WebKit"));
  for (const forbidden of [
    "Contents/Resources/app.asar",
    "resources/node_modules/library/index.js",
    "Electron Framework.framework/Electron Framework",
    "chrome_100_percent.pak",
  ]) {
    assert.throws(() => assertNoNodeElectronRuntime([forbidden]), /Runtime Node\/Electron/);
  }
  assert.throws(
    () => assertNoNodeElectronRuntime([], "@rpath/Electron Framework.framework/Electron Framework"),
    /lier aucun runtime/,
  );
});

test("le parseur PE accepte uniquement une image x64 structurée", () => {
  const pe = Buffer.alloc(512);
  pe.write("MZ", 0, "ascii");
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write("PE\0\0", 0x80, "binary");
  pe.writeUInt16LE(0x8664, 0x84);
  assert.equal(parsePeMachine(pe), 0x8664);
  pe.writeUInt16LE(0xaa64, 0x84);
  assert.equal(parsePeMachine(pe), 0xaa64);
  assert.throws(() => parsePeMachine(Buffer.from("not a PE")), /tronqué|Signature/);
});

test("le mode signé exige toutes les preuves et le CI unsigned les refuse", () => {
  const base = {
    platform: "macos",
    mode: "signed",
    bundle: "VibeDeck.app",
    installer: "VibeDeck.dmg",
    frontendDist: "dist",
  };
  assert.throws(() => validatePackageInvocation(base), /releaseConfig/);
  assert.doesNotThrow(() => validatePackageInvocation({
    ...base,
    releaseConfig: "release.json",
    updaterArtifact: "VibeDeck.app.tar.gz",
    updaterSignature: "VibeDeck.app.tar.gz.sig",
  }));
  assert.throws(
    () => validatePackageInvocation({
      ...base,
      mode: "unsigned",
      releaseConfig: "release.json",
    }),
    /interdit en CI non signée/,
  );
});

test("le parcours du paquet ne suit pas les noms anodins ressemblant à node", () => {
  const bundle = mkdtempSync(path.join(tmpdir(), "vibedeck-bundle-"));
  mkdirSync(path.join(bundle, "Contents", "Resources"), { recursive: true });
  writeFileSync(path.join(bundle, "Contents", "Resources", "news-node-label.txt"), "safe");
  const entries = listPackageEntries(bundle);
  assert.ok(entries.includes("Contents/Resources/news-node-label.txt"));
  assert.doesNotThrow(() => assertNoNodeElectronRuntime(entries));
});

test("un build CI unsigned refuse tout résidu updater signé", () => {
  const bundle = mkdtempSync(path.join(tmpdir(), "vibedeck-unsigned-"));
  writeFileSync(path.join(bundle, "VibeDeck.dmg"), "unsigned bundle");
  assert.doesNotThrow(() => assertNoUnsignedUpdaterArtifacts([bundle]));
  writeFileSync(path.join(bundle, "VibeDeck.app.tar.gz.sig"), "unexpected");
  assert.throws(
    () => assertNoUnsignedUpdaterArtifacts([bundle]),
    /aucun artefact updater signé/,
  );
});

function updaterSignatureFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "vibedeck-updater-signature-"));
  const artifact = path.join(directory, "VibeDeck.app.tar.gz");
  const artifactBytes = Buffer.from("real updater artifact bytes\n");
  writeFileSync(artifact, artifactBytes);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeyPacket = Buffer.concat([
    Buffer.from("Ed", "ascii"),
    UPDATER_KEY_ID,
    publicKeyDer.subarray(-32),
  ]);
  const publicKeyBox = Buffer.from(
    "untrusted comment: minisign public key: 0123456789ABCDEF\n" +
      `${publicKeyPacket.toString("base64")}\n`,
  ).toString("base64");
  const artifactDigest = createHash("blake2b512").update(artifactBytes).digest();
  const artifactSignature = sign(null, artifactDigest, privateKey);
  const signaturePacket = Buffer.concat([
    Buffer.from("ED", "ascii"),
    UPDATER_KEY_ID,
    artifactSignature,
  ]);
  const trustedComment = "timestamp:1784151411\tfile:VibeDeck.app.tar.gz";
  const commentSignature = sign(
    null,
    Buffer.concat([artifactSignature, Buffer.from(trustedComment)]),
    privateKey,
  );
  const signature = Buffer.from(
    "untrusted comment: signature from tauri secret key\n" +
      `${signaturePacket.toString("base64")}\n` +
      `trusted comment: ${trustedComment}\n` +
      `${commentSignature.toString("base64")}\n`,
  ).toString("base64");
  return { artifact, publicKey: publicKeyBox, signature };
}

test("la signature updater est vérifiée cryptographiquement sur les octets de l'artefact", () => {
  const fixture = updaterSignatureFixture();
  assert.doesNotThrow(() =>
    verifyUpdaterArtifactSignature(fixture.artifact, fixture.signature, fixture.publicKey));

  writeFileSync(fixture.artifact, "tampered updater artifact\n");
  assert.throws(
    () => verifyUpdaterArtifactSignature(fixture.artifact, fixture.signature, fixture.publicKey),
    /ne correspond pas aux octets/,
  );
});

test("l'updater macOS est lié à l'intégralité exacte du bundle", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vibedeck-mac-updater-"));
  const bundle = path.join(directory, "VibeDeck.app");
  const executable = path.join(bundle, "Contents", "MacOS", "vibedeck");
  const manifest = path.join(bundle, "Contents", "Info.plist");
  const resource = path.join(bundle, "Contents", "Resources", "app.icns");
  const codeResources = path.join(bundle, "Contents", "_CodeSignature", "CodeResources");
  mkdirSync(path.dirname(executable), { recursive: true });
  mkdirSync(path.dirname(resource), { recursive: true });
  mkdirSync(path.dirname(codeResources), { recursive: true });
  writeFileSync(executable, "current signed executable");
  chmodSync(executable, 0o755);
  writeFileSync(manifest, "current bundle version 0.7.5");
  writeFileSync(resource, "current icon bytes");
  writeFileSync(codeResources, "current signature manifest");
  const artifact = path.join(directory, "VibeDeck.app.tar.gz");
  const archived = spawnSync("tar", ["-czf", artifact, "-C", directory, "VibeDeck.app"], {
    encoding: "utf8",
  });
  assert.equal(archived.status, 0, archived.stderr);
  assert.doesNotThrow(() => assertMacUpdaterMatchesBundle(artifact, bundle, executable));

  if (process.platform !== "win32") {
    chmodSync(executable, 0o644);
    assert.throws(
      () => assertMacUpdaterMatchesBundle(artifact, bundle, executable),
      /permissions de Contents\/MacOS\/vibedeck diffèrent/,
    );
    chmodSync(executable, 0o755);
  }
  writeFileSync(resource, "changed icon bytes");
  assert.throws(
    () => assertMacUpdaterMatchesBundle(artifact, bundle, executable),
    /contenu de Contents\/Resources\/app\.icns diffère/,
  );
  writeFileSync(resource, "current icon bytes");
  writeFileSync(manifest, "current bundle version 0.7.6");
  assert.throws(
    () => assertMacUpdaterMatchesBundle(artifact, bundle, executable),
    /contenu de Contents\/Info\.plist diffère/,
  );
});

test("l'updater Windows est l'installateur NSIS vérifié, pas un ancien artefact valide", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vibedeck-win-updater-"));
  const installer = path.join(directory, "VibeDeck-current-setup.exe");
  const stale = path.join(directory, "VibeDeck-previous-setup.exe");
  writeFileSync(installer, "current signed installer");
  writeFileSync(stale, "previous signed installer");
  assert.doesNotThrow(() => assertWindowsUpdaterMatchesInstaller(installer, installer));
  assert.throws(
    () => assertWindowsUpdaterMatchesInstaller(stale, installer),
    /exactement l'installateur NSIS/,
  );
});

test("des octets de signature factices portant le bon identifiant sont refusés", () => {
  const fixture = updaterSignatureFixture();
  const decoded = Buffer.from(fixture.signature, "base64").toString("utf8").trimEnd().split("\n");
  decoded[1] = Buffer.concat([
    Buffer.from("ED", "ascii"),
    UPDATER_KEY_ID,
    Buffer.alloc(64, 9),
  ]).toString("base64");
  decoded[3] = Buffer.alloc(64, 5).toString("base64");
  const forged = Buffer.from(`${decoded.join("\n")}\n`).toString("base64");
  assert.throws(
    () => verifyUpdaterArtifactSignature(fixture.artifact, forged, fixture.publicKey),
    /ne correspond pas aux octets/,
  );
});

test("le commentaire de confiance minisign doit lui aussi être authentique", () => {
  const fixture = updaterSignatureFixture();
  const decoded = Buffer.from(fixture.signature, "base64").toString("utf8").trimEnd().split("\n");
  decoded[2] = "trusted comment: timestamp:1784151412\tfile:VibeDeck.app.tar.gz";
  const forged = Buffer.from(`${decoded.join("\n")}\n`).toString("base64");
  assert.throws(
    () => verifyUpdaterArtifactSignature(fixture.artifact, forged, fixture.publicKey),
    /commentaire updater est invalide/,
  );
});

function peFixture(marker = 0) {
  const pe = Buffer.alloc(512, marker);
  pe.write("MZ", 0, "ascii");
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write("PE\0\0", 0x80, "binary");
  pe.writeUInt16LE(0x8664, 0x84);
  return pe;
}

test("le binaire réellement extrait du NSIS doit être identique au sibling vérifié", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vibedeck-nsis-payload-"));
  const expected = path.join(directory, "expected-vibedeck.exe");
  const extracted = path.join(directory, "vibedeck.exe");
  writeFileSync(expected, peFixture());
  writeFileSync(extracted, peFixture());
  assert.doesNotThrow(() => assertWindowsPayloadMatchesExecutable([extracted], expected));

  writeFileSync(extracted, peFixture(1));
  assert.throws(
    () => assertWindowsPayloadMatchesExecutable([extracted], expected),
    /ne contient pas l'exécutable Tauri vérifié et signé/,
  );
  assert.throws(
    () => assertWindowsPayloadMatchesExecutable([], expected),
    /payload VibeDeck est absent/,
  );
});
