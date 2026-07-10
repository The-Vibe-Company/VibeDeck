import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FuseV1Options,
  FuseVersion,
} from "@electron/fuses";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = path.join(root, "release");
const fuseSentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");

// Keep this independent from package.json: the binary check must fail even if a
// future configuration edit accidentally weakens both the build and its config test.
const expectedFuses = Object.freeze([
  [FuseV1Options.RunAsNode, "RunAsNode", false],
  [FuseV1Options.EnableCookieEncryption, "EnableCookieEncryption", true],
  [
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    "EnableNodeOptionsEnvironmentVariable",
    false,
  ],
  [FuseV1Options.EnableNodeCliInspectArguments, "EnableNodeCliInspectArguments", false],
  [
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    "EnableEmbeddedAsarIntegrityValidation",
    true,
  ],
  [FuseV1Options.OnlyLoadAppFromAsar, "OnlyLoadAppFromAsar", true],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, "GrantFileProtocolExtraPrivileges", false],
]);

function fuseState(value) {
  // @electron/fuses exposes the wire byte returned by Electron: ASCII "1" or
  // "0". Accept booleans too so the verifier remains compatible with a future
  // public API that normalizes the state.
  if (value === true || value === 49 || value === "1") return true;
  if (value === false || value === 48 || value === "0") return false;
  throw new Error(`État de fuse Electron inconnu (${String(value)}).`);
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function discoverPackagedApplications() {
  let entries;
  try {
    entries = await readdir(releaseDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const productName = packageJson.build?.productName;
  assert.equal(typeof productName, "string", "Nom de produit Electron introuvable.");

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("mac")) {
      const appPath = path.join(releaseDirectory, entry.name, `${productName}.app`);
      if (await exists(appPath)) candidates.push(appPath);
    }
    if (entry.name.startsWith("win") && entry.name.endsWith("-unpacked")) {
      const executablePath = path.join(releaseDirectory, entry.name, `${productName}.exe`);
      if (await exists(executablePath)) candidates.push(executablePath);
    }
  }
  return candidates.sort();
}

async function applicationPaths() {
  const requested = process.argv.slice(2).map((candidate) => path.resolve(candidate));
  if (requested.length > 0) return requested;

  const discovered = await discoverPackagedApplications();
  if (discovered.length === 0) {
    throw new Error(
      "Aucune application empaquetée trouvée dans release/. Construisez-la ou passez son chemin en argument.",
    );
  }
  if (discovered.length > 1) {
    throw new Error(
      `Plusieurs applications empaquetées sont présentes. Passez explicitement le chemin à vérifier :\n${discovered.join("\n")}`,
    );
  }
  return discovered;
}

function fuseBinaryPath(applicationPath) {
  if (!applicationPath.endsWith(".app")) return applicationPath;
  return path.join(
    applicationPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Electron Framework",
  );
}

async function readFuseWires(applicationPath) {
  const binary = await readFile(fuseBinaryPath(applicationPath));
  const offsets = [];
  let offset = binary.indexOf(fuseSentinel);
  while (offset !== -1) {
    offsets.push(offset);
    offset = binary.indexOf(fuseSentinel, offset + fuseSentinel.length);
  }
  assert.ok(offsets.length > 0, "Sentinelle des fuses Electron introuvable.");
  assert.ok(
    offsets.length <= 2,
    `Nombre inattendu de fils de fuses Electron : ${offsets.length}.`,
  );

  return offsets.map((sentinelOffset) => {
    const wireOffset = sentinelOffset + fuseSentinel.length;
    const version = String(binary[wireOffset]);
    const length = binary[wireOffset + 1];
    assert.ok(Number.isInteger(length), "Longueur du fil de fuses Electron invalide.");
    assert.ok(
      wireOffset + 2 + length <= binary.length,
      "Fil de fuses Electron tronqué.",
    );
    return {
      version,
      states: binary.subarray(wireOffset + 2, wireOffset + 2 + length),
    };
  });
}

for (const applicationPath of await applicationPaths()) {
  assert.ok(await exists(applicationPath), `Application empaquetée introuvable : ${applicationPath}`);
  const wires = await readFuseWires(applicationPath);
  const failures = [];
  for (const [wireIndex, wire] of wires.entries()) {
    assert.equal(wire.version, FuseVersion.V1, "Version de fuses Electron inattendue.");
    for (const [index, name, expected] of expectedFuses) {
      let actual;
      try {
        actual = fuseState(wire.states[index]);
      } catch (error) {
        failures.push(`fil ${wireIndex + 1}/${wires.length} — ${name}: ${error.message}`);
        continue;
      }
      if (actual !== expected) {
        failures.push(
          `fil ${wireIndex + 1}/${wires.length} — ${name}: ${actual ? "activé" : "désactivé"}, attendu ${expected ? "activé" : "désactivé"}`,
        );
      }
    }
  }

  assert.equal(
    failures.length,
    0,
    `Fuses Electron non conformes dans ${applicationPath}:\n- ${failures.join("\n- ")}`,
  );
  console.log(
    `✓ Fuses Electron binaires conformes (${wires.length} architecture${wires.length > 1 ? "s" : ""}) : ${applicationPath}`,
  );
}
