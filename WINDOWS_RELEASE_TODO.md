# Signature Windows — reste à faire

## État actuel

La publication Windows est active à partir de la première version postérieure à `v0.10.0`. Tant que la variable GitHub de dépôt `ENABLE_WINDOWS_SIGNING` est absente ou différente de `true`, chaque release contient un installateur NSIS x64 explicitement non signé, sa blockmap et `latest.yml`. Le workflow exige le statut Authenticode `NotSigned`, vérifie les fuses et lance le paquet réel avant publication.

La release `v0.10.0` reste inchangée et limitée à macOS. Une release publique est immuable : ne jamais ajouter ni remplacer un installateur après publication. Les sommes de contrôle couvrent les artefacts macOS et Windows, et l’auto-mise à jour Windows utilise temporairement ce canal non signé.

## Azure Artifact Signing

- abonnement : `Azure Sponsorship Quivr Payant` (`078cfdd1-c540-46d8-909c-84c1fa7a4c6a`) ;
- groupe de ressources : `rg-vibedeck-signing` ;
- compte : `vibedeck-signing-tvc` ;
- région et endpoint : Europe du Nord, `https://neu.codesigning.azure.net/` ;
- offre : Basic ;
- validation d’identité : `adb67cb1-2691-481d-b07f-d5f6ab9198bc`, actuellement `Pending` ;
- profil prévu : `vibedeck-public` ;
- application Entra : `VibeDeck GitHub Release`, limitée au rôle `Artifact Signing Certificate Profile Signer` sur le compte de signature ;
- secret client GitHub : stocké dans l’environnement `signed-release`, expiration le 10 juillet 2027.

Ne jamais consigner la valeur du secret client, une clé privée ou un jeton dans ce document ou dans le dépôt.

## Après validation de l’identité

1. Vérifier que la validation affiche `Completed` dans Azure Portal.
2. Créer le profil public :

   ```bash
   az account set --subscription 078cfdd1-c540-46d8-909c-84c1fa7a4c6a
   az artifact-signing certificate-profile create \
     --resource-group rg-vibedeck-signing \
     --account-name vibedeck-signing-tvc \
     --name vibedeck-public \
     --profile-type PublicTrust \
     --identity-validation-id adb67cb1-2691-481d-b07f-d5f6ab9198bc
   ```

3. Attendre que le profil soit actif, puis relever son sujet juridique exact.
4. Définir `WIN_PUBLISHER_NAME` dans l’environnement GitHub `signed-release` avec le Common Name exact du certificat.
5. Produire une build Windows signée sur un runner Windows, sans publier de release, puis vérifier :
   - signature Authenticode de l’application et de l’installateur NSIS ;
   - fuses Electron x64 ;
   - lancement du paquet réel et protocole `vibedeck-app://` ;
   - installation, mise à jour vers une version supérieure et conservation exacte des données locales ;
   - `latest.yml`, blockmap et sommes SHA-256.
6. Mettre la variable GitHub de dépôt `ENABLE_WINDOWS_SIGNING` à `true` avant de fusionner la Release PR de la prochaine version.
7. Vérifier que cette release contient exactement un EXE, sa blockmap et `latest.yml`, en plus des artefacts macOS.

Si la validation Azure passe à `Action Required`, répondre avec les documents demandés. Si elle reste bloquée au-delà de 20 jours ouvrés, ouvrir un ticket Azure Support avec l’identifiant de validation. Ne pas créer plusieurs validations concurrentes pour la même entité.
