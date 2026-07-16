import assert from "node:assert/strict";
import test from "node:test";

import {
  loadTauriVerificationInputs,
  verifyTauriConfiguration,
} from "./verify-tauri-config.mjs";

function inputs() {
  return loadTauriVerificationInputs();
}

test("la configuration Tauri réelle respecte toutes les frontières", () => {
  const result = verifyTauriConfiguration(inputs());
  assert.equal(result.macOSTarget, "universal-apple-darwin");
  assert.equal(result.windowsTarget, "x86_64-pc-windows-msvc");
  assert.ok(result.cargoDependencies > 0);
});

test("une capability distante ou étendue à la fenêtre est refusée", () => {
  const fixture = inputs();
  fixture.capability = {
    ...fixture.capability,
    remote: { urls: ["https://example.test/*"] },
  };
  assert.throws(
    () => verifyTauriConfiguration(fixture),
    /ne doit jamais accorder de capability à une origine distante/,
  );

  const windowScope = inputs();
  windowScope.capability = { ...windowScope.capability, windows: ["main"] };
  assert.throws(
    () => verifyTauriConfiguration(windowScope),
    /futurs webviews/,
  );

  const broadCore = inputs();
  broadCore.capability = {
    ...broadCore.capability,
    permissions: ["core:default"],
  };
  assert.throws(
    () => verifyTauriConfiguration(broadCore),
    /lecture de version/,
  );
});

test("une dépendance Cargo non épinglée est refusée", () => {
  const fixture = inputs();
  fixture.cargoToml = fixture.cargoToml.replace(
    'tauri = { version = "=2.11.5"',
    'tauri = { version = "2.11.5"',
  );
  assert.throws(
    () => verifyTauriConfiguration(fixture),
    /version Cargo exacte/,
  );
});

test("les tests Windows conservent le manifeste Common Controls v6", () => {
  const fixture = inputs();
  fixture.buildRs = fixture.buildRs.replace(
    "cargo:rustc-link-arg=/MANIFEST:EMBED",
    "cargo:rustc-link-arg=/MANIFEST:NO",
  );
  assert.throws(
    () => verifyTauriConfiguration(fixture),
    /Common Controls v6/,
  );

  const wrongVersion = inputs();
  wrongVersion.windowsManifest = wrongVersion.windowsManifest.replace(
    'version="6.0.0.0"',
    'version="5.0.0.0"',
  );
  assert.throws(
    () => verifyTauriConfiguration(wrongVersion),
    /sélectionner exactement Common Controls v6/,
  );
});

test("une action mutable et des cibles non approuvées sont refusées", () => {
  const mutableAction = inputs();
  mutableAction.workflowText = mutableAction.workflowText.replace(
    /actions\/checkout@[0-9a-f]{40}/,
    "actions/checkout@v4",
  );
  assert.throws(
    () => verifyTauriConfiguration(mutableAction),
    /épinglées par SHA complet/,
  );

  const wrongTarget = inputs();
  wrongTarget.workflowText = wrongTarget.workflowText.replace(
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
  );
  assert.throws(
    () => verifyTauriConfiguration(wrongTarget),
    /Windows 11 x64/,
  );

  const nonUniversalMac = inputs();
  nonUniversalMac.workflowText = nonUniversalMac.workflowText.replace(
    "universal-apple-darwin",
    "aarch64-apple-darwin",
  );
  assert.throws(
    () => verifyTauriConfiguration(nonUniversalMac),
    /macOS 14/,
  );
});

test("la configuration suivie ne peut activer ni préconfigurer l'updater signé", () => {
  const updaterArtifacts = inputs();
  updaterArtifacts.tauriConfig.bundle.createUpdaterArtifacts = true;
  assert.throws(
    () => verifyTauriConfiguration(updaterArtifacts),
    /CI non signé/,
  );

  const updaterEndpoint = inputs();
  updaterEndpoint.tauriConfig.plugins = {
    updater: {
      pubkey: "placeholder",
      endpoints: ["https://example.com/latest.json"],
    },
  };
  assert.throws(
    () => verifyTauriConfiguration(updaterEndpoint),
    /aucune URL distante|overlay de release hors dépôt/,
  );
});

test("la CI doit inspecter les deux paquets réels sans secret ni upload", () => {
  const missingPackageGuard = inputs();
  missingPackageGuard.workflowText = missingPackageGuard.workflowText.replace(
    /\s+node scripts\/verify-tauri-package\.mjs `?[\s\S]*?--frontend-dist dist/,
    "",
  );
  assert.throws(
    () => verifyTauriConfiguration(missingPackageGuard),
    /verify-tauri-package/,
  );

  const secretInUnsignedCi = inputs();
  secretInUnsignedCi.workflowText += "\n# TAURI_SIGNING_PRIVATE_KEY must never be loaded here\n";
  assert.throws(
    () => verifyTauriConfiguration(secretInUnsignedCi),
    /aucune clé ou commande de signature/,
  );
});
