# Signature Windows — activation Azure

## État actuel

La publication Windows est active à partir de la première version postérieure à `v0.10.0`. Tant que la variable GitHub de dépôt `ENABLE_WINDOWS_SIGNING` est absente ou différente de `true`, chaque release contient un installateur NSIS x64 explicitement non signé, sa blockmap et `latest.yml`. Le workflow exige le statut Authenticode `NotSigned`, vérifie les fuses et lance le paquet réel avant publication.

La release `v0.10.0` reste inchangée et limitée à macOS. Une release publique est immuable : ne jamais ajouter ni remplacer un installateur après publication. Les sommes de contrôle couvrent les artefacts macOS et Windows, et l’auto-mise à jour Windows utilise temporairement ce canal non signé.

## Azure Artifact Signing

- abonnement : `Azure Sponsorship Quivr Payant` (`078cfdd1-c540-46d8-909c-84c1fa7a4c6a`) ;
- groupe de ressources : `rg-vibedeck-signing` ;
- compte : `vibedeck-signing-tvc` ;
- région et endpoint : Europe du Nord, `https://neu.codesigning.azure.net/` ;
- offre : Basic ;
- validation d’identité : `adb67cb1-2691-481d-b07f-d5f6ab9198bc`, `Completed` le 17 juillet 2026 ;
- profil public : `vibedeck-public`, provisioning `Succeeded` et statut `Active` ;
- sujet du certificat : `CN=Quivr SAS, O=Quivr SAS, L=Montreuil, C=FR` ;
- application Entra : `VibeDeck GitHub Release`, limitée au rôle `Artifact Signing Certificate Profile Signer` sur le compte de signature ;
- secret client GitHub : stocké dans l’environnement `signed-release`, expiration le 10 juillet 2027.

Ne jamais consigner la valeur du secret client, une clé privée ou un jeton dans ce document ou dans le dépôt.

## État de l’activation

Les étapes suivantes sont terminées :

1. La validation affiche `Completed` dans Azure Portal.
2. Le profil public a été créé avec :

   ```bash
   az account set --subscription 078cfdd1-c540-46d8-909c-84c1fa7a4c6a
   az artifact-signing certificate-profile create \
     --resource-group rg-vibedeck-signing \
     --account-name vibedeck-signing-tvc \
     --name vibedeck-public \
     --profile-type PublicTrust \
     --identity-validation-id adb67cb1-2691-481d-b07f-d5f6ab9198bc
   ```

3. Le profil est actif et son Common Name exact est `Quivr SAS`.
4. Les variables Azure et `WIN_PUBLISHER_NAME=Quivr SAS` sont définies dans l’environnement GitHub `signed-release`.
5. Le smoke test Windows signé du 17 juillet 2026 est vert : application et installateur Authenticode `Valid`, sujet `Quivr SAS`, fuses, lancement du paquet, blockmap et `latest.yml` vérifiés.
6. La variable de dépôt `ENABLE_WINDOWS_SIGNING=true` sélectionne désormais la branche Azure ; l’ancien interrupteur `ENABLE_WINDOWS_RELEASE` a été supprimé.

## Première release signée

1. Laisser la release en brouillon jusqu’à la fin des jobs macOS et Windows signés.
2. Vérifier l’installation, puis la mise à jour vers une version supérieure et la conservation exacte des données locales.
3. Vérifier que la release contient exactement un EXE, sa blockmap et `latest.yml`, en plus des artefacts macOS, et que les sommes SHA-256 sont valides.

Le mode manuel `pilot-build` avec `windows_signing_smoke=true` reste disponible pour revalider Azure sans créer ni modifier de release.

Si la validation Azure passe à `Action Required`, répondre avec les documents demandés. Si elle reste bloquée au-delà de 20 jours ouvrés, ouvrir un ticket Azure Support avec l’identifiant de validation. Ne pas créer plusieurs validations concurrentes pour la même entité.
