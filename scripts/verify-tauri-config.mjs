import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { findUnsafeWorkflowUses } from "./workflow-uses.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const EXACT_VERSION = /^=\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const REMOTE_URL = /(?:https?|wss?|ftp):\/\//i;

function parseTomlString(value, label) {
  const match = value.trim().match(/^"((?:\\.|[^"\\])*)"/);
  assert.ok(match, `${label} doit être une chaîne TOML sur une seule ligne.`);
  return JSON.parse(`"${match[1]}"`);
}

function parseCargoManifest(cargoToml) {
  const packageFields = new Map();
  const dependencies = [];
  let section = "";

  for (const [index, rawLine] of cargoToml.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const heading = line.match(/^\[([^\]]+)]$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;

    const [, name, value] = assignment;
    if (
      section === "package" &&
      ["name", "version", "rust-version"].includes(name)
    ) {
      packageFields.set(name, parseTomlString(value, `package.${name}`));
    }
    if (!/(?:^|\.)(?:build-|dev-)?dependencies$/.test(section)) continue;

    const inlineVersion = value.match(/(?:^|[,\s{])version\s*=\s*"([^"]+)"/);
    const version = value.startsWith('"')
      ? parseTomlString(value, `${section}.${name}`)
      : inlineVersion?.[1] ?? null;
    assert.ok(version, `Version Cargo manquante pour ${section}.${name}, ligne ${index + 1}.`);
    assert.match(
      version,
      EXACT_VERSION,
      `Une version Cargo exacte (=x.y.z) est requise pour ${section}.${name}.`,
    );
    assert.doesNotMatch(
      value,
      /\b(?:branch|git|path|rev)\s*=/,
      `${section}.${name} ne doit pas contourner le registre et son lockfile.`,
    );
    dependencies.push({ name, version: version.slice(1), section });
  }

  return { packageFields, dependencies };
}

function parseCargoLockPackages(cargoLock) {
  const packages = [];
  for (const block of cargoLock.split(/^\[\[package]]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (name && version) packages.push({ name, version });
  }
  return packages;
}

function cspDirectives(csp) {
  return new Map(
    csp
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...values] = directive.split(/\s+/);
        return [name, values];
      }),
  );
}

function cloneWithoutAllowedDevelopmentUrls(config) {
  const clone = structuredClone(config);
  delete clone.$schema;
  if (clone.build) delete clone.build.devUrl;
  return clone;
}

function workflowRunCommands(workflow) {
  return (workflow.jobs?.tauri?.steps ?? [])
    .map((step) => step?.run)
    .filter((command) => typeof command === "string")
    .join("\n");
}

export function loadTauriVerificationInputs(root = defaultRoot) {
  return {
    root,
    packageJson: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")),
    packageLock: JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")),
    tauriConfig: JSON.parse(
      readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
    ),
    cargoToml: readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8"),
    cargoLock: readFileSync(path.join(root, "src-tauri/Cargo.lock"), "utf8"),
    rustToolchain: readFileSync(path.join(root, "rust-toolchain.toml"), "utf8"),
    capability: JSON.parse(
      readFileSync(path.join(root, "src-tauri/capabilities/main-local.json"), "utf8"),
    ),
    workflowText: readFileSync(
      path.join(root, ".github/workflows/tauri-ci.yml"),
      "utf8",
    ),
  };
}

