import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import type { Row } from "@libsql/client";
import { env } from "../config/env";
import { isDatabaseConfigured, tursoClient } from "../db/client";

const TEMP_ROOT = path.resolve(process.cwd(), "storage", "database-backups-tmp");

type DumpResult = {
  filePath: string;
  generatedAt: string;
  sha256: string;
  compressedBytes: number;
  tableCount: number;
  rowCount: number;
};

type BackupResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      archiveKey: string;
      latestKey: string;
      tableCount: number;
      rowCount: number;
      compressedBytes: number;
    };

export const isR2BackupConfigured = Boolean(
  env.r2Endpoint &&
    env.r2AccessKeyId &&
    env.r2SecretAccessKey &&
    env.r2Bucket
);

const r2Client = isR2BackupConfigured
  ? new S3Client({
      region: "auto",
      endpoint: env.r2Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.r2AccessKeyId,
        secretAccessKey: env.r2SecretAccessKey
      }
    })
  : null;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function readRowValue(row: Row, column: string, index: number): unknown {
  const namedValue = row[column];
  return namedValue === undefined ? row[index] : namedValue;
}

function quoteSqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (value instanceof ArrayBuffer) return `X'${Buffer.from(value).toString("hex")}'`;
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  throw new Error(`Tipe nilai SQLite tidak didukung: ${typeof value}`);
}

async function writeChunk(stream: ReturnType<typeof createGzip>, chunk: string): Promise<void> {
  if (stream.write(chunk)) return;
  await once(stream, "drain");
}

