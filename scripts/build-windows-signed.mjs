import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requiredEnvironment(name, { maximumLength = 4096 } = {}) {
  const value = process.env[name]?.trim();
  if (!value || value.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Variable de signature Azure invalide ou manquante : ${name}`);
  }
  return value;
}

function requiredGuid(name) {
  const value = requiredEnvironment(name, { maximumLength: 36 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`Identifiant Azure invalide : ${name}`);
  }
  return value;
}

function requiredResourceName(name) {
  const value = requiredEnvironment(name, { maximumLength: 64 });
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/iu.test(value)) {
    throw new Error(`Nom de ressource Azure invalide : ${name}`);
  }
  return value;
}

requiredGuid("AZURE_TENANT_ID");
requiredGuid("AZURE_CLIENT_ID");
requiredEnvironment("AZURE_CLIENT_SECRET");
const endpoint = new URL(requiredEnvironment("AZURE_CODE_SIGNING_ENDPOINT", { maximumLength: 256 }));
if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/") {
  throw new Error("Endpoint Artifact Signing invalide");
}

const accountName = requiredResourceName("AZURE_CODE_SIGNING_ACCOUNT_NAME");
const profileName = requiredResourceName("AZURE_CERTIFICATE_PROFILE_NAME");
const publisherName = requiredEnvironment("WIN_PUBLISHER_NAME", { maximumLength: 256 });
const builderCli = path.join(root, "node_modules", "electron-builder", "out", "cli", "cli.js");
const result = spawnSync(
  process.execPath,
  [
    builderCli,
    "--win",
    "--x64",
    "-c.forceCodeSigning=true",
    `-c.win.azureSignOptions.publisherName=${publisherName}`,
    `-c.win.azureSignOptions.endpoint=${endpoint.href}`,
    `-c.win.azureSignOptions.certificateProfileName=${profileName}`,
    `-c.win.azureSignOptions.codeSigningAccountName=${accountName}`,
    ...process.argv.slice(2),
  ],
  { cwd: root, env: process.env, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
