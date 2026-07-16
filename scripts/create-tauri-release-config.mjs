import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const PLACEHOLDER = /(?:change[-_ ]?me|example\.(?:com|org|net)|placeholder|todo|dummy|fake)/i;
const ALLOWED_ENDPOINT_VARIABLES = new Set([
  "current_version",
  "target",
  "arch",
]);

const RESERVED_IPV4_ENDPOINTS = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  RESERVED_IPV4_ENDPOINTS.addSubnet(network, prefix, "ipv4");
}

const RESERVED_IPV6_ENDPOINTS = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0.0.0.0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  RESERVED_IPV6_ENDPOINTS.addSubnet(network, prefix, "ipv6");
}

function requiredValue(
  environment,
  name,
  { min = 1, max = 16_384, rejectPlaceholder = true } = {},
) {
  const value = environment[name];
  assert.equal(typeof value, "string", `${name} est requis pour une release Tauri signée.`);
  const trimmed = value.trim();
  assert.ok(trimmed.length >= min, `${name} est vide ou trop court.`);
  assert.ok(trimmed.length <= max, `${name} dépasse la limite autorisée.`);
  if (rejectPlaceholder) {
    assert.doesNotMatch(trimmed, PLACEHOLDER, `${name} contient une valeur factice.`);
  }
  assert.ok(!trimmed.includes("\0"), `${name} contient un octet nul.`);
  return trimmed;
}

function assertPathOutsideRepository(filePath, root, label) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(realpathSync(root), absolute);
  assert.ok(
    (relative === ".." || relative.startsWith(`..${path.sep}`)) && !path.isAbsolute(relative),
    `${label} doit rester hors du dépôt.`,
  );
  return absolute;
}

function assertSecretFile(filePath, root, label, contentPattern) {
  assert.ok(existsSync(filePath), `${label} est introuvable.`);
  const absolute = assertPathOutsideRepository(realpathSync(filePath), root, label);
  const stats = statSync(absolute);
  assert.ok(stats.isFile(), `${label} doit désigner un fichier.`);
  assert.ok(stats.size > 0 && stats.size <= 64 * 1024, `${label} a une taille invalide.`);
  if (contentPattern) {
    assert.match(readFileSync(absolute, "utf8"), contentPattern, `${label} est invalide.`);
  }
  return absolute;
}

function parseUpdaterPublicKey(value) {
  assert.equal(typeof value, "string", "TAURI_UPDATER_PUBKEY est requis.");
  const encoded = value.trim();
  assert.ok(encoded.length >= 100 && encoded.length <= 4_096, "Clé publique updater invalide.");
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/, "Clé publique updater non base64.");
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  assert.match(
    decoded,
    /^untrusted comment: minisign public key: [0-9A-F]{16}\nRW[A-Za-z0-9+/]+={0,2}\n?$/,
    "La clé publique updater n'est pas une clé minisign Tauri.",
  );
  assert.equal(
    Buffer.from(Buffer.from(encoded, "base64")).toString("base64"),
    encoded,
    "La clé publique updater doit utiliser un encodage base64 canonique.",
  );
  const [comment, packetLine] = decoded.trimEnd().split("\n");
  const packet = Buffer.from(packetLine, "base64");
  assert.equal(packet.length, 42, "Paquet de clé publique updater invalide.");
  assert.equal(packet.subarray(0, 2).toString("ascii"), "Ed", "Algorithme de clé updater invalide.");
  const keyId = packet.subarray(2, 10);
  assert.equal(
    comment.slice(-16),
    Buffer.from(keyId).reverse().toString("hex").toUpperCase(),
    "Identifiant de clé publique updater incohérent.",
  );
  return { encoded, keyId, publicKey: packet.subarray(10) };
}

export function validateUpdaterPublicKey(value) {
  return parseUpdaterPublicKey(value).encoded;
}

export function updaterPublicKeyMaterial(value) {
  const { keyId, publicKey } = parseUpdaterPublicKey(value);
  return {
    keyId: Buffer.from(keyId),
    publicKey: Buffer.from(publicKey),
  };
}

function isForbiddenEndpointHost(hostname) {
  const normalized = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const host = normalized.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid")
  ) {
    return true;
  }
  if (isIP(host) === 4) return RESERVED_IPV4_ENDPOINTS.check(host, "ipv4");
  if (isIP(host) === 6) return RESERVED_IPV6_ENDPOINTS.check(host, "ipv6");
  return false;
}

