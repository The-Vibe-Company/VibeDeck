import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  updaterPublicKeyMaterial,
  validateTauriReleaseConfig,
} from "./create-tauri-release-config.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const MAX_PACKAGE_ENTRIES = 50_000;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_UPDATER_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const FORBIDDEN_RUNTIME_PATH = /(?:^|\/)(?:node_modules|node(?:\.exe)?|electron(?:\.exe)?|electron framework\.framework|app\.asar|resources\/app(?:\.asar)?|chrome_[^/]*\.pak|snapshot_blob\.bin|v8_context_snapshot\.bin|icudtl\.dat)(?:\/|$)/i;
const FORBIDDEN_LINKED_RUNTIME = /Electron Framework|Chromium Embedded Framework|libnode(?:\.|\s|$)|node\.dll/i;

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error && !allowFailure) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} a échoué (${result.status ?? "inconnu"}).\n${output}`);
  }
  return { ok: !result.error && result.status === 0, output };
}

function runBinary(command, args, maximumBytes, { allowEmpty = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: null,
    maxBuffer: maximumBytes + 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} a échoué (${result.status ?? "inconnu"}).\n${Buffer.from(result.stderr ?? []).toString("utf8")}`,
    );
  }
  const output = Buffer.from(result.stdout ?? []);
  assert.ok(
    (allowEmpty || output.length > 0) && output.length <= maximumBytes,
    "Entrée updater extraite de taille invalide.",
  );
  return output;
}

function requirePath(value, label, type = "file") {
  assert.equal(typeof value, "string", `${label} est requis.`);
  const absolute = realpathSync(path.resolve(value));
  const stats = statSync(absolute);
  assert.ok(type === "directory" ? stats.isDirectory() : stats.isFile(), `${label} a un type invalide.`);
  return absolute;
}

export function listPackageEntries(root) {
  const entries = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const name of readdirSync(current)) {
      const absolute = path.join(current, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      entries.push(relative);
      assert.ok(entries.length <= MAX_PACKAGE_ENTRIES, "Paquet Tauri anormalement volumineux.");
      const stats = lstatSync(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) queue.push(absolute);
    }
  }
  return entries.sort();
}

export function assertNoNodeElectronRuntime(entries, linkedLibraries = "") {
  for (const entry of entries) {
    assert.doesNotMatch(
      entry,
      FORBIDDEN_RUNTIME_PATH,
      `Runtime Node/Electron interdit dans le paquet Tauri : ${entry}.`,
    );
  }
  assert.doesNotMatch(
    linkedLibraries,
    FORBIDDEN_LINKED_RUNTIME,
    "Le binaire Tauri ne doit lier aucun runtime Node/Electron.",
  );
}

export function assertNoUnsignedUpdaterArtifacts(directories) {
  for (const directory of new Set(directories)) {
    const updaterFiles = readdirSync(directory).filter((name) =>
      /\.sig$|\.app\.tar\.gz$|\.nsis\.zip$/i.test(name));
    assert.deepEqual(
      updaterFiles,
      [],
      "Le build CI unsigned ne doit produire aucun artefact updater signé.",
    );
  }
}

function readBoundedExecutable(executable) {
  const stats = statSync(executable);
  assert.ok(stats.size > 0 && stats.size <= MAX_EXECUTABLE_BYTES, "Taille du binaire Tauri invalide.");
  return readFileSync(executable);
}

function fileSha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function bytesSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashFile(file, algorithm, maximumBytes) {
  const size = statSync(file).size;
  assert.ok(size > 0 && size <= maximumBytes, "Taille de l'artefact updater invalide.");
  const descriptor = openSync(file, "r");
  const hash = createHash(algorithm);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest();
}

