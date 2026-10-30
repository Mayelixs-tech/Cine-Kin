# API appareil — contrat pour l'app CinéKin Player

Ce document décrit les trois procédures publiques appelées par l'app Android
CinéKin Player : `app.registerDevice`, `app.deviceStatus` et
`app.devicePlaylists`. L'app de la vague 3 s'y fie : toute évolution doit rester
**additive** (on ajoute des champs, on n'en retire ni n'en renomme).

## Identifiants de l'appareil

| Champ | Format | Origine |
| ----- | ------ | ------- |
| `mac` | 12 chiffres hexadécimaux : `6E:63:F8:C4:03:0A`, `6e-63-f8-c4-03-0a` ou `6E63F8C4030A` | Dérivé par l'app : HMAC de l'ANDROID_ID, premier octet « unicast + localement administré » |
| `pin` | exactement 6 chiffres | Dérivé par l'app de la même façon ; jamais affiché dans une URL |

Le serveur normalise la MAC (`aa:bb:cc:dd:ee:ff`). Les trois écritures
désignent le même appareil.

Seule une MAC **localement administrée** (premier octet tel que
`(b & 0x03) === 0x02`) est considérée comme un appareil CinéKin Player : son
auto-enregistrement est de confiance et ouvre l'essai de 7 jours. Une MAC
matérielle garde l'ancien comportement (fiche non fiable jusqu'à une activation
revendeur/admin avec code à usage unique).

## Transport (tRPC + superjson)

- Méthode : **`POST`** uniquement, les trois procédures sont des mutations.
  Une query tRPC passerait l'entrée dans l'URL (GET), et le PIN finirait dans
  les journaux d'accès.
- URL : `https://<domaine>/api/trpc/<procédure>`, par exemple
  `/api/trpc/app.deviceStatus`.
- En-têtes : `Content-Type: application/json`. Ne pas envoyer d'en-tête
  `Origin` (l'app native n'en envoie pas ; un `Origin` étranger est refusé).
- **Pas de batching** : une seule procédure par requête, sans `?batch=1`
  (sinon `400`).
- Corps : enveloppe **superjson** obligatoire, l'entrée est sous la clé `json`.
  Un corps sans enveloppe est refusé (`400`).
- Réponse réussie : `{"result":{"data":{"json": <données>}}}`.
- Toutes les réponses de ces trois procédures portent
  `Cache-Control: no-store`, erreurs comprises.
- Toutes les dates sont des chaînes ISO 8601 en UTC (`2026-11-08T10:00:00.000Z`).
  `serverTime` est l'heure du serveur : l'app doit s'y fier plutôt qu'à son
  horloge locale pour juger la fin d'un essai.
