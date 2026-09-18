export type ResultCountQualifier = "displayed" | "at_least" | "approximate" | "unknown";

export interface ParsedResultCount {
  value: number | null;
  raw: string | null;
  qualifier: ResultCountQualifier;
}

export function normalizeKeyword(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAdobeResultCount(text: string): ParsedResultCount {
  const match = text.match(/\b(about|approximately|approx\.?|over|more than)?\s*([0-9][0-9\s.,\u00a0\u202f]*)(\+)?\s+(?:results?|hasil)\b/i);
  if (!match) return { value: null, raw: null, qualifier: "unknown" };

  const raw = match[0].trim();
  const digits = match[2].replace(/[^0-9]/g, "");
  if (!digits) return { value: null, raw, qualifier: "unknown" };
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return { value: null, raw, qualifier: "unknown" };

  const prefix = match[1]?.toLocaleLowerCase("en-US") ?? "";
  const qualifier: ResultCountQualifier = match[3] || prefix === "over" || prefix === "more than"
    ? "at_least"
    : prefix ? "approximate" : "displayed";

  return {
    value,
    raw,
    qualifier
  };
}

export function lowCompetitionScore(resultCount: number | null, qualifier: ResultCountQualifier = "unknown") {
  if (resultCount === null || resultCount < 0) return null;
  if (resultCount === 0) return 100;
  const base = Math.max(0, Math.min(100, 100 - Math.log10(resultCount) * 14));
  const conservative = qualifier === "at_least" ? Math.max(0, base - 8) : qualifier === "approximate" ? Math.max(0, base - 4) : base;
  return Math.round(conservative * 10) / 10;
}

export function rankSignal(rank: number | null, sampleLimit: number) {
  if (rank === null || rank < 1 || sampleLimit < 1) return null;
  if (sampleLimit === 1) return rank === 1 ? 100 : 0;
  return Math.round(Math.max(0, Math.min(100, 100 - ((rank - 1) / (sampleLimit - 1)) * 100)) * 10) / 10;
}

export function dataAgeStatus(lastObservedAt: Date | null, now = new Date()) {
  if (!lastObservedAt) return { ageDays: null, status: "unknown" as const, refreshRecommended: false };
  const ageDays = Math.max(0, Math.floor((now.getTime() - lastObservedAt.getTime()) / 86_400_000));
  if (ageDays <= 7) return { ageDays, status: "fresh" as const, refreshRecommended: false };
  if (ageDays <= 14) return { ageDays, status: "aging" as const, refreshRecommended: false };
  if (ageDays <= 30) return { ageDays, status: "stale" as const, refreshRecommended: true };
  return { ageDays, status: "refresh_recommended" as const, refreshRecommended: true };
}
