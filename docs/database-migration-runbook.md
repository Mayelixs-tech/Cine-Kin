# Procédure de reprise des migrations MySQL

Cette procédure concerne uniquement une base Ciné-Kin créée avant l'ajout des
migrations Drizzle versionnées. Elle doit d'abord être exécutée sur une copie de
staging restaurée depuis une sauvegarde récente de la production.

## Ce que fait la migration

- elle ajoute les colonnes de réclamation d'appareil à `app_clients` ;
- elle crée le registre immuable `reseller_credit_ledger` et ses index ;
- elle crée une écriture d'ouverture égale au solde courant de chaque
  revendeur ;
- elle laisse volontairement `claimed_at` à `NULL` pour tous les anciens
  appareils.

Un ancien `pin_hash` n'est donc jamais considéré comme une preuve suffisante.
Après déploiement, chaque ancien appareil devra recevoir un nouveau code de
réclamation depuis l'espace administrateur ou revendeur. Les anciennes sessions
appareil seront rejetées jusqu'à cette revérification.

## Préconditions obligatoires

1. Créer une sauvegarde restaurable et noter son identifiant.
2. Restaurer cette sauvegarde dans une base de staging isolée.
3. Vérifier que `DATABASE_URL` cible bien cette copie, jamais la production lors
   du premier essai.
4. Installer exactement les dépendances verrouillées avec `npm ci`.
5. Prévoir une courte fenêtre de maintenance pour l'opération de production.

Les commandes d'adoption n'affichent jamais le mot de passe de la base. Le nom
de la base est demandé une seconde fois avec `--confirm` pour empêcher une
écriture accidentelle sur une autre cible.

## Validation sur staging

### 1. Contrôle en lecture seule

```bash
npm run db:adopt
```

Le résultat attendu est `legacy-untracked`. Examiner attentivement :

- le nombre d'appareils et de revendeurs ;
- les MAC invalides ;
- les collisions où plusieurs écritures représentent la même MAC ;
- toute différence de table, colonne, type, nullabilité ou index.

L'adoption est refusée si le schéma ne correspond pas exactement à la baseline
historique. Ne jamais forcer le passage : analyser d'abord la divergence.

### 2. Enregistrement de la baseline

Remplacer `nom_de_la_base` par le nom exact affiché par le contrôle :

```bash
npm run db:adopt -- --apply --confirm nom_de_la_base
```

Cette commande ne modifie aucune table métier. Elle enregistre uniquement la
baseline `0000_baseline` dans `__drizzle_migrations`, après un second contrôle
du schéma et un verrou transactionnel.

### 3. Application de la migration incrémentale

```bash
npm run db:migrate
```

### 4. Audit après migration

```bash
npm run db:audit
```

L'audit doit terminer par :

```text
✓ Schéma, historique et registre de crédits cohérents.
```

Il vérifie notamment les empreintes des migrations, le schéma complet, la
continuité de chaque solde revendeur et l'absence de double débit d'une même
activation. Les anciennes MAC non canoniques sont signalées mais ne bloquent
pas le déploiement : l'API les recherche encore dans leurs trois formats.

### 5. Tests fonctionnels de staging

- connexion administrateur ;
- consultation des clients et des revendeurs ;
- ajout motivé de crédits et contrôle du registre ;
- activation annuelle et contrôle du débit ;
- activation illimitée ;
- génération d'un code de réclamation ;
- réclamation depuis un appareil avec un nouveau PIN ;
- refus d'un ancien appareil non revérifié ;
- renouvellement d'une licence annuelle encore active.

## Passage en production

1. Activer la fenêtre de maintenance.
2. Créer une nouvelle sauvegarde de production.
3. Exécuter `npm run db:adopt` sans `--apply` et comparer les volumes avec ceux
   validés en staging.
4. Exécuter l'adoption avec `--apply --confirm`, puis `npm run db:migrate`.
5. Exécuter `npm run db:audit` et conserver sa sortie dans le journal de
   déploiement.
6. Déployer le nouveau code.
7. Revérifier les parcours fonctionnels essentiels.
8. Organiser la distribution des codes de réclamation aux anciens appareils.

Une base vide ou déjà suivie par Drizzle est migrée automatiquement pendant le
build Vercel. Une base historique non adoptée ou un schéma divergent fait
échouer le build avant toute migration.

## Migration incrémentale d'une base déjà suivie (ex. `0003_app_client_trial`)

Une fois la baseline adoptée, les migrations suivantes ne repassent plus par
`db:adopt`. Exemple : `0003_app_client_trial` ajoute deux colonnes nullables à
`app_clients` (`trial_started_at`, `trial_ends_at`), sans aucune mise à jour des
lignes existantes : les anciens appareils gardent `NULL` et ne reçoivent pas
d'essai rétroactif.

**Ordre impératif : migrer la base AVANT de déployer le nouveau code.** Le
nouveau code lit `trial_ends_at` ; l'ancien code ignore ces colonnes, donc une
base migrée reste compatible avec la version précédente.

1. Staging : restaurer une sauvegarde récente de la production dans la base de
   staging, puis exécuter `npm run db:deploy` (migration puis audit) avec
   `DATABASE_URL` pointant sur cette copie. L'audit doit se terminer par
   `✓ Schéma, historique et registre de crédits cohérents.`
2. Staging : déployer le code et vérifier les parcours fonctionnels (dont
   l'enregistrement d'un appareil CinéKin Player, l'essai de 7 jours et
   `app.deviceStatus`).
3. Production : créer une nouvelle sauvegarde et noter son identifiant.
4. Production : exécuter `npm run db:deploy` et conserver sa sortie dans le
   journal de déploiement.
5. Production : déployer le nouveau code, puis revérifier les parcours
   essentiels.

En cas de problème après l'étape 4, remettre la version applicative
précédente suffit : les colonnes ajoutées sont ignorées par l'ancien code.

## Retour arrière

Les instructions DDL MySQL peuvent être validées implicitement et ne disposent
pas d'un rollback transactionnel fiable. En cas d'incident grave :

1. interrompre le déploiement ;
2. remettre la version applicative précédente — les nouvelles colonnes et la
   nouvelle table sont additives et sont ignorées par l'ancien code ;
3. si l'intégrité des données est en cause, restaurer la sauvegarde créée juste
   avant l'opération ;
4. ne jamais supprimer manuellement des lignes de `__drizzle_migrations` pour
   tenter de rejouer une migration.
