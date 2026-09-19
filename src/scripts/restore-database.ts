import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createClient } from "@libsql/client";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../config/env";

const gunzipAsync = promisify(gunzip);
const DEFAULT_OUTPUT = "storage/restore-test.sqlite";

function parseArguments(): { key: string; output: string; replace: boolean } {
  const args = process.argv.slice(2);
  let key = env.backupLatestKey;
  let output = DEFAULT_OUTPUT;
  let replace = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--key") {
      key = args[++index] ?? "";
    } else if (argument === "--output") {
      output = args[++index] ?? "";
    } else if (argument === "--replace") {
      replace = true;
    } else if (argument === "--help" || argument === "-h") {
      console.info(`
Restore database backup dari Cloudflare R2.

Usage:
  npm run db:restore
  npm run db:restore -- --key backups/archive/2026-09-19/database-....sql.gz
  npm run db:restore -- --output storage/restore-test.sqlite --replace

Options:
  --key <r2-key>       Object R2 yang dipulihkan. Default: BACKUP_LATEST_KEY
  --output <path>      File SQLite tujuan. Default: ${DEFAULT_OUTPUT}
  --replace            Izinkan menimpa file output yang sudah ada
`);
      process.exit(0);
    }
  }

  if (!key || !output) throw new Error("--key dan --output tidak boleh kosong");
  return { key, output, replace };
}

function isR2Configured(): boolean {
  return Boolean(
    env.r2Endpoint &&
      env.r2AccessKeyId &&
      env.r2SecretAccessKey &&
      env.r2Bucket
  );
}

async function downloadSqlDump(key: string): Promise<Buffer> {
  if (!isR2Configured()) throw new Error("Konfigurasi R2 belum lengkap");

  const client = new S3Client({
    region: "auto",
    endpoint: env.r2Endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.r2AccessKeyId,
      secretAccessKey: env.r2SecretAccessKey
    }
  });

  try {
    const result = await client.send(new GetObjectCommand({
      Bucket: env.r2Bucket,
      Key: key
    }));
    if (!result.Body) throw new Error(`Backup R2 kosong: ${key}`);
    const compressed = Buffer.from(await result.Body.transformToByteArray());
    return Buffer.from(await gunzipAsync(compressed));
  } finally {
    client.destroy();
  }
}

async function main(): Promise<void> {
  const options = parseArguments();
  const outputPath = path.resolve(process.cwd(), options.output);
  const primaryPath = path.resolve(process.cwd(), env.localDatabasePath);

  if (outputPath === primaryPath) {
    throw new Error(
      "Restore dibatalkan: output menunjuk ke database utama. Gunakan storage/restore-test.sqlite."
    );
  }

  const outputExists = await fs.stat(outputPath).then(() => true).catch(() => false);
  if (outputExists && !options.replace) {
    throw new Error(
      `File tujuan sudah ada: ${options.output}. Gunakan --replace jika memang ingin menimpanya.`
    );
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (outputExists) await fs.rm(outputPath, { force: true });

  const sql = await downloadSqlDump(options.key);
  const restoreClient = createClient({ url: `file:${outputPath}` });

  try {
    await restoreClient.executeMultiple(sql.toString("utf8"));
    const integrity = await restoreClient.execute("PRAGMA integrity_check");
    const integrityStatus = String(integrity.rows[0]?.integrity_check ?? integrity.rows[0]?.[0] ?? "");
    if (integrityStatus !== "ok") {
      throw new Error(`SQLite integrity_check gagal: ${integrityStatus}`);
    }

    const runs = await restoreClient.execute("SELECT COUNT(*) AS count FROM research_runs");
    const assets = await restoreClient.execute("SELECT COUNT(*) AS count FROM assets");
    const keywords = await restoreClient.execute("SELECT COUNT(*) AS count FROM asset_keywords");

    console.info(JSON.stringify({
      status: "ok",
      source: options.key,
      output: options.output,
      bytes: sql.byteLength,
      integrityCheck: integrityStatus,
      researchRuns: runs.rows[0]?.count ?? runs.rows[0]?.[0] ?? 0,
      assets: assets.rows[0]?.count ?? assets.rows[0]?.[0] ?? 0,
      assetKeywords: keywords.rows[0]?.count ?? keywords.rows[0]?.[0] ?? 0
    }));
  } finally {
    restoreClient.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
