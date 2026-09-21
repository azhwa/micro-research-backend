import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  seedDiscoveryCandidates,
  seedDiscoveryJobs
} from "../db/schema";
import { getDatabase } from "../db/client";
import type { AuthContext } from "../auth";
import { getGlobalAiContext } from "./snapshot.service";
import { normalizeKeyword } from "./research-metrics";
import {
  DEFAULT_GEMINI_MODEL,
  generateStructuredWithUserGeminiKey
} from "./gemini.service";

const PROMPT_VERSION = "seed-discovery-v2";
const MAX_TOPIC_LENGTH = 120;
const MAX_CANDIDATES = 50;
const MAX_PREVIOUS_KEYWORDS = 200;
const MAX_MULTIWORD_PERCENT = 10;

const seedDiscoverySchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          source: { type: "string", enum: ["observed", "derived", "ai_expanded"] },
          evidenceKeywords: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          promptAngles: { type: "array", items: { type: "string" } }
        },
        required: ["keyword", "source", "evidenceKeywords", "rationale", "confidence", "promptAngles"]
      }
    },
    cautions: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "candidates", "cautions"]
};

type SeedDiscoveryInput = {
  topic?: string;
  category?: string;
  assetType?: string;
  locale?: string;
  count?: number;
  model?: string;
  forceNew?: boolean;
};

type AiCandidate = {
  keyword?: unknown;
  source?: unknown;
  evidenceKeywords?: unknown;
  rationale?: unknown;
  confidence?: unknown;
  promptAngles?: unknown;
};

function boundedText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function boundedCount(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_CANDIDATES)
    : fallback;
}

export function keywordTermCount(value: string) {
  return normalizeKeyword(value).split(" ").filter(Boolean).length;
}

export function maxMultiwordCandidates(count: number) {
  return Math.floor((count * MAX_MULTIWORD_PERCENT) / 100);
}

function publicJob(row: typeof seedDiscoveryJobs.$inferSelect, candidates: Array<typeof seedDiscoveryCandidates.$inferSelect> = []) {
  return {
    id: row.id,
    topic: row.topic,
    category: row.category,
    assetType: row.assetType,
    locale: row.locale,
    requestedCount: row.requestedCount,
    model: row.model,
    promptVersion: row.promptVersion,
    status: row.status,
    progressTotal: row.progressTotal,
    progressCompleted: row.progressCompleted,
    summary: row.summary,
    cautions: JSON.parse(row.cautionsJson) as string[],
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      keyword: candidate.keyword,
      source: candidate.source,
      opportunityScore: candidate.opportunityScore,
      confidence: candidate.confidence,
      evidenceKeywords: JSON.parse(candidate.evidenceJson) as string[],
      rationale: candidate.rationale,
      promptAngles: JSON.parse(candidate.promptAnglesJson) as string[],
      rank: candidate.rank,
      createdAt: candidate.createdAt
    }))
  };
}

function jobAuth(row: typeof seedDiscoveryJobs.$inferSelect): AuthContext {
  return {
    userId: row.ownerUserId,
    sessionId: null,
    organizationId: row.organizationId,
    organizationRole: "org:admin",
    isAdmin: true,
    isDevBypass: false
  };
}

function compactContext(
  context: Awaited<ReturnType<typeof getGlobalAiContext>>,
  input: Required<Pick<SeedDiscoveryInput, "topic" | "category" | "assetType" | "locale">> & { excludedKeywords?: string[] }
) {
  const normalizedTopic = normalizeKeyword(input.topic);
  const excludedKeywords = [...new Set((input.excludedKeywords ?? []).map(normalizeKeyword).filter(Boolean))].slice(0, MAX_PREVIOUS_KEYWORDS);
  const excluded = new Set(excludedKeywords);
  const keywordRows = context.topKeywords
    .filter((item) => !excluded.has(normalizeKeyword(item.normalizedKeyword)))
    .filter((item) => !normalizedTopic || item.normalizedKeyword.includes(normalizedTopic) || normalizedTopic.includes(item.normalizedKeyword))
    .slice(0, 40);
  const fallbackKeywords = keywordRows.length
    ? keywordRows
    : context.topKeywords.filter((item) => !excluded.has(normalizeKeyword(item.normalizedKeyword))).slice(0, 40);
  return {
    schemaVersion: "seed-discovery-context-2",
    topic: input.topic,
    filters: { category: input.category, assetType: input.assetType, locale: input.locale },
    totals: context.totals,
    excludedKeywords,
    seedPolicy: {
      preferredSingleWordPercent: 90,
      maxTwoWordPercent: MAX_MULTIWORD_PERCENT,
      maxWordsPerCandidate: 2
    },
    observedKeywords: fallbackKeywords.map((item) => ({
      keyword: item.keyword,
      normalizedKeyword: item.normalizedKeyword,
      opportunityScore: item.globalOpportunityScore,
      level: item.level,
      trend: item.trend,
      researchCount: item.researchCount,
      assetCount: item.assetCount,
      averageResultCount: item.averageResultCount,
      sources: item.sources
    })),
    supportingAssets: context.topAssets.slice(0, 20).map((item) => ({
      title: item.title.slice(0, 160),
      assetType: item.assetType,
      researchCount: item.researchCount,
      bestAssetScore: item.bestAssetScore,
      seenForKeywords: item.seenForKeywords.slice(0, 8)
    }))
  };
}