export function validateUpdaterEndpoint(value) {
  assert.equal(typeof value, "string", "TAURI_UPDATER_ENDPOINT est requis.");
  const endpoint = value.trim();
  assert.ok(endpoint.length >= 12 && endpoint.length <= 2_048, "Endpoint updater invalide.");
  assert.doesNotMatch(endpoint, PLACEHOLDER, "Endpoint updater factice.");

  const variables = [...endpoint.matchAll(/\{\{([^{}]+)}}/g)].map((match) => match[1]);
  for (const variable of variables) {
    assert.ok(
      ALLOWED_ENDPOINT_VARIABLES.has(variable),
      `Variable updater non autorisée : ${variable}.`,
    );
  }
  const withoutVariables = endpoint.replace(/\{\{[^{}]+}}/g, "value");
  assert.ok(!/[{}]/.test(withoutVariables), "Endpoint updater mal formé.");
  const parsed = new URL(withoutVariables);
  assert.equal(parsed.protocol, "https:", "L'endpoint updater doit utiliser HTTPS.");
  assert.equal(parsed.username, "", "L'endpoint updater ne doit contenir aucun identifiant.");
  assert.equal(parsed.password, "", "L'endpoint updater ne doit contenir aucun secret.");
  assert.equal(parsed.hash, "", "L'endpoint updater ne doit contenir aucun fragment.");
  assert.ok(!isForbiddenEndpointHost(parsed.hostname), "Hôte updater local ou réservé interdit.");
  return endpoint;
}

function validateUpdaterSigningSecret(environment, root) {
  const inline = environment.TAURI_SIGNING_PRIVATE_KEY?.trim();
  const keyPath = environment.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim();
  assert.notEqual(Boolean(inline), Boolean(keyPath),
    "Définir exactement une clé updater : TAURI_SIGNING_PRIVATE_KEY ou TAURI_SIGNING_PRIVATE_KEY_PATH.");
  if (inline) {
    validateUpdaterPrivateKey(
      requiredValue(environment, "TAURI_SIGNING_PRIVATE_KEY", {
        min: 100,
        max: 64 * 1024,
        rejectPlaceholder: false,
      }),
    );
  } else {
    const privateKeyPath = assertSecretFile(keyPath, root, "TAURI_SIGNING_PRIVATE_KEY_PATH");
    validateUpdaterPrivateKey(readFileSync(privateKeyPath, "utf8"));
  }
  requiredValue(environment, "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", {
    min: 12,
    max: 1_024,
    rejectPlaceholder: false,
  });
}

function validateUpdaterPrivateKey(value) {
  const encoded = value.trim();
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/, "Clé privée updater non base64.");
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  assert.match(
    decoded,
    /^untrusted comment: rsign encrypted secret key\nRW[A-Za-z0-9+/]+={0,2}\n?$/,
    "La clé privée updater n'est pas une clé chiffrée produite par Tauri.",
  );
}

function macOSReleaseBundle(environment, root) {
  const signingIdentity = requiredValue(environment, "APPLE_SIGNING_IDENTITY", { min: 8, max: 512 });
  assert.match(
    signingIdentity,
    /^Developer ID Application:/,
    "Une release macOS directe exige une identité Developer ID Application.",
  );
  assert.match(
    requiredValue(environment, "APPLE_API_ISSUER", {
      min: 36,
      max: 36,
      rejectPlaceholder: false,
    }),
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
    "APPLE_API_ISSUER doit être un UUID.",
  );
  assert.match(
    requiredValue(environment, "APPLE_API_KEY", {
      min: 10,
      max: 10,
      rejectPlaceholder: false,
    }),
    /^[A-Z0-9]{10}$/,
    "APPLE_API_KEY doit être un Key ID Apple.",
  );
  assert.match(
    requiredValue(environment, "APPLE_TEAM_ID", {
      min: 10,
      max: 10,
      rejectPlaceholder: false,
    }),
    /^[A-Z0-9]{10}$/,
    "APPLE_TEAM_ID est invalide.",
  );
  assertSecretFile(
    requiredValue(environment, "APPLE_API_KEY_PATH", { min: 2, max: 4_096 }),
    root,
    "APPLE_API_KEY_PATH",
    /-----BEGIN PRIVATE KEY-----/,
  );
  return {
    targets: ["app", "dmg"],
    macOS: {
      hardenedRuntime: true,
      minimumSystemVersion: "14.0",
      signingIdentity,
    },
  };
}

