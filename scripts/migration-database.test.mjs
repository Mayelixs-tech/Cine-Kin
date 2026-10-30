import { describe, expect, it } from "vitest";
import { parseAdoptionArguments } from "./adopt-migration-baseline.mjs";
import {
  analyzeMacRows,
  assessTrackedState,
  auditLedger,
  compareSchema,
  loadMigrationDefinitions,
} from "./lib/migration-database.mjs";

function inspectionFromSnapshot(snapshot) {
  const columnRows = [];
  const indexRows = [];
  const tableNames = new Set(Object.keys(snapshot.tables));
  for (const [tableName, table] of Object.entries(snapshot.tables)) {
    for (const column of Object.values(table.columns)) {
      columnRows.push({
        tableName,
        columnName: column.name,
        columnType: column.type === "serial" ? "bigint unsigned" : column.type,
        isNullable: column.notNull ? "NO" : "YES",
        extra: column.autoincrement ? "auto_increment" : "",
      });
    }
    for (const constraint of Object.values(table.compositePrimaryKeys ?? {})) {
      constraint.columns.forEach((columnName, index) => {
        indexRows.push({
          tableName,
          indexName: "PRIMARY",
          nonUnique: 0,
          sequence: index + 1,
          columnName,
        });
      });
    }
    for (const constraint of Object.values(table.uniqueConstraints ?? {})) {
      constraint.columns.forEach((columnName, index) => {
        indexRows.push({
          tableName,
          indexName: constraint.name,
          nonUnique: 0,
          sequence: index + 1,
          columnName,
        });
      });
    }
    for (const expectedIndex of Object.values(table.indexes ?? {})) {
      expectedIndex.columns.forEach((columnName, index) => {
        indexRows.push({
          tableName,
          indexName: expectedIndex.name,
          nonUnique: expectedIndex.isUnique ? 0 : 1,
          sequence: index + 1,
          columnName,
        });
      });
    }
  }
  return { columnRows, indexRows, tableNames };
}

describe("migration history", () => {
  it("contains the baseline, data-hardening, rate-limit and trial migrations", async () => {
    const definitions = await loadMigrationDefinitions();
    const securityDataMigration = definitions.all[1];
    const rateLimitMigration = definitions.all[2];

    expect(definitions.all).toHaveLength(4);
    expect(Object.keys(definitions.baseline.snapshot.tables)).toHaveLength(7);
    expect(Object.keys(securityDataMigration.snapshot.tables)).toHaveLength(8);
    expect(Object.keys(rateLimitMigration.snapshot.tables)).toHaveLength(9);
    expect(Object.keys(definitions.current.snapshot.tables)).toHaveLength(9);
    expect(definitions.baseline.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(securityDataMigration.sql).toContain(
      "Solde historique repris lors de la migration"
    );
    expect(securityDataMigration.sql).toContain("claimed_at");
    expect(rateLimitMigration.sql).toContain("rate_limit_counters");
    // 0003 is purely additive: two nullable columns, no backfill.
    expect(definitions.current.sql).toContain("trial_started_at");
    expect(definitions.current.sql).toContain("trial_ends_at");
    expect(definitions.current.sql).not.toMatch(/UPDATE|NOT NULL|DEFAULT/i);
  });

  it("matches the generated current snapshot exactly", async () => {
    const { current } = await loadMigrationDefinitions();
    const inspection = inspectionFromSnapshot(current.snapshot);
    expect(compareSchema(current.snapshot, inspection)).toEqual({
      errors: [],
      valid: true,
    });
    inspection.columnRows = inspection.columnRows.filter(
      row =>
        !(row.tableName === "app_clients" && row.columnName === "claimed_at")
    );
    expect(compareSchema(current.snapshot, inspection).valid).toBe(false);
  });

  it("rejects edited migration history and tracked schema drift", async () => {
    const definitions = await loadMigrationDefinitions();
    const inspection = inspectionFromSnapshot(definitions.current.snapshot);
    inspection.migrationHistory = definitions.all.map((definition, index) => ({
      id: index + 1,
      hash: definition.hash,
      createdAt: definition.entry.when,
    }));
    expect(assessTrackedState(definitions, inspection).state).toBe("tracked");

    inspection.migrationHistory[1].hash = "tampered";
    expect(assessTrackedState(definitions, inspection).state).toBe(
      "tracked-history-diverged"
    );
    inspection.migrationHistory[1].hash = definitions.all[1].hash;
    inspection.columnRows = inspection.columnRows.filter(
      row =>
        !(row.tableName === "app_clients" && row.columnName === "claimed_at")
    );
    expect(assessTrackedState(definitions, inspection).state).toBe(
      "tracked-schema-drift"
    );
  });
});

describe("baseline adoption guards", () => {
  it("parses dry-run and confirmed apply modes", () => {
    expect(parseAdoptionArguments([])).toEqual({
      apply: false,
      confirm: null,
      json: false,
    });
    expect(
      parseAdoptionArguments(["--apply", "--confirm", "cinekin", "--json"])
    ).toEqual({
      apply: true,
      confirm: "cinekin",
      json: true,
    });
    expect(() => parseAdoptionArguments(["--force"])).toThrow(
      "Option inconnue"
    );
    expect(() => parseAdoptionArguments(["--confirm", "--json"])).toThrow(
      "attend le nom exact"
    );
  });

  it("reports invalid, legacy and colliding MAC representations", () => {
    const result = analyzeMacRows([
      { id: 1, mac: "AA:BB:CC:DD:EE:FF" },
      { id: 2, mac: "aabbccddeeff" },
      { id: 3, mac: "not-a-mac" },
    ]);
    expect(result.legacyFormat).toHaveLength(2);
    expect(result.invalid).toEqual([{ id: 3, mac: "not-a-mac" }]);
    expect(result.collisions).toHaveLength(1);
  });
});

describe("credit ledger audit", () => {
  it("accepts a continuous balance chain", () => {
    expect(
      auditLedger(
        [{ id: 4, credits: 6 }],
        [
          {
            id: 1,
            resellerId: 4,
            delta: 7,
            balanceAfter: 7,
            entryType: "initial_grant",
          },
          {
            id: 2,
            resellerId: 4,
            delta: -1,
            balanceAfter: 6,
            entryType: "activation",
          },
        ]
      )
    ).toEqual({ errors: [], valid: true });
  });

  it("rejects a ledger that diverges from the current balance", () => {
    const result = auditLedger(
      [{ id: 4, credits: 99 }],
      [
        {
          id: 1,
          resellerId: 4,
          delta: 7,
          balanceAfter: 7,
          entryType: "initial_grant",
        },
      ]
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Solde courant divergent pour le revendeur 4."
    );
  });
});