function seedPrompt(context: ReturnType<typeof compactContext>, count: number) {
  const maxMultiword = maxMultiwordCandidates(count);
  return [
    "Anda adalah perencana keyword microstock.",
    "Cari kandidat seed keyword yang layak diteliti untuk membuat konsep gambar stock.",
    `Kembalikan maksimal ${count} kandidat dan urutkan dari yang paling berpeluang.`,
    `Utamakan single keyword satu kata: minimal ${Math.max(0, count - maxMultiword)} kandidat harus satu kata.`,
    `Boleh membuat maksimal ${maxMultiword} kandidat dua kata (sekitar 10% dari jumlah kandidat); jangan membuat keyword lebih dari dua kata.`,
    "Jangan mengulang keyword yang ada di excludedKeywords; batch ini harus menghasilkan arah yang berbeda dari discovery sebelumnya.",
    "Gunakan keyword observed sebagai bukti utama. Gunakan derived jika merupakan gabungan atau long-tail yang jelas dari bukti observed.",
    "Gunakan ai_expanded hanya jika kandidat tidak ada langsung di data, dan jangan menyamarkannya sebagai data Adobe.",
    "Jangan mengklaim ada penjualan aktual atau menjamin keyword pasti laku.",
    "Hindari merek, nama artis, karakter berhak cipta, dan keyword yang terlalu generik.",
    "Setiap kandidat harus menyertakan keyword bukti yang ada di konteks jika source bukan ai_expanded.",
    "Kembalikan hanya JSON sesuai schema, tanpa markdown.",
    "KONTEKS DATA:",
    JSON.stringify(context)
  ].join("\n");
}

function stringArray(value: unknown, maxItems: number, maxLength: number) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems)
    : [];
}

function numberAverage(values: number[]) {
  return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;
}

async function loadCandidates(jobId: string) {
  return getDatabase().select().from(seedDiscoveryCandidates)
    .where(eq(seedDiscoveryCandidates.jobId, jobId))
    .orderBy(asc(seedDiscoveryCandidates.rank), asc(seedDiscoveryCandidates.createdAt));
}

async function loadPreviousKeywords(
  ownerUserId: string,
  input: { topic: string; category: string; assetType: string; locale: string }
) {
  const database = getDatabase();
  const jobs = await database.select({ id: seedDiscoveryJobs.id })
    .from(seedDiscoveryJobs)
    .where(and(
      eq(seedDiscoveryJobs.ownerUserId, ownerUserId),
      eq(seedDiscoveryJobs.topic, input.topic),
      eq(seedDiscoveryJobs.category, input.category),
      eq(seedDiscoveryJobs.assetType, input.assetType),
      eq(seedDiscoveryJobs.locale, input.locale)
    ))
    .orderBy(desc(seedDiscoveryJobs.createdAt))
    .limit(20);
  if (!jobs.length) return [];
  const candidates = await database.select({ normalizedKeyword: seedDiscoveryCandidates.normalizedKeyword })
    .from(seedDiscoveryCandidates)
    .where(inArray(seedDiscoveryCandidates.jobId, jobs.map((job) => job.id)));
  return [...new Set(candidates.map((candidate) => normalizeKeyword(candidate.normalizedKeyword)).filter(Boolean))]
    .slice(0, MAX_PREVIOUS_KEYWORDS);
}

