import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createTauriReleaseConfig,
  validateUpdaterEndpoint,
  validateUpdaterPublicKey,
  writeTauriReleaseConfig,
} from "./create-tauri-release-config.mjs";

const PUBLIC_KEY_ID = Buffer.from("efcdab8967452301", "hex");
const PUBLIC_KEY_PACKET = Buffer.concat([
  Buffer.from("Ed", "ascii"),
  PUBLIC_KEY_ID,
  Buffer.alloc(32, 7),
]).toString("base64");
const PUBLIC_KEY = Buffer.from(
  "untrusted comment: minisign public key: 0123456789ABCDEF\n" +
    `${PUBLIC_KEY_PACKET}\n`,
).toString("base64");

function fixture(platform = "macos") {
  const root = mkdtempSync(path.join(tmpdir(), "vibedeck-release-root-"));
  const secrets = mkdtempSync(path.join(tmpdir(), "vibedeck-release-secrets-"));
  const updaterKey = path.join(secrets, "updater.key");
  writeFileSync(
    updaterKey,
    Buffer.from(
      "untrusted comment: rsign encrypted secret key\n" +
        "RWR0ZXN0ZW5jcnlwdGVkc2VjcmV0a2V5bWF0ZXJpYWwxMjM0NTY3ODkw\n",
    ).toString("base64"),
  );
  const environment = {
    TAURI_SIGNING_PRIVATE_KEY_PATH: updaterKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test-password-is-not-a-release-secret",
    TAURI_UPDATER_PUBKEY: PUBLIC_KEY,
    TAURI_UPDATER_ENDPOINT:
      "https://releases.vibedeck.fr/{{target}}/{{arch}}/{{current_version}}",
  };
  if (platform === "macos") {
    const apiKey = path.join(secrets, "AuthKey_TESTKEY123.p8");
    writeFileSync(apiKey, "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----\n");
    Object.assign(environment, {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: The Vibe Company",
      APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000001",
      APPLE_API_KEY: "TESTKEY123",
      APPLE_API_KEY_PATH: apiKey,
      APPLE_TEAM_ID: "TEAMID1234",
    });
  } else {
    Object.assign(environment, {
      VIBEDECK_WINDOWS_PUBLISHER: "The Vibe Company",
      VIBEDECK_WINDOWS_SIGN_COMMAND: "trusted-signing-cli sign --file %1",
    });
  }
  return { root, secrets, environment };
}

test("la configuration signée est générée uniquement à partir de valeurs explicites", () => {
  const mac = fixture("macos");
  const macConfig = createTauriReleaseConfig({
    platform: "macos",
    environment: mac.environment,
    root: mac.root,
  });
  assert.equal(macConfig.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(macConfig.bundle.targets, ["app", "dmg"]);
  assert.equal(macConfig.bundle.macOS.hardenedRuntime, true);
  assert.equal(macConfig.plugins.updater.dangerousInsecureTransportProtocol, false);
  mac.environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "correct-horse-fake-battery-staple";
  assert.doesNotThrow(() => createTauriReleaseConfig({
    platform: "macos",
    environment: mac.environment,
    root: mac.root,
  }));

  const windows = fixture("windows");
  const windowsConfig = createTauriReleaseConfig({
    platform: "windows",
    environment: windows.environment,
    root: windows.root,
  });
  assert.deepEqual(windowsConfig.bundle.targets, ["nsis"]);
  assert.equal(windowsConfig.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(windowsConfig.plugins.updater.windows.installMode, "passive");
});

test("les clés, endpoints et placeholders non sûrs sont refusés", () => {
  assert.throws(() => validateUpdaterPublicKey("not-a-key"), /invalide|base64/);
  assert.throws(
    () => validateUpdaterEndpoint("http://releases.vibedeck.fr/latest.json"),
    /HTTPS/,
  );
  assert.throws(
    () => validateUpdaterEndpoint("https://localhost/{{unknown}}"),
    /Variable updater non autorisée/,
  );
  for (const endpoint of [
    "https://[::1]/latest.json",
    "https://[fd00::1]/latest.json",
    "https://[fe80::1]/latest.json",
    "https://[::ffff:127.0.0.1]/latest.json",
    "https://198.51.100.8/latest.json",
  ]) {
    assert.throws(
      () => validateUpdaterEndpoint(endpoint),
      /local ou réservé/,
      endpoint,
    );
  }
  assert.equal(
    validateUpdaterEndpoint("https://[2001:4860:4860::8888]/latest.json"),
    "https://[2001:4860:4860::8888]/latest.json",
  );

  const missing = fixture("macos");
  delete missing.environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  assert.throws(
    () => createTauriReleaseConfig({
      platform: "macos",
      environment: missing.environment,
      root: missing.root,
    }),
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/,
  );
});

test("le fichier généré reste hors dépôt, privé, atomique et non écrasable", () => {
  const sample = fixture("windows");
  const outputDirectory = mkdtempSync(path.join(tmpdir(), "vibedeck-release-output-"));
  const output = path.join(outputDirectory, "tauri.release.conf.json");
  const written = writeTauriReleaseConfig({
    platform: "windows",
    output,
    environment: sample.environment,
    root: sample.root,
  });
  assert.equal(written.destination, realpathSync(output));
  assert.equal(JSON.parse(readFileSync(output, "utf8")).bundle.createUpdaterArtifacts, true);
  assert.throws(
    () => writeTauriReleaseConfig({
      platform: "windows",
      output,
      environment: sample.environment,
      root: sample.root,
    }),
    /Refus d'écraser/,
  );

  const inside = path.join(sample.root, "generated");
  mkdirSync(path.dirname(inside), { recursive: true });
  assert.throws(
    () => writeTauriReleaseConfig({
      platform: "windows",
      output: inside,
      environment: sample.environment,
      root: sample.root,
    }),
    /hors du dépôt/,
  );
  assert.throws(
    () => writeTauriReleaseConfig({
      platform: "windows",
      output: path.join(sample.root, "..looks-outside-but-is-not"),
      environment: sample.environment,
      root: sample.root,
    }),
    /hors du dépôt/,
  );
});