function frontendAssetReferences(frontendDist) {
  const dist = requirePath(frontendDist, "Le frontend dist", "directory");
  const indexPath = path.join(dist, "index.html");
  assert.ok(existsSync(indexPath), "dist/index.html est absent.");
  const html = readFileSync(indexPath, "utf8");
  assert.match(html, /<!doctype html>/i, "Le frontend local n'est pas un document HTML.");
  assert.doesNotMatch(
    html,
    /(?:src|href)=["'](?:https?:)?\/\//i,
    "Le point d'entrée packagé ne doit charger aucun asset distant.",
  );
  const assets = [...html.matchAll(/(?:src|href)=["']\.\/([^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.ok(assets.length >= 2, "Les assets frontend fingerprintés sont absents.");
  for (const asset of assets) {
    assert.match(asset, /^assets\/[A-Za-z0-9_.-]+$/, `Asset frontend non borné : ${asset}.`);
    assert.ok(existsSync(path.join(dist, asset)), `Asset frontend absent : ${asset}.`);
  }
  return assets;
}

export function assertEmbeddedLocalFrontend(binary, frontendDist, platform) {
  const localProtocols =
    platform === "windows"
      ? ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"]
      : ["tauri://localhost"];
  assert.ok(
    localProtocols.some((protocol) => binary.includes(Buffer.from(protocol))),
    "Le protocole frontend local Tauri est absent du binaire.",
  );
  for (const asset of frontendAssetReferences(frontendDist)) {
    assert.ok(
      binary.includes(Buffer.from(`/${asset}`)) || binary.includes(Buffer.from(asset)),
      `L'asset frontend courant n'est pas embarqué dans le binaire : ${asset}.`,
    );
  }
}

export function parsePeMachine(binary) {
  assert.ok(binary.length >= 0x40, "Binaire PE tronqué.");
  assert.equal(binary.subarray(0, 2).toString("ascii"), "MZ", "Signature DOS PE absente.");
  const peOffset = binary.readUInt32LE(0x3c);
  assert.ok(peOffset >= 0x40 && peOffset + 6 <= binary.length, "Offset PE invalide.");
  assert.equal(binary.subarray(peOffset, peOffset + 4).toString("binary"), "PE\0\0");
  return binary.readUInt16LE(peOffset + 4);
}

function decodeCanonicalBase64(value, label) {
  assert.match(value, /^[A-Za-z0-9+/]+={0,2}$/, `${label} n'est pas en base64 canonique.`);
  const decoded = Buffer.from(value, "base64");
  assert.equal(decoded.toString("base64"), value, `${label} n'est pas en base64 canonique.`);
  return decoded;
}

export function verifyUpdaterArtifactSignature(artifact, signatureText, publicKey) {
  const encodedSignature = signatureText.trim();
  assert.ok(
    encodedSignature.length >= 80 && encodedSignature.length <= 16_384,
    "Signature updater invalide.",
  );
  const decoded = decodeCanonicalBase64(encodedSignature, "La signature updater").toString("utf8");
  const lines = decoded.trimEnd().split("\n");
  assert.equal(lines.length, 4, "Structure de signature updater invalide.");
  assert.equal(lines[0], "untrusted comment: signature from tauri secret key");
  assert.match(lines[2], /^trusted comment: timestamp:\d+\tfile:[^\r\n]+$/);

  const packet = decodeCanonicalBase64(lines[1], "Le paquet de signature updater");
  assert.equal(packet.length, 74, "Paquet de signature updater invalide.");
  assert.equal(packet.subarray(0, 2).toString("ascii"), "ED");
  const globalSignature = decodeCanonicalBase64(lines[3], "La signature du commentaire updater");
  assert.equal(globalSignature.length, 64, "Signature du commentaire updater invalide.");

  const material = updaterPublicKeyMaterial(publicKey);
  assert.deepEqual(
    packet.subarray(2, 10),
    material.keyId,
    "La signature updater n'utilise pas la clé publique configurée.",
  );
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, material.publicKey]),
    format: "der",
    type: "spki",
  });
  assert.equal(key.asymmetricKeyType, "ed25519", "Clé publique updater Ed25519 invalide.");

  const artifactDigest = hashFile(artifact, "blake2b512", MAX_UPDATER_ARTIFACT_BYTES);
  const artifactSignature = packet.subarray(10);
  assert.ok(
    verifySignature(null, artifactDigest, key, artifactSignature),
    "La signature updater ne correspond pas aux octets de l'artefact.",
  );
  const trustedComment = lines[2].slice("trusted comment: ".length);
  assert.ok(
    verifySignature(
      null,
      Buffer.concat([artifactSignature, Buffer.from(trustedComment, "utf8")]),
      key,
      globalSignature,
    ),
    "La signature du commentaire updater est invalide.",
  );
}