export async function createSeedDiscoveryJob(ownerUserId: string, auth: AuthContext, input: SeedDiscoveryInput) {
  const topic = boundedText(input.topic, MAX_TOPIC_LENGTH);
  const category = boundedText(input.category, 40) || "general";
  const assetType = input.assetType === "videos" ? "videos" : "images";
  const locale = boundedText(input.locale, 20) || "en-GB";
  const count = boundedCount(input.count, 10);
  const model = boundedText(input.model, 120) || DEFAULT_GEMINI_MODEL;
  const forceNew = input.forceNew === true;
  const context = await getGlobalAiContext({ assetType, locale, category }, auth);
  if (!context.topKeywords.length && !context.topAssets.length) return null;

  const excludedKeywords = await loadPreviousKeywords(ownerUserId, { topic, category, assetType, locale });
  const compact = compactContext(context, { topic, category, assetType, locale, excludedKeywords });
  const inputHash = createHash("sha256")
    .update(JSON.stringify({
      ownerUserId,
      organizationId: auth.organizationId,
      promptVersion: PROMPT_VERSION,
      model,
      count,
      compact,
      variation: forceNew ? randomUUID() : null
    }))
    .digest("hex");
  const database = getDatabase();
  const existing = await database.select().from(seedDiscoveryJobs)
    .where(and(eq(seedDiscoveryJobs.inputHash, inputHash), eq(seedDiscoveryJobs.ownerUserId, ownerUserId)))
    .limit(1);
  if (existing[0]) {
    return publicJob(existing[0], await loadCandidates(existing[0].id));
  }

  const [job] = await database.insert(seedDiscoveryJobs).values({
    id: `seed_${randomUUID()}`,
    ownerUserId,
    organizationId: auth.organizationId,
    topic,
    category,
    assetType,
    locale,
    requestedCount: count,
    model,
    promptVersion: PROMPT_VERSION,
    inputHash,
    contextJson: JSON.stringify(compact),
    status: "pending"
  }).returning();
  return publicJob(job);
}

export async function getSeedDiscoveryJob(id: string, auth: AuthContext) {
  const rows = await getDatabase().select().from(seedDiscoveryJobs)
    .where(and(
      eq(seedDiscoveryJobs.id, id),
      eq(seedDiscoveryJobs.ownerUserId, auth.userId),
      auth.organizationId ? eq(seedDiscoveryJobs.organizationId, auth.organizationId) : undefined
    ))
    .limit(1);
  if (!rows[0]) return null;
  return publicJob(rows[0], await loadCandidates(rows[0].id));
}

