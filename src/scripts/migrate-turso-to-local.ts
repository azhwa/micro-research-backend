import type { InValue, Row, Transaction, Client } from "@libsql/client";
import { env } from "../config/env";
import {
  initializeLocalDatabase,
  localClient,
  tursoClient
} from "../db/client";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function rowValue(row: Row, column: string, index: number): InValue {
  const namedValue = row[column];
  const value = namedValue === undefined ? row[index] : namedValue;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof ArrayBuffer) {
    return value;
  }
  throw new Error(`Tipe nilai SQLite tidak didukung pada migrasi: ${typeof value}`);
}

type SqlExecutor = Pick<Client, "execute">;

async function getTableNames(client: SqlExecutor): Promise<string[]> {
  const result = await client.execute(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name <> '__drizzle_migrations'
     ORDER BY name`
  );
  return result.rows.map((row) => String(row.name ?? row[0]));
}

async function assertLocalDatabaseIsEmpty(tableNames: string[]): Promise<void> {
  for (const tableName of tableNames) {
    const result = await localClient.execute({
      sql: `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`,
      args: []
    });
    const count = Number(result.rows[0]?.count ?? result.rows[0]?.[0] ?? 0);
    if (count > 0) {
      throw new Error(
        `Database lokal tidak kosong: ${tableName} memiliki ${count} baris. Hentikan migrasi untuk mencegah duplikasi.`
      );
    }
  }
}

async function copyTable(
  source: SqlExecutor,
  target: Transaction,
  tableName: string
): Promise<number> {
  const columnsResult = await source.execute(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
  const columns = columnsResult.rows.map((row, index) => String(row.name ?? row[index]));
  if (columns.length === 0) return 0;

  const columnSql = columns.map(quoteIdentifier).join(", ");
  let offset = 0;
  let copied = 0;

  while (true) {
    const result = await source.execute({
      sql: `SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY rowid LIMIT ? OFFSET ?`,
      args: [env.backupBatchSize, offset]
    });
    if (result.rows.length === 0) break;

    await target.batch(result.rows.map((row) => ({
      sql: `INSERT INTO ${quoteIdentifier(tableName)} (${columnSql}) VALUES (${columns.map(() => "?").join(", ")})`,
      args: columns.map((column, index) => rowValue(row, column, index))
    })));

    copied += result.rows.length;
    offset += result.rows.length;
    console.info(`${tableName}: ${copied} baris`);
  }

  return copied;
}

async function main(): Promise<void> {
  if (!tursoClient) throw new Error("Turso harus dikonfigurasi untuk migrasi ini");

  await initializeLocalDatabase();
  const tableNames = await getTableNames(tursoClient);
  await assertLocalDatabaseIsEmpty(tableNames);

  await localClient.execute("PRAGMA foreign_keys=OFF");
  const source = await tursoClient.transaction("read");
  const target = await localClient.transaction("write");
  let totalRows = 0;

  try {
    for (const tableName of tableNames) {
      totalRows += await copyTable(source, target, tableName);
    }
    await target.commit();
  } catch (error) {
    await target.rollback();
    throw error;
  } finally {
    source.close();
    target.close();
    await localClient.execute("PRAGMA foreign_keys=ON");
  }

  const integrity = await localClient.execute("PRAGMA integrity_check");
  const integrityStatus = String(integrity.rows[0]?.integrity_check ?? integrity.rows[0]?.[0] ?? "");
  if (integrityStatus !== "ok") throw new Error(`SQLite integrity_check gagal: ${integrityStatus}`);

  console.info(JSON.stringify({
    status: "ok",
    source: "turso",
    target: env.localDatabasePath,
    tableCount: tableNames.length,
    rowCount: totalRows,
    integrityCheck: integrityStatus
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