function normalizedTarEntry(entry) {
  const normalized = entry
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  assert.ok(normalized.length > 0 && normalized.length <= 4_096, "Chemin updater invalide.");
  assert.ok(!normalized.startsWith("/"), "Archive updater avec chemin absolu interdite.");
  assert.ok(
    normalized.split("/").every((segment) => segment !== ".." && segment !== ""),
    "Archive updater avec traversée de chemin interdite.",
  );
  return normalized;
}

function posixModeString(stats) {
  const mode = stats.mode;
  const permissions = [
    [0o400, "r"], [0o200, "w"], [0o100, "x"],
    [0o040, "r"], [0o020, "w"], [0o010, "x"],
    [0o004, "r"], [0o002, "w"], [0o001, "x"],
  ].map(([bit, character]) => (mode & bit) !== 0 ? character : "-");
  if ((mode & 0o4000) !== 0) permissions[2] = (mode & 0o100) !== 0 ? "s" : "S";
  if ((mode & 0o2000) !== 0) permissions[5] = (mode & 0o010) !== 0 ? "s" : "S";
  if ((mode & 0o1000) !== 0) permissions[8] = (mode & 0o001) !== 0 ? "t" : "T";
  return `${stats.isDirectory() ? "d" : "-"}${permissions.join("")}`;
}

export function assertMacUpdaterMatchesBundle(artifact, bundle, executable) {
  const listing = run("tar", ["-tzf", artifact]).output
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(listing.length > 0 && listing.length <= MAX_PACKAGE_ENTRIES, "Archive updater macOS invalide.");
  const normalized = listing.map(normalizedTarEntry);
  const verboseListing = run("tar", ["-tvzf", artifact]).output
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(
    verboseListing.length,
    listing.length,
    "Archive updater macOS avec métadonnées d'entrées ambiguës.",
  );
  const bundleName = path.basename(bundle);
  const bundleEntries = listPackageEntries(bundle);
  const expected = [bundleName, ...bundleEntries.map((entry) => `${bundleName}/${entry}`)].sort();
  assert.equal(new Set(normalized).size, normalized.length, "Archive updater macOS avec entrées dupliquées.");
  assert.deepEqual(
    [...normalized].sort(),
    expected,
    "L'updater macOS doit contenir exactement l'intégralité du bundle vérifié.",
  );

  for (let index = 0; index < listing.length; index += 1) {
    const entry = normalized[index];
    const relative = entry === bundleName ? "" : entry.slice(bundleName.length + 1);
    const local = relative.length === 0 ? bundle : path.join(bundle, ...relative.split("/"));
    const stats = lstatSync(local);
    assert.ok(
      !stats.isSymbolicLink(),
      `Lien symbolique interdit dans l'updater macOS vérifié : ${relative || bundleName}.`,
    );
    const archivedMode = verboseListing[index].slice(0, 10);
    assert.equal(
      archivedMode[0],
      stats.isDirectory() ? "d" : "-",
      `Le type de ${relative || bundleName} diffère entre l'updater et le bundle vérifié.`,
    );
    // Windows' stat emulation does not expose directory execute/search bits,
    // so comparing those synthetic values with POSIX tar metadata would make
    // this cross-platform fixture fail without proving anything. The real
    // macOS package verifier still binds every permission bit exactly.
    if (process.platform !== "win32") {
      assert.equal(
        archivedMode,
        posixModeString(stats),
        `Les permissions de ${relative || bundleName} diffèrent entre l'updater et le bundle vérifié.`,
      );
    }
    if (stats.isDirectory()) continue;
    assert.ok(stats.isFile(), `Type de fichier updater macOS interdit : ${relative}.`);
    assert.ok(
      stats.size <= MAX_EXECUTABLE_BYTES,
      `Fichier updater macOS anormalement volumineux : ${relative}.`,
    );
    const archived = runBinary(
      "tar",
      ["-xOzf", artifact, listing[index]],
      Math.max(stats.size, 1),
      { allowEmpty: true },
    );
    assert.equal(
      archived.length,
      stats.size,
      `La taille de ${relative} diffère entre l'updater et le bundle vérifié.`,
    );
    assert.equal(
      bytesSha256(archived),
      fileSha256(local),
      `Le contenu de ${relative} diffère entre l'updater et le bundle vérifié.`,
    );
  }

  assert.equal(
    realpathSync(path.join(bundle, "Contents", "MacOS", path.basename(executable))),
    realpathSync(executable),
    "Le binaire vérifié doit appartenir au bundle macOS lié à l'updater.",
  );
}