export async function listSeedDiscoveryJobs(auth: AuthContext, limit = 20) {
  const rows = await getDatabase().select().from(seedDiscoveryJobs)
    .where(and(
      eq(seedDiscoveryJobs.ownerUserId, auth.userId),
      auth.organizationId ? eq(seedDiscoveryJobs.organizationId, auth.organizationId) : undefined
    ))
    .orderBy(desc(seedDiscoveryJobs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  const candidates = rows.length
    ? await getDatabase().select().from(seedDiscoveryCandidates).where(inArray(seedDiscoveryCandidates.jobId, rows.map((row) => row.id)))
    : [];
  const grouped = new Map<string, Array<typeof seedDiscoveryCandidates.$inferSelect>>();
  for (const candidate of candidates) grouped.set(candidate.jobId, [...(grouped.get(candidate.jobId) ?? []), candidate]);
  return rows.map((row) => publicJob(row, (grouped.get(row.id) ?? []).sort((a, b) => a.rank - b.rank)));
}

export async function cancelSeedDiscoveryJob(id: string, auth: AuthContext) {
  const [row] = await getDatabase().update(seedDiscoveryJobs).set({
    status: "cancelled",
    errorMessage: "Dibatalkan oleh user",
    completedAt: new Date(),
    updatedAt: new Date()
  }).where(and(
    eq(seedDiscoveryJobs.id, id),
    eq(seedDiscoveryJobs.ownerUserId, auth.userId),
    inArray(seedDiscoveryJobs.status, ["pending", "running"])
  )).returning();
  return row ? publicJob(row, await loadCandidates(row.id)) : null;
}

function normalizeAiCandidates(value: unknown, context: ReturnType<typeof compactContext>, count: number) {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { candidates?: unknown }).candidates
    : [];
  const observed = new Map(context.observedKeywords.map((item) => [item.normalizedKeyword, item]));
  const excluded = new Set(context.excludedKeywords);
  const seen = new Set<string>();
  type NormalizedCandidate = {
    keyword: string;
    normalizedKeyword: string;
    source: "observed" | "derived" | "ai_expanded";
    opportunityScore: number | null;
    confidence: "low" | "medium" | "high";
    evidenceKeywords: string[];
    rationale: string;
    promptAngles: string[];
  };
  const singleWordCandidates: NormalizedCandidate[] = [];
  const multiWordCandidates: NormalizedCandidate[] = [];
  const maxMultiword = maxMultiwordCandidates(count);
  for (const item of Array.isArray(raw) ? raw as AiCandidate[] : []) {
    const keyword = boundedText(item.keyword, 120);
    const normalizedKeyword = normalizeKeyword(keyword);
    const termCount = keywordTermCount(normalizedKeyword);
    if (!normalizedKeyword || seen.has(normalizedKeyword) || excluded.has(normalizedKeyword) || termCount > 2) continue;
    const evidenceKeywords = stringArray(item.evidenceKeywords, 5, 120)
      .map(normalizeKeyword)
      .filter((evidence) => observed.has(evidence));
    const aiSource = item.source === "observed" || item.source === "derived" || item.source === "ai_expanded" ? item.source : "ai_expanded";
    const source = observed.has(normalizedKeyword)
      ? "observed"
      : aiSource === "derived" && evidenceKeywords.length
        ? "derived"
        : "ai_expanded";
    const evidenceScores = evidenceKeywords.map((evidence) => observed.get(evidence)?.opportunityScore).filter((score): score is number => typeof score === "number");
    const opportunityScore = observed.get(normalizedKeyword)?.opportunityScore ?? numberAverage(evidenceScores);
    const confidence = item.confidence === "high" || item.confidence === "medium" || item.confidence === "low"
      ? item.confidence
      : source === "observed" ? "high" : source === "derived" ? "medium" : "low";
    const candidate: NormalizedCandidate = {
      keyword,
      normalizedKeyword,
      source,
      opportunityScore,
      confidence: source === "ai_expanded" && confidence === "high" ? "medium" : confidence,
      evidenceKeywords,
      rationale: boundedText(item.rationale, 600),
      promptAngles: stringArray(item.promptAngles, 5, 180)
    };
    seen.add(normalizedKeyword);
    if (termCount === 1) singleWordCandidates.push(candidate);
    else if (multiWordCandidates.length < maxMultiword) multiWordCandidates.push(candidate);
  }
  return [...singleWordCandidates, ...multiWordCandidates].slice(0, count);
}

export async function processSeedDiscoveryJob(jobId: string) {
  const database = getDatabase();
  const [job] = await database.select().from(seedDiscoveryJobs).where(eq(seedDiscoveryJobs.id, jobId)).limit(1);
  if (!job || job.status !== "pending") return;
  await database.update(seedDiscoveryJobs).set({ status: "running", startedAt: new Date(), updatedAt: new Date() }).where(eq(seedDiscoveryJobs.id, jobId));
  try {
    const context = JSON.parse(job.contextJson) as ReturnType<typeof compactContext>;
    const response = await generateStructuredWithUserGeminiKey(
      job.ownerUserId,
      job.model,
      seedPrompt(context, job.requestedCount),
      seedDiscoverySchema,
      3_000
    );
    const [currentJob] = await database.select({ status: seedDiscoveryJobs.status })
      .from(seedDiscoveryJobs)
      .where(eq(seedDiscoveryJobs.id, jobId))
      .limit(1);
    if (currentJob?.status === "cancelled") return;
    const candidates = normalizeAiCandidates(response, context, job.requestedCount);
    if (!candidates.length) throw new Error("AI tidak mengembalikan kandidat seed yang valid");
    const responseObject = response && typeof response === "object" && !Array.isArray(response)
      ? response as { summary?: unknown; cautions?: unknown }
      : {};
    await database.delete(seedDiscoveryCandidates).where(eq(seedDiscoveryCandidates.jobId, jobId));
    await database.insert(seedDiscoveryCandidates).values(candidates.map((candidate, index) => ({
      id: `seed_candidate_${randomUUID()}`,
      jobId,
      keyword: candidate.keyword,
      normalizedKeyword: candidate.normalizedKeyword,
      source: candidate.source,
      opportunityScore: candidate.opportunityScore,
      confidence: candidate.confidence,
      evidenceJson: JSON.stringify(candidate.evidenceKeywords),
      rationale: candidate.rationale,
      promptAnglesJson: JSON.stringify(candidate.promptAngles),
      rank: index + 1
    })));
    await database.update(seedDiscoveryJobs).set({
      status: "completed",
      progressCompleted: 1,
      summary: boundedText(responseObject.summary, 1_000),
      cautionsJson: JSON.stringify(stringArray(responseObject.cautions, 8, 300)),
      errorMessage: null,
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(seedDiscoveryJobs.id, jobId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Seed discovery gagal";
    await database.update(seedDiscoveryJobs).set({
      status: "failed",
      errorMessage: message.slice(0, 1_000),
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(seedDiscoveryJobs.id, jobId));
  }
}

export async function claimPendingSeedDiscoveryJob() {
  const database = getDatabase();
  const [job] = await database.select().from(seedDiscoveryJobs)
    .where(eq(seedDiscoveryJobs.status, "pending"))
    .orderBy(asc(seedDiscoveryJobs.createdAt))
    .limit(1);
  return job ?? null;
}

export { PROMPT_VERSION as SEED_DISCOVERY_PROMPT_VERSION };
