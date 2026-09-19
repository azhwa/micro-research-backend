import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const LOG_DIRECTORY = process.env.RESEARCH_LOG_DIR?.trim()
  || path.resolve(process.cwd(), "storage", "research-logs");
const MAX_LOG_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DETAIL_LINE_BYTES = 256 * 1024;
const FLUSH_DELAY_MS = 250;

export interface ResearchDetailLog {
  id: string;
  researchRunId: string;
  createdAt: string;
  type: string;
  query?: string;
  sortMode?: string;
  count?: number;
  assets?: Array<{
    externalId: string;
    rank: number;
    title: string;
    thumbnail: "valid" | "missing";
    thumbnailUrl?: string;
  }>;
  summary?: Record<string, number | string | boolean | null>;
}

const pendingLines = new Map<string, string[]>();
const flushTimers = new Map<string, NodeJS.Timeout>();
const flushPromises = new Map<string, Promise<void>>();

function safeRunId(researchRunId: string): string {
  return researchRunId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function logPath(researchRunId: string): string {
  return path.join(LOG_DIRECTORY, `${safeRunId(researchRunId)}.jsonl`);
}

function clip(value: string | null | undefined, maxLength: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function scheduleFlush(researchRunId: string): void {
  if (flushTimers.has(researchRunId)) return;
  flushTimers.set(researchRunId, setTimeout(() => {
    flushTimers.delete(researchRunId);
    void flushResearchDetailLog(researchRunId);
  }, FLUSH_DELAY_MS));
}

async function writePendingLines(researchRunId: string, lines: string[]): Promise<void> {
  if (!lines.length) return;
  try {
    await mkdir(LOG_DIRECTORY, { recursive: true });
    const target = logPath(researchRunId);
    const currentSize = await stat(target).then((result) => result.size).catch(() => 0);
    if (currentSize >= MAX_LOG_FILE_BYTES) return;

    const remainingBytes = MAX_LOG_FILE_BYTES - currentSize;
    let payload = "";
    for (const line of lines) {
      if (Buffer.byteLength(payload) + Buffer.byteLength(line) > remainingBytes) break;
      payload += line;
    }
    if (payload) await appendFile(target, payload);
  } catch {
    // Detail logging must never interrupt research.
  }
}

export async function appendResearchDetailLog(
  researchRunId: string,
  entry: Omit<ResearchDetailLog, "id" | "researchRunId" | "createdAt">
): Promise<void> {
  const record: ResearchDetailLog = {
    id: `detail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    researchRunId,
    createdAt: new Date().toISOString(),
    ...entry
  };
  const encoded = JSON.stringify(record);
  const line = `${Buffer.byteLength(encoded) > MAX_DETAIL_LINE_BYTES
    ? JSON.stringify({ ...record, assets: undefined, summary: { ...(record.summary ?? {}), truncated: true } })
    : encoded}\n`;

  const pending = pendingLines.get(researchRunId) ?? [];
  pending.push(line);
  pendingLines.set(researchRunId, pending);
  scheduleFlush(researchRunId);
}

export async function appendResearchAssetBatchLog(
  researchRunId: string,
  query: string,
  sortMode: string,
  assets: Array<{
    externalId: string;
    title: string;
    thumbnailUrl: string | null;
  }>
): Promise<void> {
  await appendResearchDetailLog(researchRunId, {
    type: "assets_observed",
    query: clip(query, 120),
    sortMode,
    count: assets.length,
    assets: assets.map((asset, index) => ({
      externalId: clip(asset.externalId, 80),
      rank: index + 1,
      title: clip(asset.title, 120),
      thumbnail: asset.thumbnailUrl && !/(?:spacer|placeholder|transparent)\.gif/i.test(asset.thumbnailUrl)
        ? "valid"
        : "missing",
      ...(asset.thumbnailUrl ? { thumbnailUrl: clip(asset.thumbnailUrl, 500) } : {})
    }))
  });
}

export async function appendResearchKeywordSummaryLog(
  researchRunId: string,
  query: string,
  sortMode: string,
  summary: Record<string, number | string | boolean | null>
): Promise<void> {
  await appendResearchDetailLog(researchRunId, {
    type: "keyword_summary",
    query: clip(query, 120),
    sortMode,
    summary
  });
}

export async function flushResearchDetailLog(researchRunId: string): Promise<void> {
  const timer = flushTimers.get(researchRunId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(researchRunId);
  }

  const previous = flushPromises.get(researchRunId) ?? Promise.resolve();
  const current = previous.then(async () => {
    const lines = pendingLines.get(researchRunId) ?? [];
    pendingLines.delete(researchRunId);
    await writePendingLines(researchRunId, lines);
  });
  flushPromises.set(researchRunId, current);
  await current.catch(() => undefined);
  if (flushPromises.get(researchRunId) === current) flushPromises.delete(researchRunId);
}

export async function listResearchDetailLogs(
  researchRunId: string,
  limit = 100
): Promise<ResearchDetailLog[]> {
  await flushResearchDetailLog(researchRunId);
  const content = await readFile(logPath(researchRunId), "utf8").catch(() => "");
  const rows = content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ResearchDetailLog;
      } catch {
        return null;
      }
    })
    .filter((row): row is ResearchDetailLog => Boolean(row));
  return rows.slice(-Math.min(Math.max(limit, 1), 500)).reverse();
}

export async function deleteResearchDetailLog(researchRunId: string): Promise<void> {
  await flushResearchDetailLog(researchRunId);
  await rm(logPath(researchRunId), { force: true }).catch(() => undefined);
}

export async function pruneResearchDetailLogs(before: Date): Promise<number> {
  const names = await readdir(LOG_DIRECTORY).catch(() => [] as string[]);
  let deleted = 0;
  for (const name of names.filter((value) => value.endsWith(".jsonl"))) {
    const target = path.join(LOG_DIRECTORY, name);
    const details = await stat(target).catch(() => null);
    if (details && details.mtime < before) {
      await rm(target, { force: true }).then(() => { deleted += 1; }).catch(() => undefined);
    }
  }
  return deleted;
}