export function assertWindowsUpdaterMatchesInstaller(artifact, installer) {
  assert.equal(
    realpathSync(artifact),
    realpathSync(installer),
    "L'updater Windows doit être exactement l'installateur NSIS vérifié.",
  );
}

function verifyUpdaterArtifacts(options, platform, packageIdentity) {
  const releaseConfigPath = requirePath(options.releaseConfig, "La configuration de release");
  const releaseConfigRelative = path.relative(realpathSync(defaultRoot), releaseConfigPath);
  assert.ok(
    releaseConfigRelative === ".." || releaseConfigRelative.startsWith(`..${path.sep}`),
    "La configuration de release signée doit rester hors dépôt.",
  );
  const config = JSON.parse(readFileSync(releaseConfigPath, "utf8"));
  validateTauriReleaseConfig(config, platform);
  const artifact = requirePath(options.updaterArtifact, "L'artefact updater signé");
  const signature = requirePath(options.updaterSignature, "La signature updater");
  if (platform === "macos") {
    assert.ok(artifact.endsWith(".app.tar.gz"), "L'updater macOS doit être une archive .app.tar.gz.");
    assertMacUpdaterMatchesBundle(artifact, packageIdentity.bundle, packageIdentity.executable);
  } else {
    assert.ok(artifact.toLowerCase().endsWith(".exe"), "L'updater Windows v2 doit être l'installateur NSIS.");
    assertWindowsUpdaterMatchesInstaller(artifact, packageIdentity.installer);
  }
  assert.equal(signature, `${artifact}.sig`, "La signature updater doit être adjacente à son artefact.");
  const signatureText = readFileSync(signature, "utf8").trim();
  verifyUpdaterArtifactSignature(artifact, signatureText, config.plugins.updater.pubkey);
}

function verifyMacSignature(bundle, mode) {
  const details = run("codesign", ["--display", "--verbose=4", bundle], {
    allowFailure: mode === "unsigned",
  }).output;
  if (mode === "unsigned") {
    assert.ok(
      /Signature=(?:adhoc|linker-signed)|code object is not signed at all/i.test(details),
      "Le build CI macOS doit rester non signé ou ad hoc.",
    );
    assert.ok(
      /TeamIdentifier=not set/i.test(details) || /not signed at all/i.test(details),
      "Le build CI macOS ne doit utiliser aucune identité de diffusion.",
    );
    return;
  }

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle]);
  assert.match(details, /TeamIdentifier=(?!not set)\S+/, "TeamIdentifier Apple absent.");
  assert.match(details, /flags=.*\bruntime\b/i, "Hardened Runtime absent de la signature.");
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", bundle]);
  run("xcrun", ["stapler", "validate", bundle]);
}

function verifyMountedDmg(installer, bundle, executableName, options) {
  const mountPoint = mkdtempSync(path.join(tmpdir(), "vibedeck-dmg-"));
  let mounted = false;
  try {
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, installer]);
    mounted = true;
    const mountedBundle = path.join(mountPoint, "VibeDeck.app");
    assert.ok(existsSync(mountedBundle), "Le DMG ne contient pas VibeDeck.app.");
    const mountedExecutable = path.join(mountedBundle, "Contents", "MacOS", executableName);
    assert.ok(existsSync(mountedExecutable), "Le DMG ne contient pas l'exécutable Tauri.");
    assert.equal(
      fileSha256(mountedExecutable),
      fileSha256(path.join(bundle, "Contents", "MacOS", executableName)),
      "Le DMG ne contient pas le même binaire que le bundle vérifié.",
    );
    assert.equal(
      fileSha256(path.join(mountedBundle, "Contents", "Info.plist")),
      fileSha256(path.join(bundle, "Contents", "Info.plist")),
      "Le DMG ne contient pas le même manifeste que le bundle vérifié.",
    );
    assertNoNodeElectronRuntime(listPackageEntries(mountedBundle));
    assertEmbeddedLocalFrontend(
      readBoundedExecutable(mountedExecutable),
      options.frontendDist,
      "macos",
    );
    verifyMacSignature(mountedBundle, options.mode);
  } finally {
    if (mounted) {
      const detached = run("hdiutil", ["detach", mountPoint], { allowFailure: true });
      if (!detached.ok) run("hdiutil", ["detach", "-force", mountPoint]);
    }
    rmSync(mountPoint, { recursive: true, force: true });
  }
}