async function finishStream(stream: ReturnType<typeof createGzip>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("finish", onFinish);
      stream.off("error", onError);
    };
    stream.once("finish", onFinish);
    stream.once("error", onError);
    stream.end();
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function dumpDatabase(): Promise<DumpResult> {
  if (!tursoClient) throw new Error("Turso belum dikonfigurasi");

  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const generatedAt = new Date().toISOString();
  const backupId = generatedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const tempDirectory = await fs.mkdtemp(path.join(TEMP_ROOT, "run-"));
  const filePath = path.join(tempDirectory, `database-${backupId}.sql.gz`);
  const output = createGzip({ level: 6 });
  const fileOutput = createWriteStream(filePath);
  output.pipe(fileOutput);

  let tableCount = 0;
  let rowCount = 0;
  const transaction = await tursoClient.transaction("read");

  try {
    await writeChunk(output, "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n");

    const schemaResult = await transaction.execute(
      `SELECT type, name, sql
       FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
         AND type IN ('table', 'index', 'trigger', 'view')
       ORDER BY CASE type
         WHEN 'table' THEN 1
         WHEN 'view' THEN 2
         WHEN 'index' THEN 3
         WHEN 'trigger' THEN 4
         ELSE 5
       END, name`
    );
    const tableRows = schemaResult.rows.filter((row) => String(readRowValue(row, "type", 0)) === "table");
    tableCount = tableRows.length;

    for (const row of tableRows) {
      const tableName = String(readRowValue(row, "name", 1));
      const columnsResult = await transaction.execute(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
      const columns = columnsResult.rows.map((column, index) =>
        String(readRowValue(column, "name", index))
      );
      if (columns.length === 0) continue;

      await writeChunk(output, `-- Data for ${quoteIdentifier(tableName)}\n`);
      const columnSql = columns.map(quoteIdentifier).join(", ");
      let offset = 0;

      while (true) {
        const dataResult = await transaction.execute({
          sql: `SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY rowid LIMIT ? OFFSET ?`,
          args: [env.backupBatchSize, offset]
        });
        if (dataResult.rows.length === 0) break;

        for (const dataRow of dataResult.rows) {
          const values = columns.map((column, index) => quoteSqlValue(readRowValue(dataRow, column, index)));
          await writeChunk(
            output,
            `INSERT INTO ${quoteIdentifier(tableName)} (${columnSql}) VALUES (${values.join(", ")});\n`
          );
          rowCount += 1;
        }
        offset += dataResult.rows.length;
      }
      await writeChunk(output, "\n");
    }

    await writeChunk(output, "-- Indexes, views, and triggers\n");
    for (const row of schemaResult.rows) {
      const type = String(readRowValue(row, "type", 0));
      if (type === "table") continue;
      const sql = String(readRowValue(row, "sql", 2) ?? "").trim();
      if (sql) await writeChunk(output, `${sql};\n`);
    }

    await writeChunk(output, "\nCOMMIT;\nPRAGMA foreign_keys=ON;\n");
    const fileFinished = once(fileOutput, "finish");
    await finishStream(output);
    await fileFinished;
  } finally {
    transaction.close();
  }

  const stat = await fs.stat(filePath);
  return {
    filePath,
    generatedAt,
    sha256: await sha256File(filePath),
    compressedBytes: stat.size,
    tableCount,
    rowCount
  };
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound" || candidate.$metadata?.httpStatusCode === 404;
}

async function latestBackupIsFresh(): Promise<boolean> {
  if (!r2Client) return false;

  try {
    const result = await r2Client.send(new HeadObjectCommand({
      Bucket: env.r2Bucket,
      Key: env.backupLatestKey
    }));
    if (!result.LastModified) return false;
    return Date.now() - result.LastModified.getTime() < env.backupIntervalHours * 60 * 60 * 1_000;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function uploadBackup(filePath: string, key: string): Promise<void> {
  if (!r2Client) throw new Error("R2 backup belum dikonfigurasi");

  await r2Client.send(new PutObjectCommand({
    Bucket: env.r2Bucket,
    Key: key,
    Body: createReadStream(filePath),
    ContentType: "application/gzip",
    ContentEncoding: "gzip",
    CacheControl: "no-store"
  }));

  const uploaded = await r2Client.send(new HeadObjectCommand({
    Bucket: env.r2Bucket,
    Key: key
  }));
  const localSize = (await fs.stat(filePath)).size;
  if (uploaded.ContentLength !== localSize) {
    throw new Error(`Validasi ukuran backup gagal untuk ${key}`);
  }
}

export async function runDatabaseBackup(options: { force?: boolean } = {}): Promise<BackupResult> {
  if (!env.backupEnabled) return { skipped: true, reason: "backup_disabled" };
  if (!isDatabaseConfigured) return { skipped: true, reason: "database_not_configured" };
  if (!isR2BackupConfigured) return { skipped: true, reason: "r2_not_configured" };
  if (!options.force && await latestBackupIsFresh()) {
    return { skipped: true, reason: "latest_backup_is_fresh" };
  }

  let dump: DumpResult | undefined;
  try {
    dump = await dumpDatabase();
    const timestamp = dump.generatedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
    const archiveKey = `${env.backupArchivePrefix}/${dump.generatedAt.slice(0, 10)}/database-${timestamp}.sql.gz`;
    await uploadBackup(dump.filePath, archiveKey);
    await uploadBackup(dump.filePath, env.backupLatestKey);

    const manifest = JSON.stringify({
      generatedAt: dump.generatedAt,
      archiveKey,
      latestKey: env.backupLatestKey,
      sha256: dump.sha256,
      compressedBytes: dump.compressedBytes,
      tableCount: dump.tableCount,
      rowCount: dump.rowCount,
      format: "sqlite logical SQL dump",
      compression: "gzip"
    }, null, 2);
    const latestSlash = env.backupLatestKey.lastIndexOf("/");
    const latestDirectory = latestSlash > 0
      ? env.backupLatestKey.slice(0, latestSlash)
      : "backups/latest";
    await r2Client!.send(new PutObjectCommand({
      Bucket: env.r2Bucket,
      Key: `${latestDirectory}/manifest.json`,
      Body: manifest,
      ContentType: "application/json",
      CacheControl: "no-store"
    }));

    return {
      skipped: false,
      archiveKey,
      latestKey: env.backupLatestKey,
      tableCount: dump.tableCount,
      rowCount: dump.rowCount,
      compressedBytes: dump.compressedBytes
    };
  } finally {
    if (dump) await fs.rm(path.dirname(dump.filePath), { recursive: true, force: true });
  }
}