export function verifyTauriConfiguration(inputs) {
  const {
    packageJson,
    packageLock,
    tauriConfig,
    cargoToml,
    cargoLock,
    rustToolchain,
    capability,
    workflowText,
  } = inputs;

  assert.equal(tauriConfig.$schema, "https://schema.tauri.app/config/2");
  assert.equal(tauriConfig.productName, "VibeDeck");
  assert.equal(tauriConfig.identifier, "com.thevibecompany.vibedeck");
  assert.equal(tauriConfig.version, packageJson.version, "Versions npm/Tauri désynchronisées.");
  assert.equal(tauriConfig.build?.frontendDist, "../dist");
  assert.equal(
    tauriConfig.build?.devUrl,
    "http://127.0.0.1:5173",
    "Le serveur de développement doit rester strictement loopback.",
  );
  assert.doesNotMatch(
    JSON.stringify(cloneWithoutAllowedDevelopmentUrls(tauriConfig)),
    REMOTE_URL,
    "La configuration de diffusion Tauri ne doit contenir aucune URL distante.",
  );

  assert.equal(tauriConfig.app?.windows?.length, 1, "Une seule fenêtre locale est attendue.");
  const [mainWindow] = tauriConfig.app.windows;
  assert.equal(mainWindow.label, "main");
  assert.equal(Object.hasOwn(mainWindow, "url"), false, "La fenêtre main doit charger le frontend local.");
  assert.deepEqual(tauriConfig.app.security?.capabilities, ["main-local"]);
  const directives = cspDirectives(tauriConfig.app.security?.csp ?? "");
  assert.deepEqual(directives.get("default-src"), ["'self'"]);
  assert.deepEqual(directives.get("connect-src"), ["'self'"]);
  assert.deepEqual(
    directives.get("img-src"),
    ["'self'", "data:"],
    "Le renderer ne doit jamais télécharger directement une image distante.",
  );
  assert.deepEqual(directives.get("object-src"), ["'none'"]);
  assert.deepEqual(directives.get("frame-src"), ["'none'"]);
  assert.ok(!directives.get("script-src")?.includes("'unsafe-eval'"));

  assert.equal(tauriConfig.bundle?.active, true);
  assert.equal(
    tauriConfig.bundle?.createUpdaterArtifacts,
    false,
    "Le CI non signé ne doit jamais produire d'artefact updater.",
  );
  assert.equal(
    tauriConfig.plugins?.updater,
    undefined,
    "Les vraies clés et URLs updater doivent venir uniquement de l'overlay de release hors dépôt.",
  );
  assert.deepEqual(tauriConfig.bundle?.targets, ["app", "dmg", "nsis"]);
  assert.equal(
    tauriConfig.bundle?.macOS?.minimumSystemVersion,
    "14.0",
    "La cible minimale doit rester macOS 14.",
  );
  assert.equal(tauriConfig.bundle?.macOS?.hardenedRuntime, true);
  assert.equal(tauriConfig.bundle?.windows?.nsis?.installMode, "currentUser");

  assert.equal(capability.identifier, "main-local");
  assert.equal(
    Object.hasOwn(capability, "windows"),
    false,
    "main-local ne doit pas accorder ses droits à toute une fenêtre et ses futurs webviews.",
  );
  assert.deepEqual(capability.webviews, ["main"]);
  assert.deepEqual(
    capability.permissions,
    ["core:app:allow-version"],
    "La webview locale ne doit recevoir que la lecture de version utilisée par la façade.",
  );
  assert.equal(
    Object.hasOwn(capability, "remote"),
    false,
    "main-local ne doit jamais accorder de capability à une origine distante.",
  );
  assert.doesNotMatch(
    JSON.stringify(capability),
    REMOTE_URL,
    "main-local ne doit contenir aucune URL distante.",
  );

  const manifest = parseCargoManifest(cargoToml);
  assert.equal(manifest.packageFields.get("name"), "vibedeck");
  assert.equal(manifest.packageFields.get("version"), packageJson.version);
  assert.equal(manifest.packageFields.get("rust-version"), "1.88");
  assert.match(rustToolchain, /^channel\s*=\s*"1\.88\.0"$/m);
  assert.match(rustToolchain, /^profile\s*=\s*"minimal"$/m);
  assert.match(rustToolchain, /^components\s*=\s*\["clippy",\s*"rustfmt"\]$/m);
  for (const requiredDependency of ["rusqlite", "tauri", "tauri-build", "wry"]) {
    assert.ok(
      manifest.dependencies.some(({ name }) => name === requiredDependency),
      `Dépendance Tauri structurante manquante : ${requiredDependency}.`,
    );
  }
  assert.match(cargoLock, /^version = 4$/m, "Cargo.lock v4 doit être committé.");
  const lockedPackages = parseCargoLockPackages(cargoLock);
  for (const dependency of manifest.dependencies) {
    assert.ok(
      lockedPackages.some(
        ({ name, version }) => name === dependency.name && version === dependency.version,
      ),
      `${dependency.name} ${dependency.version} manque dans Cargo.lock.`,
    );
  }
  assert.ok(
    lockedPackages.some(
      ({ name, version }) => name === "vibedeck" && version === packageJson.version,
    ),
    "Le paquet racine Cargo.lock doit suivre la version applicative.",
  );

  assert.match(packageJson.dependencies?.["@tauri-apps/api"] ?? "", /^\d+\.\d+\.\d+$/);
  assert.match(packageJson.devDependencies?.["@tauri-apps/cli"] ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(
    packageLock.packages?.["node_modules/@tauri-apps/api"]?.version,
    packageJson.dependencies["@tauri-apps/api"],
  );
  assert.equal(
    packageLock.packages?.["node_modules/@tauri-apps/cli"]?.version,
    packageJson.devDependencies["@tauri-apps/cli"],
  );
  assert.equal(
    packageJson.scripts?.["audit:rust"],
    "cargo audit --file src-tauri/Cargo.lock",
    "L’audit Rust doit toujours viser le lockfile distribué.",
  );
  assert.equal(
    packageJson.scripts?.["test:tauri-package"],
    "node --test scripts/create-tauri-release-config.test.mjs scripts/verify-tauri-package.test.mjs",
  );
  assert.equal(
    packageJson.scripts?.["verify:tauri-package"],
    "node scripts/verify-tauri-package.mjs",
  );
  assert.equal(
    packageJson.scripts?.["prepare:tauri-release-config"],
    "node scripts/create-tauri-release-config.mjs",
  );

  const workflow = yaml.load(workflowText, { filename: "tauri-ci.yml" });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(
    findUnsafeWorkflowUses(workflowText, "tauri-ci.yml"),
    [],
    "Toutes les actions Tauri CI doivent être épinglées par SHA complet.",
  );
  assert.deepEqual(workflow.on?.push?.branches, ["main"]);
  assert.ok(workflow.on?.pull_request, "Le workflow Tauri doit valider les pull requests.");
  assert.ok(Object.hasOwn(workflow.on ?? {}, "workflow_dispatch"));
  for (const eventName of ["push", "pull_request"]) {
    const paths = workflow.on?.[eventName]?.paths ?? [];
    assert.ok(
      paths.includes("scripts/verify-tauri-config.mjs") &&
        paths.includes("scripts/verify-tauri-config.test.mjs") &&
        paths.includes("scripts/verify-tauri-package.mjs") &&
        paths.includes("scripts/verify-tauri-package.test.mjs") &&
        paths.includes("scripts/create-tauri-release-config.mjs") &&
        paths.includes("scripts/create-tauri-release-config.test.mjs"),
      `${eventName} doit surveiller tous les garde-fous Tauri et leurs tests.`,
    );
    assert.ok(paths.includes("rust-toolchain.toml"), `${eventName} doit surveiller le toolchain Rust.`);
  }
  assert.equal(workflow.jobs?.tauri?.["runs-on"], "${{ matrix.os }}");
  assert.equal(workflow.jobs?.tauri?.env?.RUSTUP_TOOLCHAIN, "1.88.0");

  const platforms = workflow.jobs?.tauri?.strategy?.matrix?.include ?? [];
  assert.deepEqual(
    platforms.map((platform) => ({
      os: platform.os,
      intent: platform.platform_intent,
      target: platform.rust_target,
      bundles: platform.bundles,
    })),
    [
      {
        os: "macos-15",
        intent: "macos-14-universal",
        target: "universal-apple-darwin",
        bundles: "app,dmg",
      },
      {
        os: "windows-2022",
        intent: "windows-11-x64",
        target: "x86_64-pc-windows-msvc",
        bundles: "nsis",
      },
    ],
    "La matrice doit construire la compatibilité macOS 14 sur un runner maintenu et la cible distribuée Windows 11 x64.",
  );

  const commands = workflowRunCommands(workflow);
  for (const requiredCommand of [
    /npm ci/,
    /npm run build/,
    /node scripts\/verify-tauri-config\.mjs/,
    /node --test scripts\/verify-tauri-config\.test\.mjs/,
    /npm run test:tauri-package/,
    /rustup target add aarch64-apple-darwin x86_64-apple-darwin/,
    /cargo install cargo-audit --version 0\.22\.2 --locked/,
    /npm run audit:rust/,
    /cargo fmt --all -- --check/,
    /cargo check --locked --all-targets --target aarch64-apple-darwin/,
    /cargo check --locked --all-targets --target x86_64-apple-darwin/,
    /cargo check --locked --all-targets --target x86_64-pc-windows-msvc/,
    /cargo test --locked --all-targets(?:\s|$)/,
    /cargo clippy --locked --all-targets --target aarch64-apple-darwin -- -D warnings/,
    /cargo clippy --locked --all-targets --target x86_64-apple-darwin -- -D warnings/,
    /cargo clippy --locked --all-targets --target x86_64-pc-windows-msvc -- -D warnings/,
    /npx --no-install tauri build --ci[\s\S]*--no-sign/,
    /node scripts\/verify-tauri-package\.mjs[\s\S]*--platform macos[\s\S]*--mode unsigned/,
    /node scripts\/verify-tauri-package\.mjs[\s\S]*--platform windows[\s\S]*--mode unsigned/,
  ]) {
    assert.match(commands, requiredCommand, `Commande Tauri CI manquante : ${requiredCommand}.`);
  }
  assert.doesNotMatch(workflowText, /\bsecrets\./, "Le smoke CI ne doit demander aucun secret.");
  assert.doesNotMatch(
    workflowText,
    /TAURI_SIGNING_PRIVATE_KEY|APPLE_SIGNING_IDENTITY|VIBEDECK_WINDOWS_SIGN_COMMAND/,
    "La CI unsigned ne doit charger aucune clé ou commande de signature.",
  );
  assert.doesNotMatch(
    workflowText,
    /actions\/upload-artifact|tauri-apps\/tauri-action|\bpublish\b/i,
    "Le smoke CI ne doit ni publier ni téléverser de bundle.",
  );

  return {
    version: packageJson.version,
    cargoDependencies: manifest.dependencies.length,
    macOSMinimumVersion: tauriConfig.bundle.macOS.minimumSystemVersion,
    macOSTarget: platforms[0].rust_target,
    windowsTarget: platforms[1].rust_target,
  };
}

export function verifyTauriProject(root = defaultRoot) {
  return verifyTauriConfiguration(loadTauriVerificationInputs(root));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const result = verifyTauriProject();
  process.stdout.write(
    `✓ Tauri ${result.version}: ${result.cargoDependencies} dépendances Cargo épinglées, ` +
      `macOS ${result.macOSMinimumVersion} universel (${result.macOSTarget}), ` +
      `Windows 11 x64 (${result.windowsTarget}), ` +
      "capability locale et CI non signée.\n",
  );
}