function verifyMacPackage(options) {
  const bundle = requirePath(options.bundle, "Le bundle .app", "directory");
  assert.ok(bundle.endsWith(".app"), "Le bundle macOS doit être une application .app.");
  const installer = requirePath(options.installer, "L'image DMG");
  assert.ok(installer.toLowerCase().endsWith(".dmg"), "L'installateur macOS doit être un DMG.");
  run("hdiutil", ["verify", installer]);

  const infoPlist = path.join(bundle, "Contents", "Info.plist");
  assert.ok(existsSync(infoPlist), "Info.plist Tauri absent.");
  const plist = (key) => run("plutil", ["-extract", key, "raw", "-o", "-", infoPlist]).output.trim();
  assert.equal(plist("CFBundleIdentifier"), "com.thevibecompany.vibedeck");
  assert.equal(plist("LSMinimumSystemVersion"), "14.0");
  const executable = path.join(bundle, "Contents", "MacOS", plist("CFBundleExecutable"));
  assert.ok(existsSync(executable), "Exécutable principal Tauri absent.");

  const architectures = new Set(run("lipo", ["-archs", executable]).output.trim().split(/\s+/));
  assert.deepEqual(architectures, new Set(["arm64", "x86_64"]), "Le bundle macOS doit être universel.");
  const buildVersion = run("vtool", ["-show-build", executable]).output;
  assert.match(buildVersion, /platform MACOS[\s\S]*minos 14\.0\b/, "Le binaire doit cibler macOS 14 minimum.");
  const linked = run("otool", ["-L", executable]).output;
  assertNoNodeElectronRuntime(listPackageEntries(bundle), linked);
  assertEmbeddedLocalFrontend(readBoundedExecutable(executable), options.frontendDist, "macos");
  verifyMacSignature(bundle, options.mode);
  verifyMountedDmg(installer, bundle, path.basename(executable), options);
  if (options.mode === "signed") {
    verifyUpdaterArtifacts(options, "macos", { bundle, executable });
  } else {
    assertNoUnsignedUpdaterArtifacts([path.dirname(bundle), path.dirname(installer)]);
  }
  return { bundle, executable, installer, platform: "macos", mode: options.mode };
}