function windowsReleaseBundle(environment) {
  const publisher = requiredValue(environment, "VIBEDECK_WINDOWS_PUBLISHER", { min: 2, max: 256 });
  const signCommand = requiredValue(environment, "VIBEDECK_WINDOWS_SIGN_COMMAND", {
    min: 8,
    max: 1_024,
  });
  assert.ok(!/[\r\n]/.test(signCommand), "La commande de signature Windows doit tenir sur une ligne.");
  assert.doesNotMatch(
    signCommand,
    /(?:password|passwd|secret|token|client[-_ ]?secret)\s*(?:=|\s)/i,
    "La commande de signature Windows doit lire ses secrets depuis l'environnement.",
  );
  assert.equal(
    (signCommand.match(/%1/g) ?? []).length,
    1,
    "La commande de signature Windows doit contenir exactement un placeholder %1.",
  );
  return {
    publisher,
    targets: ["nsis"],
    windows: {
      signCommand,
      nsis: { installMode: "currentUser" },
    },
  };
}

export function validateTauriReleaseConfig(config, platform) {
  assert.ok(platform === "macos" || platform === "windows", "Plateforme attendue : macos ou windows.");
  assert.equal(config?.bundle?.createUpdaterArtifacts, true);
  assert.deepEqual(
    config.bundle.targets,
    platform === "macos" ? ["app", "dmg"] : ["nsis"],
    "Cibles de release Tauri incorrectes.",
  );
  assert.equal(config?.plugins?.updater?.dangerousInsecureTransportProtocol, false);
  validateUpdaterPublicKey(config?.plugins?.updater?.pubkey);
  assert.equal(config?.plugins?.updater?.endpoints?.length, 1);
  validateUpdaterEndpoint(config.plugins.updater.endpoints[0]);
  const serialized = JSON.stringify(config);
  assert.doesNotMatch(
    serialized,
    /TAURI_SIGNING_PRIVATE_KEY|PRIVATE KEY|SIGNING_PRIVATE_KEY_PASSWORD/,
    "Une configuration publique ne doit jamais contenir la clé privée updater.",
  );
  if (platform === "macos") {
    assert.equal(config.bundle.macOS?.hardenedRuntime, true);
    assert.equal(config.bundle.macOS?.minimumSystemVersion, "14.0");
    assert.ok(config.bundle.macOS?.signingIdentity?.length >= 8);
    assert.equal(Object.hasOwn(config.bundle, "windows"), false);
  } else {
    assert.equal(config.bundle.windows?.nsis?.installMode, "currentUser");
    assert.equal(
      (config.bundle.windows?.signCommand?.match(/%1/g) ?? []).length,
      1,
      "Commande de signature Windows invalide.",
    );
    assert.equal(config.plugins.updater.windows?.installMode, "passive");
    assert.equal(Object.hasOwn(config.bundle, "macOS"), false);
  }
  return config;
}

export function createTauriReleaseConfig({ platform, environment = process.env, root = defaultRoot }) {
  assert.ok(platform === "macos" || platform === "windows", "Plateforme attendue : macos ou windows.");
  validateUpdaterSigningSecret(environment, root);
  const pubkey = validateUpdaterPublicKey(requiredValue(environment, "TAURI_UPDATER_PUBKEY", {
    min: 100,
    max: 4_096,
    rejectPlaceholder: false,
  }));
  const endpoint = validateUpdaterEndpoint(requiredValue(environment, "TAURI_UPDATER_ENDPOINT", {
    min: 12,
    max: 2_048,
  }));

  return validateTauriReleaseConfig({
    bundle: {
      createUpdaterArtifacts: true,
      ...(platform === "macos"
        ? macOSReleaseBundle(environment, root)
        : windowsReleaseBundle(environment)),
    },
    plugins: {
      updater: {
        pubkey,
        endpoints: [endpoint],
        dangerousInsecureTransportProtocol: false,
        ...(platform === "windows" ? { windows: { installMode: "passive" } } : {}),
      },
    },
  }, platform);
}

export function writeTauriReleaseConfig({ output, ...options }) {
  assert.equal(typeof output, "string", "--output est requis.");
  const root = options.root ?? defaultRoot;
  const requestedDestination = assertPathOutsideRepository(output, root, "La configuration de release");
  const parent = path.dirname(requestedDestination);
  assert.ok(existsSync(parent), "Le dossier de sortie de release doit déjà exister.");
  const destination = assertPathOutsideRepository(
    path.join(realpathSync(parent), path.basename(requestedDestination)),
    root,
    "La configuration de release",
  );
  assert.ok(!existsSync(destination), "Refus d'écraser une configuration de release existante.");
  const config = createTauriReleaseConfig({ ...options, root });
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, destination);
  return { destination, config };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--platform" || argument === "--output") {
      options[argument.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Argument inconnu : ${argument}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const { platform, output } = parseArguments(process.argv.slice(2));
  const { destination } = writeTauriReleaseConfig({ platform, output });
  process.stdout.write(`✓ Configuration de release Tauri ${platform} écrite hors dépôt : ${destination}\n`);
}