- **Champs inconnus** : l'app doit ignorer tout champ qu'elle ne connaît pas
  (un motif d'expiration sera ajouté en vague 2B).

## `app.registerDevice` — premier lancement

Requête :

```json
{ "json": { "mac": "6E:63:F8:C4:03:0A", "pin": "135790" } }
```

`claimCode` (optionnel) n'est utile que pour une MAC pré-activée par un
revendeur ou l'administrateur avant tout enregistrement.

Réponse (nouvel appareil CinéKin Player) :

```json
{
  "result": {
    "data": {
      "json": {
        "registered": true,
        "activated": false,
        "alreadyKnown": false,
        "verificationRequired": false,
        "status": "trial",
        "trialEndsAt": "2026-11-08T10:00:00.000Z"
      }
    }
  }
}
```

- L'essai démarre **une seule fois**, à la création de la fiche. Un nouvel
  appel avec la même MAC et le bon PIN est idempotent : `alreadyKnown: true`,
  essai ni relancé ni prolongé.
- `status` et `trialEndsAt` sont des champs ajoutés ; les quatre premiers
  champs existaient déjà.

## `app.deviceStatus` — à chaque lancement

Requête :

```json
{ "json": { "mac": "6E:63:F8:C4:03:0A", "pin": "135790" } }
```

Réponse :

```json
{
  "result": {
    "data": {
      "json": {
        "status": "trial",
        "licenseType": null,
        "expiresAt": null,
        "trialEndsAt": "2026-11-08T10:00:00.000Z",
        "serverTime": "2026-11-01T10:00:05.123Z"
      }
    }
  }
}
```

| `status` | Signification |
| -------- | ------------- |
| `trial` | Essai gratuit en cours, aucune licence |
| `active` | Licence en cours (`12_months` jusqu'à `expiresAt`, ou `unlimited` avec `expiresAt: null`) |
| `expired` | Licence expirée, ou essai terminé sans licence |
| `inactive` | Ni licence ni essai |

Priorité : une licence (active ou expirée) l'emporte toujours sur l'essai.

## `app.devicePlaylists` — playlists de l'appareil

Requête : identique à `app.deviceStatus`.

Réponse si `status` vaut `trial` ou `active` :

```json
{
  "result": {
    "data": {
      "json": {
        "status": "active",
        "serverTime": "2026-11-01T10:00:05.123Z",
        "playlists": [
          {
            "id": 501,
            "name": "Bouquet Xtream",
            "format": "xtream",
            "source": "cinekin",
            "m3uUrl": null,
            "xtreamServerUrl": "https://xtream.example.test:8080",
            "xtreamUsername": "user-42",
            "xtreamPassword": "s3cret-pass"
          },
          {
            "id": 502,
            "name": "Liste M3U",
            "format": "m3u",
            "source": "external",
            "m3uUrl": "https://m3u.example.test/list.m3u",
            "xtreamServerUrl": null,
            "xtreamUsername": null,
            "xtreamPassword": null
          }
        ]
      }
    }
  }
}
```

Réponse si `status` vaut `expired` ou `inactive` : `"playlists": []`, et
**aucune** URL ni aucun identifiant dans la réponse.

C'est la **seule** route qui renvoie le mot de passe Xtream en clair. L'app
ne doit jamais l'écrire dans ses journaux ; elle peut le garder en mémoire, ou
dans un stockage chiffré si elle en a besoin hors ligne.

## Erreurs

Erreur tRPC :

```json
{
  "error": {
    "json": {
      "message": "MAC ou PIN incorrect.",
      "code": -32001,
      "data": { "code": "UNAUTHORIZED", "httpStatus": 401, "path": "app.deviceStatus" }
    }
  }
}
```

Hors production, `data.stack` peut aussi apparaître : ne jamais l'afficher.

| HTTP | `data.code` | Message | Cas | Conduite de l'app |
| ---- | ----------- | ------- | --- | ----------------- |
| 400 | `BAD_REQUEST` | tableau de validation Zod sérialisé | MAC ou PIN mal formé, enveloppe absente | Bug côté app : ne pas afficher le message brut |
| 401 | `UNAUTHORIZED` | `MAC ou PIN incorrect.` | `deviceStatus`/`devicePlaylists` : MAC inconnue, PIN faux **ou** fiche non fiable (même message, volontairement) | Afficher l'écran d'activation |
| 401 | `UNAUTHORIZED` | `PIN incorrect pour cette adresse MAC.` | `registerDevice` : MAC connue, PIN différent | Afficher une erreur ; ne pas réessayer en boucle |
| 401 | `UNAUTHORIZED` | `Code d'activation invalide ou expiré.` | `registerDevice` : MAC pré-activée sans code valide | Demander le code au client |
| 409 | `CONFLICT` | `Enregistrement concurrent détecté. Veuillez réessayer.` | Course rare au premier enregistrement | Réessayer une fois |
| 429 | `TOO_MANY_REQUESTS` | `Trop de tentatives pour cet appareil. Réessayez dans 15 minutes.` | Plus de 5 tentatives de PIN ou de code d'activation en 15 min sur cette MAC (quelle que soit l'IP), voir « Blocage par MAC » | Attendre 15 min, sans réessayer en boucle |
| 429 | `TOO_MANY_REQUESTS` | `Trop de nouveaux appareils enregistrés depuis ce réseau. Réessayez plus tard.` | `registerDevice` : trop de nouvelles MAC depuis cette IP | Réessayer plus tard |

Les limites par IP répondent **avant** tRPC, avec un autre format :
`HTTP 429` et `{"error": "Trop de requêtes. Réessayez dans 15 minutes."}`
(ou le message de la limite générale). L'app doit donc traiter tout `429`
comme « réessayer plus tard », quel que soit le corps.

## Limites (réglables)

| Limite | Valeur | Où |
| ------ | ------ | -- |
| Tentatives de PIN ou de code par MAC | 5 / 15 min → blocage 15 min | `server/lib/device-limits.ts` |
| Nouvelles fiches par IP | 100 / heure | `server/lib/device-limits.ts` |
| Requêtes `app.*` par IP et par procédure | 300 / 15 min | `APP_DEVICE_RATE_LIMIT_PER_IP`, `server/app.ts` |
| Limite générale tRPC par IP | 100 / minute | `server/app.ts` (inchangée) |

## Blocage par MAC : « réserver puis rembourser »

Chaque vérification d'un secret sur une MAC (PIN sur `deviceStatus`,
`devicePlaylists` et `registerDevice` pour une MAC connue ; code d'activation
sur `registerDevice` pour une MAC pré-activée) **réserve d'abord une place**
dans un compteur par MAC, avant tout calcul scrypt. Pour `deviceStatus` et
`devicePlaylists`, la réservation précède aussi la lecture de la fiche ;
`registerDevice` doit lire la fiche d'abord pour savoir s'il s'agit d'une
création (qui ne réserve rien) :

1. si la MAC est verrouillée → `429` ;
2. sinon la tentative prend une place (fenêtre de 15 minutes) ;
3. au-delà de 5 places → la MAC est verrouillée 15 minutes **à partir de ce
   refus** (un verrou déjà posé n'est pas prolongé) et la réponse est `429` ;
4. en cas de **succès**, la tentative **rend sa place** (une seule) ;
   un échec la garde.

Conséquences :

- Que les requêtes arrivent l'une après l'autre ou en parallèle, au plus
  5 tentatives par MAC et par fenêtre de 15 minutes atteignent la vérification
  du secret.
- Avec le compteur MySQL de production, le total est relu juste après
  l'incrément atomique, dans une requête séparée : lors d'une rafale, chaque
  requête peut relire un total gonflé par les autres et être refusée. Mesuré
  en local : 100 requêtes parallèles, 0 acceptée. L'erreur va toujours dans le
  sens prudent (refuser plus, jamais laisser passer plus de 5).
- Un succès n'efface pas les échecs précédents : après 3 PIN faux puis le bon
  PIN, il reste 2 échecs possibles avant le verrou.
- Les MAC inconnues consomment aussi des places (sinon le blocage révélerait
  quelles MAC existent).
- La création d'une nouvelle fiche par `registerDevice` ne réserve rien.
- **Compromis connu** : une requête légitime qui arrive au milieu d'une rafale
  d'attaque sur la même MAC peut être refusée (`429`), et quelqu'un qui connaît
  une MAC peut la verrouiller 15 minutes en envoyant de faux PIN.

L'app ne doit pas appeler `deviceStatus` en boucle : un appel au lancement,
puis à la demande (bouton « Actualiser ») ou à intervalle raisonnable.