function powershellSignature(file) {
  const escaped = file.replaceAll("'", "''");
  return run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status.ToString()`,
  ]).output.trim();
}

export function assertWindowsPayloadMatchesExecutable(payloadExecutables, expectedExecutable) {
  assert.ok(payloadExecutables.length > 0, "Le payload VibeDeck est absent de l'installateur NSIS.");
  const expected = requirePath(expectedExecutable, "L'exécutable Windows Tauri");
  const expectedHash = fileSha256(expected);
  for (const candidate of payloadExecutables) {
    const payload = requirePath(candidate, "L'exécutable VibeDeck extrait du NSIS");
    const binary = readBoundedExecutable(payload);
    assert.equal(parsePeMachine(binary), 0x8664, "Le payload NSIS doit cibler AMD64/x64.");
    assert.equal(
      fileSha256(payload),
      expectedHash,
      "Le NSIS ne contient pas l'exécutable Tauri vérifié et signé.",
    );
  }
}

function extractAndInspectNsis(installer, expectedExecutable) {
  const extractionRoot = mkdtempSync(path.join(tmpdir(), "vibedeck-nsis-"));
  try {
    const listing = run("7z", ["l", "-slt", installer]).output;
    assert.match(listing, /^Type = Nsis$/m, "L'installateur Windows doit être un paquet NSIS.");
    run("7z", ["x", "-y", `-o${extractionRoot}`, installer]);
    let entries = listPackageEntries(extractionRoot);
    assertNoNodeElectronRuntime(entries);
    const payloadExecutables = entries
      .filter((entry) => /(?:^|\/)vibedeck\.exe$/i.test(entry))
      .map((entry) => path.join(extractionRoot, entry));
    const embeddedArchives = entries.filter((entry) => /(?:^|\/)app-(?:32|64)\.7z$/i.test(entry));
    for (const [index, archive] of embeddedArchives.entries()) {
      const payload = path.join(extractionRoot, `payload-${index}`);
      run("7z", ["x", "-y", `-o${payload}`, path.join(extractionRoot, archive)]);
      const payloadEntries = listPackageEntries(payload);
      assertNoNodeElectronRuntime(payloadEntries);
      payloadExecutables.push(
        ...payloadEntries
          .filter((entry) => /(?:^|\/)vibedeck\.exe$/i.test(entry))
          .map((entry) => path.join(payload, entry)),
      );
      entries = entries.concat(payloadEntries);
    }
    assertWindowsPayloadMatchesExecutable(payloadExecutables, expectedExecutable);
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function verifyWindowsPackage(options) {
  const installer = requirePath(options.bundle, "L'installateur NSIS");
  assert.ok(installer.toLowerCase().endsWith(".exe"), "L'installateur Windows doit être un .exe NSIS.");
  assert.match(path.basename(installer), /(?:_|-)x64(?:-|_).*setup.*\.exe$|setup.*x64.*\.exe$/i,
    "Le nom de l'installateur doit déclarer la cible x64.");
  const executable = requirePath(options.executable, "L'exécutable Windows Tauri");
  const binary = readBoundedExecutable(executable);
  assert.equal(parsePeMachine(binary), 0x8664, "Le binaire Windows doit cibler AMD64/x64.");
  assertEmbeddedLocalFrontend(binary, options.frontendDist, "windows");
  assertNoNodeElectronRuntime([path.basename(executable)]);
  extractAndInspectNsis(installer, executable);

  const expectedSignature = options.mode === "signed" ? "Valid" : "NotSigned";
  assert.equal(powershellSignature(executable), expectedSignature, `Signature de l'exécutable ${expectedSignature} attendue.`);
  assert.equal(powershellSignature(installer), expectedSignature, `Signature NSIS ${expectedSignature} attendue.`);
  if (options.mode === "signed") {
    verifyUpdaterArtifacts(options, "windows", { installer });
  } else {
    assertNoUnsignedUpdaterArtifacts([path.dirname(installer)]);
  }
  return { bundle: installer, executable, platform: "windows", mode: options.mode };
}

export function validatePackageInvocation(options) {
  assert.ok(options.platform === "macos" || options.platform === "windows", "--platform macos|windows requis.");
  assert.ok(options.mode === "unsigned" || options.mode === "signed", "--mode unsigned|signed requis.");
  assert.equal(typeof options.bundle, "string", "--bundle est requis.");
  assert.equal(typeof options.frontendDist, "string", "--frontend-dist est requis.");
  if (options.platform === "macos") assert.equal(typeof options.installer, "string", "--installer DMG est requis.");
  if (options.platform === "windows") assert.equal(typeof options.executable, "string", "--executable est requis.");
  for (const signedOption of ["releaseConfig", "updaterArtifact", "updaterSignature"]) {
    if (options.mode === "signed") {
      assert.equal(typeof options[signedOption], "string", `--${signedOption} est requis en mode signé.`);
    } else {
      assert.equal(options[signedOption], undefined, `--${signedOption} est interdit en CI non signée.`);
    }
  }
  return options;
}

export function verifyTauriPackage(options) {
  validatePackageInvocation(options);
  return options.platform === "macos" ? verifyMacPackage(options) : verifyWindowsPackage(options);
}

function parseArguments(argv) {
  const aliases = new Map([
    ["release-config", "releaseConfig"],
    ["updater-artifact", "updaterArtifact"],
    ["updater-signature", "updaterSignature"],
    ["frontend-dist", "frontendDist"],
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    assert.ok(argument?.startsWith("--") && argv[index + 1], `Argument invalide : ${argument ?? "absent"}.`);
    const name = argument.slice(2);
    const normalizedName = aliases.get(name) ?? name;
    assert.equal(Object.hasOwn(options, normalizedName), false, `Argument dupliqué : ${argument}.`);
    options[normalizedName] = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const options = parseArguments(process.argv.slice(2));
  options.frontendDist ??= path.join(defaultRoot, "dist");
  const result = verifyTauriPackage(options);
  process.stdout.write(
    `✓ Paquet Tauri ${result.platform} ${result.mode}: frontend local, runtime natif et cible vérifiés.\n`,
  );
}
