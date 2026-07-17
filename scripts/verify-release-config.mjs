import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findUnsafeWorkflowUses } from "./workflow-uses.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
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
const releaseValidationJob = releaseWorkflow.match(
  /\n  validate:[\s\S]*?(?=\n  macos:)/,
)?.[0] ?? "";
const releaseWindowsUnsignedJob = releaseWorkflow.match(
  /\n  windows_unsigned:[\s\S]*?(?=\n  windows_signed:)/,
)?.[0] ?? "";
const releaseWindowsSignedJob = releaseWorkflow.match(
  /\n  windows_signed:[\s\S]*?(?=\n  publish:)/,
)?.[0] ?? "";
const releasePublishJob = releaseWorkflow.match(
  /\n  publish:[\s\S]*$/,
)?.[0] ?? "";
const buildWindowsSigningSmokeJob = buildWorkflow.match(
  /\n  windows_signing_smoke:[\s\S]*?(?=\n  required:)/,
)?.[0] ?? "";
const releasePleaseWorkflow = readFileSync(
  path.join(root, ".github/workflows/release-please.yml"),
  "utf8",
);
const releasePleaseConfig = JSON.parse(
  readFileSync(path.join(root, "release-please-config.json"), "utf8"),
);
const releasePleaseManifest = JSON.parse(
  readFileSync(path.join(root, ".release-please-manifest.json"), "utf8"),
);
const license = readFileSync(path.join(root, "LICENSE"), "utf8");
const viteConfig = readFileSync(path.join(root, "vite.config.ts"), "utf8");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const siteLandingHtml = readFileSync(path.join(root, "site/index.html"), "utf8");
const siteDownloadScript = readFileSync(path.join(root, "site/downloads.js"), "utf8");
const afterSignHook = readFileSync(path.join(root, "scripts/after-sign.mjs"), "utf8");
const windowsSigningScript = readFileSync(
  path.join(root, "scripts/build-windows-signed.mjs"),
  "utf8",
);
const electronMain = readFileSync(path.join(root, "electron/main.mjs"), "utf8");
const appProtocol = readFileSync(path.join(root, "electron/app-protocol.mjs"), "utf8");

assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, "Version applicative invalide");
assert.equal(packageJson.license, "MIT", "La distribution doit rester sous licence MIT");
assert.equal(packageLock.version, packageJson.version, "package-lock.json doit suivre la version applicative");
assert.equal(
  packageLock.packages?.[""]?.version,
  packageJson.version,
  "Le paquet racine du lockfile doit suivre la version applicative",
);
assert.equal(packageLock.packages?.[""]?.license, "MIT", "Le lockfile doit conserver la licence MIT");
assert.match(license, /^MIT License/m, "Texte de licence MIT manquant");
assert.match(license, /Copyright \(c\) 2026 The Vibe Company/, "Titulaire MIT inattendu");
assert.equal(
  packageJson.dependencies?.["electron-updater"],
  "6.8.9",
  "electron-updater doit rester une dépendance runtime épinglée",
);
assert.equal(
  packageJson.repository?.url,
  "https://github.com/The-Vibe-Company/VibeDeck.git",
  "Dépôt public de référence inattendu",
);
assert.equal(
  packageJson.engines?.node,
  ">=22.18.0",
  "Node 22.18 ou plus récent est requis pour exécuter directement les tests TypeScript",
);
assert.equal(build.appId, "com.thevibecompany.vibedeck", "Identifiant applicatif inattendu");
assert.equal(build.productName, "VibeDeck", "Nom public de l’application inattendu");
assert.equal(build.asar, true, "Le code de diffusion doit être emballé dans ASAR");
assert.equal(build.afterSign, "scripts/after-sign.mjs", "Hook de scellement macOS manquant");
assert.equal(
  build.nsis?.artifactName,
  "vibedeck-setup-${version}.${ext}",
  "Le nom NSIS doit rester identique localement et lors de la publication GitHub",
);
assert.equal(
  build.mac?.x64ArchFiles,
  "**/node_modules/{@img,onnxruntime-node}/**",
  "Le paquet macOS universel doit conserver les variantes natives de sharp et ONNX Runtime",
);
for (const dependency of [
  "@img/sharp-darwin-arm64@0.34.5",
  "@img/sharp-darwin-x64@0.34.5",
  "@img/sharp-libvips-darwin-arm64@1.2.4",
  "@img/sharp-libvips-darwin-x64@1.2.4",
]) {
  assert.match(
    packageJson.scripts?.["prepare:mac-universal"] ?? "",
    new RegExp(dependency.replaceAll("/", "\\/")),
    `La préparation macOS doit épingler ${dependency}`,
  );
}
assert.match(
  releaseWorkflow,
  /npm run prepare:mac-universal && npm run build/,
  "La release macOS doit installer les dépendances natives des deux architectures",
);
assert.ok(
  build.extraResources?.includes("LICENSE"),
  "La licence MIT doit être copiée à côté de l’application distribuée",
);
assert.deepEqual(
  build.publish,
  {
    provider: "github",
    owner: "The-Vibe-Company",
    repo: "VibeDeck",
    releaseType: "release",
    tagNamePrefix: "v",
  },
  "Le provider de mise à jour doit rester le dépôt GitHub public en mode release publiée",
);
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
assert.match(
  electronMain,
  /createUpdateController\(\{[\s\S]*isPackaged:\s*app\.isPackaged/,
  "L’updater doit rester possédé par le main process et désactivé hors paquet",
);
assert.match(
  electronMain,
  /prepareForInstall:[\s\S]*await prepareForShutdown\(\)/,
  "L’installation doit attendre la fermeture ordonnée de la persistance",
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
assert.ok(build.mac?.target?.includes("zip"), "Un ZIP macOS est requis pour l’auto-update");
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
  /scripts\/build-windows-signed\.mjs/,
  "Le build Windows signé doit passer par le contrôleur Artifact Signing",
);
assert.match(
  windowsSigningScript,
  /-c\.forceCodeSigning=true/,
  "Le build Windows signé doit échouer si la signature manque",
);
for (const property of [
  "publisherName",
  "endpoint",
  "certificateProfileName",
  "codeSigningAccountName",
]) {
  assert.match(
    windowsSigningScript,
    new RegExp(`-c\\.win\\.azureSignOptions\\.${property}=`),
    `Option Azure Artifact Signing manquante : ${property}`,
  );
}
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
  assert.match(
    packageJson.scripts?.[scriptName] ?? "",
    /--publish never/,
    `${scriptName} ne doit jamais publier les artefacts du pilote`,
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
assert.ok(
  existsSync(path.join(root, ".github/workflows/release-please.yml")),
  "Workflow Release Please manquant",
);
assert.equal(releasePleaseManifest["."], packageJson.version, "Manifest Release Please désynchronisé");
assert.equal(
  releasePleaseConfig.draft,
  true,
  "Release Please doit garder la release non publique jusqu’à la validation signée",
);
assert.equal(
  releasePleaseConfig["force-tag-creation"],
  true,
  "Le tag doit être créé pour déclencher les builds signés",
);
assert.equal(
  releasePleaseConfig["bootstrap-sha"],
  "dfe6a9127d58fef501faf9a56927c10219040e2d",
  "Baseline Release Please inattendue",
);
assert.equal(
  releasePleaseConfig.packages?.["."]?.["release-type"],
  "node",
  "Release Please doit synchroniser package.json et package-lock.json",
);
assert.match(
  releasePleaseWorkflow,
  /googleapis\/release-please-action@5c625bfb5d1ff62eadeeb3772007f7f66fdcf071/,
  "Release Please v4.4.1 doit rester épinglé au SHA revu",
);
assert.match(
  releasePleaseWorkflow,
  /token:\s*\$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/,
  "Le jeton d’organisation Release Please doit déclencher les checks des Release PRs",
);
assert.match(
  releasePleaseWorkflow,
  /workflow_run:\s*\n\s*workflows:\s*\[pilot-build\]\s*\n\s*types:\s*\[completed\]\s*\n\s*branches:\s*\[main\]/,
  "Release Please doit attendre la fin du build pilote de main",
);
assert.match(
  releasePleaseWorkflow,
  /github\.event\.workflow_run\.conclusion == 'success'[\s\S]*github\.event\.workflow_run\.event == 'push'/,
  "Release Please doit ignorer les builds rouges et les lancements non issus d’un push",
);
assert.doesNotMatch(
  releasePleaseWorkflow,
  /workflow_dispatch:/,
  "Release Please ne doit pas pouvoir contourner manuellement la CI requise",
);
assert.match(buildWorkflow, /npm run verify:release/, "Le build CI doit vérifier sa configuration");
assert.match(
  buildWorkflow,
  /npm run test:pilot-ui/,
  "Le build CI doit vérifier les invariants de viewport et de sélection",
);
assert.equal(
  (buildWorkflow.match(/npm audit --omit=dev/g) ?? []).length,
  1,
  "La CI doit auditer une fois les dépendances runtime avant la release",
);
assert.equal(
  (buildWorkflow.match(/^\s*- run: npm audit$/gm) ?? []).length,
  1,
  "La CI doit auditer une fois toutes les dépendances avant la release",
);
assert.match(
  buildWorkflow,
  /npm run dist:mac/,
  "La CI macOS doit produire la distribution non signée complète",
);
assert.match(
  buildWorkflow,
  /npm run dist:win/,
  "La CI Windows doit produire l’installateur non signé complet",
);
assert.ok(
  buildWindowsSigningSmokeJob,
  "Le test manuel isolé de signature Windows est introuvable",
);
assert.match(
  buildWindowsSigningSmokeJob,
  /github\.event_name == 'workflow_dispatch'[\s\S]*inputs\.windows_signing_smoke == true/,
  "La signature Windows de test doit rester une action manuelle explicite",
);
assert.match(
  buildWindowsSigningSmokeJob,
  /environment:\s*signed-release[\s\S]*npm run dist:win:signed -- --publish never/,
  "Le test Windows signé doit utiliser l’environnement protégé sans publier",
);
assert.match(
  buildWindowsSigningSmokeJob,
  /Get-AuthenticodeSignature[\s\S]*Status -ne "Valid"[\s\S]*SignerCertificate\.Subject/,
  "Le test Windows signé doit vérifier Authenticode et le sujet du certificat",
);
assert.match(
  buildWindowsSigningSmokeJob,
  /npm run verify:packaged-fuses[\s\S]*npm run test:packaged/,
  "Le test Windows signé doit vérifier les fuses puis lancer le paquet réel",
);
assert.doesNotMatch(
  buildWindowsSigningSmokeJob,
  /gh release|--publish (?:always|onTagOrDraft)/,
  "Le test Windows signé ne doit créer, modifier ou publier aucune release",
);
assert.match(
  buildWorkflow,
  /hdiutil attach[\s\S]*npm run test:packaged -- "\$app_path"/,
  "La CI macOS doit monter puis lancer le bundle réellement contenu dans le DMG",
);
assert.equal(
  (buildWorkflow.match(/npm run test:packaged/g) ?? []).length,
  3,
  "Chaque paquet CI non signé et le smoke signé doivent être lancés après construction",
);
assert.match(
  buildWorkflow,
  /required:\s*\n\s*name:\s*CI required[\s\S]*needs:\s*\[policy, platform\]/,
  "La CI doit exposer un unique check stable dépendant des audits et des deux plateformes",
);
assert.match(
  buildWorkflow,
  /cancel-in-progress:\s*\$\{\{ github\.event_name == 'pull_request' \}\}/,
  "Les anciens runs d’une même PR doivent être annulés",
);
assert.match(
  buildWorkflow,
  /name:\s*Upload pilot UI failure diagnostic[\s\S]*\.context\/pilot-ui-failure\.png/,
  "Un échec UI doit conserver une capture diagnostique",
);
const unsafeWorkflowUses = [
  ...findUnsafeWorkflowUses(buildWorkflow, "pilot-build.yml"),
  ...findUnsafeWorkflowUses(releaseWorkflow, "pilot-release.yml"),
  ...findUnsafeWorkflowUses(releasePleaseWorkflow, "release-please.yml"),
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
assert.match(
  releaseWorkflow,
  /macos:[\s\S]*?environment:\s*signed-release\s*\n\s*permissions:\s*\n\s*contents: read/,
  "Le job macOS ne doit pas garder de permission d’écriture après la désactivation de la publication directe",
);
assert.match(
  releaseWorkflow,
  /windows_signed:[\s\S]*?environment:\s*signed-release\s*\n\s*permissions:\s*\n\s*contents: read/,
  "Le job Windows ne doit pas garder de permission d’écriture après la désactivation de la publication directe",
);
assert.ok(releaseWindowsUnsignedJob, "Le job Windows non signé est introuvable");
assert.ok(releaseWindowsSignedJob, "Le job Windows signé est introuvable");
assert.ok(releasePublishJob, "Le job final de publication est introuvable");
assert.doesNotMatch(
  releaseWindowsUnsignedJob,
  /environment:\s*signed-release|secrets\.|AZURE_|WIN_PUBLISHER_NAME/,
  "Le build Windows non signé ne doit accéder à aucun secret de signature",
);
assert.match(
  releaseWindowsUnsignedJob,
  /if: vars\.ENABLE_WINDOWS_SIGNING != 'true'[\s\S]*run: npm run dist:win/,
  "Windows doit être construit sans signature tant que la signature Azure n’est pas activée",
);
assert.match(
  releaseWindowsSignedJob,
  /if: vars\.ENABLE_WINDOWS_SIGNING == 'true'[\s\S]*npm run dist:win:signed -- --publish never/,
  "La variable Azure doit sélectionner exclusivement le build Windows signé",
);
assert.doesNotMatch(
  releaseWorkflow,
  /GITHUB_RELEASE_TOKEN/,
  "Les jobs plateforme ne doivent plus recevoir de jeton de publication",
);
assert.match(
  releaseWorkflow,
  /tags:\s*\["v\*\.\*\.\*"\]/,
  "Les builds signés doivent être déclenchés par les tags SemVer",
);
assert.match(
  releaseWorkflow,
  /workflow_dispatch:[\s\S]*description: Tag SemVer existant/,
  "Une release publiée doit pouvoir être reprise explicitement",
);
assert.match(
  releaseWorkflow,
  /validate:\s*\n\s*runs-on: ubuntu-latest\s*\n\s*timeout-minutes:\s*10\s*\n\s*permissions:\s*\n(?:\s*#[^\n]*\n)*\s*contents: write/,
  "Le job de validation doit pouvoir inspecter une release non publique",
);
assert.ok(releaseValidationJob, "Le job de validation signé est introuvable");
assert.doesNotMatch(
  releaseValidationJob,
  /gh (?:api\s+-X|release\s+(?:delete|edit|upload))\b/,
  "Le job de validation ne doit jamais modifier une release",
);
assert.match(
  releaseWorkflow,
  /git merge-base --is-ancestor "\$sha" origin\/main/,
  "Le tag signé doit impérativement pointer sur l’historique de main",
);
assert.match(
  releaseWorkflow,
  /test "\$RELEASE_TAG" = "v\$version"/,
  "Le tag doit correspondre à la version du paquet",
);
assert.match(
  releaseWorkflow,
  /select\(\.name == "CI required" and \.app\.id == 15368\)[\s\S]*test "\$ci_conclusion" = success/,
  "La release doit exiger le check CI required émis par GitHub Actions sur le SHA tagué",
);
assert.equal(
  (releaseWorkflow.match(/--publish always/g) ?? []).length,
  0,
  "Les jobs plateforme ne doivent pas publier avant la validation finale",
);
assert.equal(
  (releaseWorkflow.match(/--publish never/g) ?? []).length,
  2,
  "Chaque plateforme doit produire ses artefacts sans publication directe",
);
assert.doesNotMatch(
  releaseWorkflow,
  /make_latest=false/,
  "Le workflow ne doit pas tenter de rétrograder une release déjà publiée",
);
assert.match(
  releaseWorkflow,
  /test "\$release_is_draft" = true/,
  "La release doit rester non publiée pendant les builds signés",
);
assert.match(
  releaseWorkflow,
  /test "\$\(gh release view "\$RELEASE_TAG" --json isDraft --jq \.isDraft\)" = true[\s\S]*gh release upload[\s\S]*gh release edit "\$RELEASE_TAG" --draft=false --latest/,
  "Les artefacts doivent être validés et uploadés avant l’unique publication finale",
);
assert.match(
  releaseWorkflow,
  /gh release edit "\$RELEASE_TAG" --draft=false --latest/,
  "La release doit devenir latest après validation finale",
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
  releaseWindowsUnsignedJob,
  /Get-AuthenticodeSignature[\s\S]*Status -ne "NotSigned"/,
  "Le workflow Windows temporaire doit refuser un statut autre que NotSigned",
);
assert.match(
  releaseWindowsSignedJob,
  /Get-AuthenticodeSignature[\s\S]*Status -ne "Valid"/,
  "Le workflow Windows Azure doit exiger une signature Authenticode valide",
);
assert.match(
  releasePublishJob,
  /needs: \[validate, macos, windows_unsigned, windows_signed\][\s\S]*needs\.windows_unsigned\.result == 'success'[\s\S]*needs\.windows_signed\.result == 'skipped'[\s\S]*needs\.windows_unsigned\.result == 'skipped'[\s\S]*needs\.windows_signed\.result == 'success'/,
  "La release doit exiger exactement un des deux builds Windows",
);
assert.match(
  releasePublishJob,
  /-name '\*\.exe'[\s\S]*= 1[\s\S]*test -f release\/latest\.yml[\s\S]*-name '\*\.blockmap'[\s\S]*= 3/,
  "Chaque release doit contenir exactement l’installateur et les métadonnées Windows attendus",
);
assert.doesNotMatch(
  releaseWorkflow,
  /ENABLE_WINDOWS_RELEASE|WINDOWS_RELEASE_ENABLED/,
  "L’ancien interrupteur de publication Windows ne doit plus permettre une release macOS seule",
);
assert.equal(
  (releaseWorkflow.match(/npm run test:pilot-ui/g) ?? []).length,
  0,
  "La release signée ne doit pas rejouer la preuve UI déjà validée par CI required",
);
assert.equal(
  (releaseWorkflow.match(/npm run test:packaged/g) ?? []).length,
  3,
  "Chaque branche de build plateforme doit lancer l’application réellement empaquetée",
);
assert.equal(
  (releaseWorkflow.match(/npm audit --omit=dev/g) ?? []).length,
  0,
  "La release signée ne doit pas repousser l’audit runtime après la création du tag",
);
assert.equal(
  (releaseWorkflow.match(/^\s*- run: npm audit$/gm) ?? []).length,
  0,
  "La release signée ne doit pas repousser l’audit complet après la création du tag",
);
assert.equal(
  (releaseWorkflow.match(/^\s*- run: npm test$/gm) ?? []).length,
  0,
  "La release signée ne doit pas rejouer les tests unitaires déjà validés par CI required",
);
assert.match(releaseWorkflow, /release\/latest-mac\.yml/, "Métadonnées macOS manquantes");
assert.match(releaseWorkflow, /release\/latest\.yml/, "Métadonnées Windows manquantes");
assert.match(
  releaseWorkflow,
  /missing_artifact_paths=\(\)[\s\S]*gh release upload "\$RELEASE_TAG" "\$\{missing_artifact_paths\[@\]\}"/,
  "Le job final doit uploader les artefacts validés manquants, DMG inclus, sans remplacer l’existant",
);
assert.match(
  releaseWorkflow,
  /gh release download "\$RELEASE_TAG" --pattern "\$asset_name" --dir "\$asset_verify_dir"[\s\S]*cmp -s "\$artifact_path" "\$asset_verify_dir\/\$asset_name"/,
  "Le job final doit vérifier le contenu des artefacts distants déjà présents avant de les réutiliser",
);
assert.doesNotMatch(
  releaseWorkflow,
  /gh release upload[^\n]*--clobber/,
  "Le job final ne doit pas remplacer des artefacts déjà publiés",
);
assert.match(releaseWorkflow, /WIN_PUBLISHER_NAME/, "Éditeur Windows de confiance manquant");
for (const credential of ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]) {
  assert.match(
    releaseWorkflow,
    new RegExp(`secrets\\.${credential}`),
    `Secret Artifact Signing manquant : ${credential}`,
  );
}
assert.doesNotMatch(
  releaseWorkflow,
  /WIN_CSC_(?:LINK|KEY_PASSWORD)/,
  "La signature Windows ne doit plus dépendre d’une clé exportée",
);
assert.doesNotMatch(
  siteLandingHtml,
  /Windows arrive bientôt/,
  "Le site ne doit plus annoncer Windows comme indisponible",
);
assert.match(
  siteLandingHtml,
  />Télécharger VibeDeck</,
  "Le CTA principal doit couvrir les deux plateformes",
);
assert.match(
  siteLandingHtml,
  /Disponible pour macOS et Windows\./,
  "Le site doit annoncer les deux plateformes prises en charge",
);
assert.equal(
  (siteLandingHtml.match(/data-download-platform="macos"/g) ?? []).length,
  1,
  "Le site doit proposer exactement un bouton macOS",
);
assert.equal(
  (siteLandingHtml.match(/data-download-platform="windows"/g) ?? []).length,
  1,
  "Le site doit proposer exactement un bouton Windows",
);
assert.match(
  siteLandingHtml,
  /<script src="\.\/downloads\.js"><\/script>/,
  "Le site doit charger le résolveur de téléchargements directs",
);
assert.doesNotMatch(
  siteLandingHtml,
  /VibeDeck\/releases\/latest/,
  "Les boutons ne doivent jamais ouvrir la page de la dernière release GitHub",
);
assert.match(
  siteDownloadScript,
  /https:\/\/api\.github\.com\/repos\/The-Vibe-Company\/VibeDeck\/releases\/latest/,
  "Le site doit résoudre la dernière release avec l’API GitHub publique",
);

console.log(`✓ Configuration de diffusion VibeDeck ${packageJson.version}`);
console.log("✓ Electron : fuses production durcis, cookies chiffrés et ASAR vérifié");
console.log("✓ macOS : hardened runtime, entitlements, signature obligatoire en release");
console.log("✓ Windows : NSIS obligatoire, signature Azure activable sans changer les artefacts");
console.log("ℹ Les certificats et identifiants de notarisation restent des prérequis externes.");
