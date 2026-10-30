import { spawnSync } from "node:child_process";
import path from "node:path";
import { auditMigratedDatabase } from "./audit-migrated-db.mjs";
import {
  adoptBaseline,
  databaseTarget,
  loadMigrationDefinitions,
  openDatabase,
  projectRoot,
} from "./lib/migration-database.mjs";

const rawUrl = process.env.DATABASE_URL;
const target = databaseTarget(rawUrl);
if (
  process.env.MIGRATION_TEST_ALLOW_DROP !== "1" ||
  !["localhost", "127.0.0.1"].includes(target.host) ||
  target.database !== "cinekin_migration_test"
) {
  throw new Error(
    "Test destructif refusé : utilisez une base locale nommée cinekin_migration_test et MIGRATION_TEST_ALLOW_DROP=1."
  );
}

const freshDatabase = "cinekin_migration_test_fresh";
const upgradeDatabase = "cinekin_migration_test_upgrade";
const allowedDatabases = new Set([freshDatabase, upgradeDatabase]);

function urlForDatabase(database) {
  if (!allowedDatabases.has(database))
    throw new Error(`Base de test non autorisée : ${database}`);
  const url = new URL(rawUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function recreateDatabase(connection, database) {
  if (!allowedDatabases.has(database))
    throw new Error(`Base de test non autorisée : ${database}`);
  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await connection.query(
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
}

async function removeDatabase(connection, database) {
  if (!allowedDatabases.has(database))
    throw new Error(`Base de test non autorisée : ${database}`);
  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
}

function runMigrations(databaseUrl) {
  const cli = path.join(projectRoot, "node_modules", "drizzle-kit", "bin.cjs");
  const result = spawnSync(process.execPath, [cli, "migrate"], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `drizzle-kit migrate a échoué avec le code ${result.status ?? "inconnu"}.`
    );
  }
}

async function applySql(connection, sql) {
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map(value => value.trim())) {
    if (statement) await connection.query(statement);
  }
}

async function verifyFreshInstall() {
  const databaseUrl = urlForDatabase(freshDatabase);
  runMigrations(databaseUrl);
  const audit = await auditMigratedDatabase(databaseUrl);
  if (
    !audit.ok ||
    audit.migrations !== audit.expectedMigrations ||
    audit.resellers !== 0 ||
    audit.ledgerEntries !== 0
  ) {
    throw new Error(
      `Installation neuve invalide : ${JSON.stringify(audit.errors)}`
    );
  }
  console.log("✓ Chaîne complète validée sur une base MySQL vide.");
}

async function verifyLegacyUpgrade() {
  const databaseUrl = urlForDatabase(upgradeDatabase);
  const definitions = await loadMigrationDefinitions();
  const opened = await openDatabase(databaseUrl);
  try {
    await applySql(opened.connection, definitions.baseline.sql);
    await opened.connection.execute(
      `INSERT INTO resellers (name, username, password_hash, credits)
       VALUES ('Revendeur historique', 'legacy-reseller', 'legacy-hash', 7)`
    );
    await opened.connection.execute(
      `INSERT INTO app_clients (mac, pin_hash, name, license_type, activated_by_type)
       VALUES ('AABBCCDDEEFF', 'legacy-pin-hash', 'Appareil historique', '12_months', 'admin')`
    );
    await adoptBaseline(opened.connection, upgradeDatabase, { apply: true });
  } finally {
    await opened.connection.end();
  }

  runMigrations(databaseUrl);
  const audit = await auditMigratedDatabase(databaseUrl);
  if (
    !audit.ok ||
    audit.migrations !== audit.expectedMigrations ||
    audit.resellers !== 1 ||
    audit.ledgerEntries !== 1
  ) {
    throw new Error(
      `Mise à niveau historique invalide : ${JSON.stringify(audit.errors)}`
    );
  }

  const verification = await openDatabase(databaseUrl);
  try {
    const [clients] = await verification.connection.query(
      `SELECT pin_hash AS pinHash,
              claimed_at AS claimedAt,
              claim_code_hash AS claimCodeHash,
              trial_started_at AS trialStartedAt,
              trial_ends_at AS trialEndsAt
         FROM app_clients`
    );
    const [ledger] = await verification.connection.query(
      `SELECT delta,
              balance_after AS balanceAfter,
              entry_type AS entryType,
              actor_type AS actorType
         FROM reseller_credit_ledger`
    );
    if (
      clients.length !== 1 ||
      clients[0].pinHash !== "legacy-pin-hash" ||
      clients[0].claimedAt !== null ||
      clients[0].claimCodeHash !== null
    ) {
      throw new Error(
        "La politique de revérification des anciens appareils n'est pas respectée."
      );
    }
    // Migration 0003 is additive: existing devices never receive a
    // retroactive free trial.
    if (clients[0].trialStartedAt !== null || clients[0].trialEndsAt !== null) {
      throw new Error(
        "Un ancien appareil a reçu un essai gratuit rétroactif."
      );
    }
    if (
      ledger.length !== 1 ||
      Number(ledger[0].delta) !== 7 ||
      Number(ledger[0].balanceAfter) !== 7 ||
      ledger[0].entryType !== "initial_grant" ||
      ledger[0].actorType !== "system"
    ) {
      throw new Error(
        "L'écriture d'ouverture du revendeur historique est incorrecte."
      );
    }
  } finally {
    await verification.connection.end();
  }
  console.log("✓ Adoption et mise à niveau d'une base historique validées.");
}

const administration = await openDatabase(rawUrl, "mysql");
try {
  await recreateDatabase(administration.connection, freshDatabase);
  await recreateDatabase(administration.connection, upgradeDatabase);
  await verifyFreshInstall();
  await verifyLegacyUpgrade();
} finally {
  await removeDatabase(administration.connection, freshDatabase);
  await removeDatabase(administration.connection, upgradeDatabase);
  await administration.connection.end();
}
