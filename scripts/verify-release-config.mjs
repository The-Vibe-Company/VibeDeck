import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findUnsafeWorkflowUses } from "./workflow-uses.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const build = packageJson.build ?? {};
const packagedFiles = build.files ?? [];
const buildWorkflow = readFileSync(
  path.join(root, ".github/workflows/pilot-build.yml"),
  "utf8",
);
const releaseWorkflow = readFileSync(
  path.join(root, ".github/workflows/pilot-release.yml"),
  "utf8",
);
const viteConfig = readFileSync(path.join(root, "vite.config.ts"), "utf8");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const afterSignHook = readFileSync(path.join(root, "scripts/after-sign.mjs"), "utf8");
const electronMain = readFileSync(path.join(root, "electron/main.mjs"), "utf8");
const appProtocol = readFileSync(path.join(root, "electron/app-protocol.mjs"), "utf8");

assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, "Version applicative invalide");
assert.equal(
  packageJson.engines?.node,
  ">=22.18.0",
  "Node 22.18 ou plus récent est requis pour exécuter directement les tests TypeScript",
);
assert.equal(build.appId, "com.mediagen.veille", "Identifiant applicatif inattendu");
assert.equal(build.asar, true, "Le code de diffusion doit être emballé dans ASAR");
assert.equal(build.afterSign, "scripts/after-sign.mjs", "Hook de scellement macOS manquant");
assert.match(
  afterSignHook,
  /\/usr\/bin\/xattr["']?,\s*\[["']-cr["']/,
  "Le build pilote macOS doit supprimer les métadonnées File Provider avant le scellement ad-hoc",
);
assert.match(
  afterSignHook,
  /moveBundle\(appPath, stagedAppPath\)/,
  "Le build pilote macOS doit sortir temporairement le bundle des espaces File Provider",
);
assert.match(
  afterSignHook,
  /moveBundle\(stagedAppPath, appPath\)/,
  "Le build pilote macOS doit restaurer le bundle scellé dans le dossier de sortie",
);
assert.match(
  afterSignHook,
  /error\?\.code\s*!==\s*["']EXDEV["']/,
  "Le déplacement du bundle macOS doit prendre en charge les volumes distincts",
);
assert.match(
  afterSignHook,
  /verbatimSymlinks:\s*true/,
  "La copie inter-volume doit préserver les liens symboliques relatifs du bundle",
);
assert.match(
  afterSignHook,
  /!shouldPreserveSigningDirectory\(\{ appIsStaged, operationError, stagedAppPath \}\)/,
  "Une copie de secours complète ne doit jamais être supprimée avec le dossier de staging",
);
assert.match(
  afterSignHook,
  /Chemins à vérifier[^\n]*\$\{appPath\}[^\n]*\$\{stagedAppPath\}/,
  "Une restauration incomplète doit signaler les chemins de sortie et de staging",
);
assert.match(afterSignHook, /codesign/, "Le build pilote macOS doit être re-signé après les fuses");
assert.match(
  afterSignHook,
  /CSC_IDENTITY_AUTO_DISCOVERY/,
  "Le scellement ad-hoc doit rester limité aux builds explicitement non signés",
);
const expectedElectronFuses = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
};
assert.deepEqual(
  build.electronFuses,
  expectedElectronFuses,
  "Les fuses Electron de diffusion doivent rester durcis",
);
assert.match(viteConfig, /sourcemap:\s*false/, "Les source maps ne doivent pas être diffusées");
assert.doesNotMatch(
  indexHtml,
  /(?:http|ws):\/\/127\.0\.0\.1:5173/,
  "La CSP de diffusion ne doit pas autoriser le serveur de développement",
);
assert.match(electronMain, /APP_ENTRY_URL/, "Le renderer packagé doit utiliser le protocole interne");
assert.match(
  electronMain,
  /resolveHost:\s*\(hostname, options\)\s*=>\s*feedNetworkSession\.resolveHost\(hostname, options\)/,
  "Les flux doivent résoudre les destinations dans la même session Chromium que le téléchargement",
);
assert.match(
  electronMain,
  /requireHostResolution:\s*app\.isPackaged/,
  "Le paquet de diffusion doit échouer fermé sans résolution réseau sécurisée",
);
assert.match(
  electronMain,
  /resolveProxy:\s*\(url\)\s*=>\s*feedNetworkSession\.resolveProxy\(url\)/,
  "Les flux doivent résoudre le proxy dans la même session Chromium que le téléchargement",
);
assert.match(
  electronMain,
  /requireProxyResolution:\s*app\.isPackaged/,
  "Le paquet de diffusion doit échouer fermé sans vérification du proxy",
);
assert.doesNotMatch(
  electronMain,
  /\.loadFile\s*\(/,
  "Le renderer packagé ne doit plus être servi avec file://",
);
assert.match(
  appProtocol,
  /path\.relative\(root, candidate\)/,
  "Le protocole interne doit borner chaque ressource à dist/",
);
assert.ok(
  packagedFiles.includes("!electron/**/*.test.mjs"),
  "Les tests Electron ne doivent pas être inclus dans l’application",
);
assert.ok(
  packagedFiles.includes("!electron/live-connectors.mjs"),
  "Le diagnostic réseau manuel ne doit pas être inclus dans l’application",
);
assert.ok(
  packagedFiles.includes("!**/*.map"),
  "Les source maps de l’application et de ses dépendances ne doivent pas être incluses",
);
assert.equal(build.mac?.hardenedRuntime, true, "Le hardened runtime macOS doit être activé");
assert.ok(build.mac?.entitlements, "Le fichier d’entitlements macOS est requis");
assert.ok(build.mac?.entitlementsInherit, "Les helpers Electron doivent hériter des entitlements");
assert.ok(existsSync(path.join(root, build.mac.entitlements)), "Entitlements macOS introuvables");
assert.ok(
  existsSync(path.join(root, build.mac.entitlementsInherit)),
  "Entitlements hérités macOS introuvables",
);
assert.ok(build.mac?.icon, "L’icône macOS est requise");
assert.ok(existsSync(path.join(root, build.mac.icon)), "Icône macOS introuvable");
assert.ok(build.mac?.target?.includes("dmg"), "Un DMG macOS doit être produit");
assert.ok(build.win?.icon, "L’icône Windows est requise");
assert.ok(existsSync(path.join(root, build.win.icon)), "Icône Windows introuvable");
assert.ok(build.win?.target?.includes("nsis"), "Un installateur NSIS Windows doit être produit");
assert.equal(
  build.win?.signAndEditExecutable,
  true,
  "La signature des exécutables Windows ne doit pas être désactivée",
);
assert.match(
  packageJson.scripts?.["dist:mac:signed"] ?? "",
  /forceCodeSigning=true/,
  "Le build macOS signé doit échouer si le certificat manque",
);
assert.match(
  packageJson.scripts?.["dist:mac:signed"] ?? "",
  /mac\.notarize=true/,
  "Le build macOS signé doit imposer la notarisation",
);
assert.match(
  packageJson.scripts?.["dist:mac"] ?? "",
  /--universal/,
  "Le build macOS du pilote doit couvrir Apple Silicon et Intel",
);
assert.match(
  packageJson.scripts?.["dist:win:signed"] ?? "",
  /forceCodeSigning=true/,
  "Le build Windows signé doit échouer si le certificat manque",
);
assert.match(
  packageJson.scripts?.["dist:win"] ?? "",
  /--x64/,
  "Le build Windows du pilote doit cibler les postes x64",
);
for (const scriptName of ["dist", "dist:dir", "dist:mac", "dist:win"]) {
  assert.match(
    packageJson.scripts?.[scriptName] ?? "",
    /CSC_IDENTITY_AUTO_DISCOVERY=false/,
    `${scriptName} doit rester explicitement non signé`,
  );
}
assert.ok(
  existsSync(path.join(root, ".github/workflows/pilot-build.yml")),
  "Workflow de build multiplateforme manquant",
);
assert.ok(
  existsSync(path.join(root, ".github/workflows/pilot-release.yml")),
  "Workflow de diffusion signée manquant",
);
assert.match(buildWorkflow, /npm run verify:release/, "Le build CI doit vérifier sa configuration");
assert.match(
  buildWorkflow,
  /npm run test:pilot-ui/,
  "Le build CI doit vérifier les invariants de viewport et de sélection",
);
assert.equal(
  (buildWorkflow.match(/npm run test:packaged/g) ?? []).length,
  2,
  "Chaque paquet CI non signé doit être lancé après sa construction",
);
const unsafeWorkflowUses = [
  ...findUnsafeWorkflowUses(buildWorkflow, "pilot-build.yml"),
  ...findUnsafeWorkflowUses(releaseWorkflow, "pilot-release.yml"),
];
assert.equal(
  unsafeWorkflowUses.length,
  0,
  `Chaque référence uses: doit être distante et épinglée à un SHA complet : ${unsafeWorkflowUses
    .map(({ workflow, path: yamlPath, reference }) => `${workflow}:${yamlPath} (${reference})`)
    .join(", ")}`,
);
assert.match(
  buildWorkflow,
  /CSC_IDENTITY_AUTO_DISCOVERY:\s*"false"/,
  "Le build pilote non signé doit désactiver la découverte de certificat",
);
assert.match(
  releaseWorkflow,
  /APPLE_API_KEY_CONTENT/,
  "Le workflow macOS doit matérialiser la clé API Apple dans un fichier protégé",
);
assert.equal(
  (releaseWorkflow.match(/environment:\s*signed-release/g) ?? []).length,
  2,
  "Chaque job signé doit utiliser l’environnement protégé signed-release",
);
assert.equal(
  (releaseWorkflow.match(/github\.ref == 'refs\/heads\/main'/g) ?? []).length,
  2,
  "Les jobs de signature doivent refuser toute référence autre que main",
);
assert.match(
  releaseWorkflow,
  /codesign --verify --deep --strict/,
  "Le workflow macOS doit vérifier la signature produite",
);
assert.match(
  releaseWorkflow,
  /xcrun stapler validate/,
  "Le workflow macOS doit vérifier le ticket de notarisation",
);
assert.match(
  releaseWorkflow,
  /hdiutil attach[\s\S]*npm run test:packaged -- "\$app_path"/,
  "Le bundle réellement contenu dans le DMG doit être monté puis lancé",
);
assert.match(
  releaseWorkflow,
  /Get-AuthenticodeSignature/,
  "Le workflow Windows doit vérifier la signature Authenticode",
);
assert.equal(
  (releaseWorkflow.match(/npm run test:pilot-ui/g) ?? []).length,
  2,
  "Chaque build signé doit exécuter la preuve UI Electron",
);
assert.equal(
  (releaseWorkflow.match(/npm run test:packaged/g) ?? []).length,
  2,
  "Chaque build signé doit lancer l’application réellement empaquetée",
);

console.log(`✓ Configuration de diffusion MediaGen ${packageJson.version}`);
console.log("✓ Electron : fuses production durcis, cookies chiffrés et ASAR vérifié");
console.log("✓ macOS : hardened runtime, entitlements, signature obligatoire en release");
console.log("✓ Windows : NSIS, signature obligatoire en release");
console.log("ℹ Les certificats et identifiants de notarisation restent des prérequis externes.");
