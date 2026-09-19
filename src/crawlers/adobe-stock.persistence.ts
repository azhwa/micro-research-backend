import type { Page } from "playwright";
import { and, eq, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import {
  assetObservations,
  assetKeywords,
  assets,
  searchQueries,
  suggestions
} from "../db/schema";
import { appendResearchEvent, getResearchRun, makeStableId } from "../services/research.service";
import { normalizeKeyword, type ResultCountQualifier } from "../services/research-metrics";
import {
  classifyFailure,
  chunks,
  diagnosticMetadata,
  errorMessage,
  getPageDiagnostics,
  numberOrNull,
  type CollectedAsset,
  type FailureType,
  type PageDiagnostics,
  type SortMode,
  CrawlerStageError
} from "./adobe-stock.core";

export async function persistSuggestions(
  researchRunId: string,
  rows: Array<{ baseKeyword: string; suggestion: string; position: number; prefix?: string | null }>,
  locale: string,
  source: "adobe_autocomplete" | "seed_fallback"
) {
  const database = getDatabase();
  const values = rows.map((row) => ({
    id: makeStableId("suggestion", researchRunId, row.suggestion),
    researchRunId,
    baseKeyword: row.baseKeyword,
    suggestion: row.suggestion,
    position: row.position,
    source,
    isSeed: normalizeKeyword(row.suggestion) === normalizeKeyword(row.baseKeyword),
    autocompletePrefix: row.prefix ?? null,
    locale
  }));

  for (const batch of chunks(values)) {
    await database.insert(suggestions).values(batch).onConflictDoNothing();
  }
}

export async function persistSearch(
  researchRunId: string,
  query: string,
  assetType: string,
  sortMode: SortMode,
  locale: string,
  resultCount: number | null,
  resultCountRaw: string | null,
  resultCountQualifier: ResultCountQualifier,
  requestedLimit: number,
  collectedAssets: CollectedAsset[]
) {
  const database = getDatabase();
  const queryId = makeStableId("query", researchRunId, query, sortMode, "1");

  await database
    .insert(searchQueries)
    .values({
      id: queryId,
      researchRunId,
      query,
      assetType,
      sortMode,
      page: 1,
      resultCount,
      resultCountRaw,
      resultCountQualifier,
      requestedLimit,
      collectedCount: collectedAssets.length,
      collectionStatus: "completed",
      isComplete: false,
      locale
    })
    .onConflictDoUpdate({
      target: [
        searchQueries.researchRunId,
        searchQueries.query,
        searchQueries.sortMode,
        searchQueries.page
      ],
      set: {
        resultCount,
        resultCountRaw,
        resultCountQualifier,
        requestedLimit,
        collectedCount: collectedAssets.length,
        collectionStatus: "completed",
        isComplete: false,
        observedAt: new Date()
      }
    });

  const assetValues = collectedAssets.map((item) => {
    const assetId = makeStableId("asset", "adobe_stock", item.externalId);
    return {
      id: assetId,
      platform: "adobe_stock" as const,
      externalId: item.externalId,
      assetType: assetType === "videos" ? "video" : "image",
      title: item.title,
      assetUrl: item.assetUrl,
      thumbnailUrl: item.thumbnailUrl,
      width: item.width,
      height: item.height,
      fileExtension: item.fileExtension,
      isPremium: item.isPremium
    };
  });

  for (const batch of chunks(assetValues)) {
    await database
      .insert(assets)
      .values(batch)
      .onConflictDoUpdate({
        target: assets.id,
        set: {
          title: sql`excluded.title`,
          assetUrl: sql`excluded.asset_url`,
          thumbnailUrl: sql`excluded.thumbnail_url`,
          width: sql`excluded.width`,
          height: sql`excluded.height`,
          fileExtension: sql`excluded.file_extension`,
          isPremium: sql`excluded.is_premium`,
          updatedAt: new Date()
        }
      });
  }

  const observationValues = collectedAssets.map((item, index) => ({
    id: makeStableId("observation", researchRunId, queryId, item.externalId, sortMode),
    researchRunId,
    assetId: makeStableId("asset", "adobe_stock", item.externalId),
    searchQueryId: queryId,
    sortMode,
    rank: index + 1
  }));

  for (const batch of chunks(observationValues)) {
    await database.insert(assetObservations).values(batch).onConflictDoNothing();
  }

  await database
    .update(searchQueries)
    .set({ isComplete: true, observedAt: new Date() })
    .where(eq(searchQueries.id, queryId));
}

export async function persistFailedSearch(
  researchRunId: string,
  query: string,
  assetType: string,
  sortMode: SortMode,
  locale: string,
  requestedLimit: number
) {
  const database = getDatabase();
  const queryId = makeStableId("query", researchRunId, query, sortMode, "1");
  await database.insert(searchQueries).values({
    id: queryId,
    researchRunId,
    query,
    assetType,
    sortMode,
    page: 1,
    resultCount: null,
    resultCountRaw: null,
    resultCountQualifier: "unknown",
    requestedLimit,
    collectedCount: 0,
    collectionStatus: "failed",
    isComplete: false,
    locale
  }).onConflictDoUpdate({
    target: [searchQueries.researchRunId, searchQueries.query, searchQueries.sortMode, searchQueries.page],
    set: {
      resultCount: null,
      resultCountRaw: null,
      resultCountQualifier: "unknown",
      requestedLimit,
      collectedCount: 0,
      collectionStatus: "failed",
      isComplete: false,
      observedAt: new Date()
    }
  });
}

export async function collectAndPersistAssetKeywords(
  page: Page,
  researchRunId: string,
  item: CollectedAsset,
  navigationTimeout: number,
  selectorTimeout: number
): Promise<"success" | "empty" | "failed"> {
  const database = getDatabase();
  const assetId = makeStableId("asset", "adobe_stock", item.externalId);
  let responseStatus: number | null = null;

  try {
    const response = await page.goto(item.assetUrl, {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeout
    });
    const httpStatus = response?.status() ?? null;
    responseStatus = httpStatus;
    const initialDiagnostics = await getPageDiagnostics(page, httpStatus);
    if (httpStatus === 404 || /\/404(?:$|[?#])/.test(initialDiagnostics.url)) {
      throw new CrawlerStageError(
        `Halaman detail asset tidak ditemukan (HTTP ${httpStatus ?? "unknown"}): ${initialDiagnostics.url}`,
        "asset_not_found"
      );
    }

    const keywordSelectorFound = await page
      .waitForSelector('[data-t="keywords-section"]', { timeout: selectorTimeout })
      .then(() => true)
      .catch(() => false);
    const diagnostics = await getPageDiagnostics(page, httpStatus);

    await page.waitForTimeout(500);

    const keywordRows = await page.evaluate(() =>
      [...document.querySelectorAll(
        '[data-t="keywords-section"] [data-t^="similar-keyword-item-"]'
      )]
        .map((element) => (element.getAttribute("aria-label") || element.textContent || "").trim())
        .filter((keyword) => keyword && !/^\d+$/.test(keyword))
        .map((keyword, index) => ({ keyword, position: index + 1 }))
    );

    const keywordValues = keywordRows.map((row) => {
      const normalizedKeyword = normalizeKeyword(row.keyword);
      return {
        id: makeStableId(
          "asset-keyword",
          researchRunId,
          assetId,
          normalizedKeyword,
          "adobe_similar_keywords"
        ),
        researchRunId,
        assetId,
        keyword: row.keyword,
        normalizedKeyword,
        source: "adobe_similar_keywords",
        position: row.position
      };
    });

    for (const batch of chunks(keywordValues)) {
      await database.insert(assetKeywords).values(batch).onConflictDoNothing();
    }
    if (!keywordRows.length) {
      await appendResearchEvent(
        researchRunId,
        "warning",
        "keyword_detail_empty",
        `Keyword detail kosong untuk asset ${item.externalId}`,
        { assetId, pageUrl: diagnostics.url, pageTitle: diagnostics.title }
      );
    }
    return keywordRows.length ? "success" : "empty";
  } catch (error) {
    const diagnostics = await getPageDiagnostics(page, responseStatus);
    const failureType = classifyFailure(error, diagnostics);
    await appendResearchEvent(
      researchRunId,
      failureType === "asset_not_found" ? "info" : "warning",
      "keyword_detail_failed",
      `Keyword detail gagal untuk asset ${item.externalId} [${failureType}]`,
      { assetId, assetUrl: item.assetUrl, ...diagnosticMetadata(error, diagnostics, failureType) }
    );
    // Detail keyword enrichment is optional per asset. Search metadata remains valid.
    return "failed";
  }
}

export async function withRetry<T>(
  researchRunId: string,
  label: string,
  task: () => Promise<T>,
  maxAttempts = 2,
  diagnostics?: () => Promise<PageDiagnostics>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const pageState = diagnostics ? await diagnostics() : undefined;
      const failureType = classifyFailure(error, pageState);
      const metadata = {
        attempt,
        maxAttempts,
        ...diagnosticMetadata(error, pageState, failureType)
      };
      if (attempt < maxAttempts) {
        await appendResearchEvent(
          researchRunId,
          "warning",
          "query_retry",
          `${label} gagal [${failureType}], mencoba ulang (${attempt}/${maxAttempts - 1})`,
          metadata
        );
        await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt));
      } else {
        await appendResearchEvent(
          researchRunId,
          "error",
          "query_failed",
          `${label} gagal setelah ${maxAttempts} percobaan [${failureType}]`,
          metadata
        );
      }
    }
  }
  const failureType = classifyFailure(lastError);
  throw new CrawlerStageError(
    `${label} gagal [${failureType}]: ${errorMessage(lastError)}`,
    failureType
  );
}

export interface ResearchHooks {
  onQueryProgress?: (completed: number, total: number) => Promise<void>;
}

export interface ExistingSearchAsset extends CollectedAsset {
  query: string;
  sortMode: SortMode;
}

export async function loadResumeState(researchRunId: string) {
  const database = getDatabase();
  const [completedRows, keywordRows, searchAssetRows] = await Promise.all([
    database
      .select({ query: searchQueries.query, sortMode: searchQueries.sortMode })
      .from(searchQueries)
      .where(and(eq(searchQueries.researchRunId, researchRunId), eq(searchQueries.isComplete, true))),
    database
      .select({ externalId: assets.externalId })
      .from(assetKeywords)
      .innerJoin(assets, eq(assets.id, assetKeywords.assetId))
      .where(eq(assetKeywords.researchRunId, researchRunId)),
    database
      .select({
        query: searchQueries.query,
        sortMode: searchQueries.sortMode,
        externalId: assets.externalId,
        title: assets.title,
        assetUrl: assets.assetUrl,
        thumbnailUrl: assets.thumbnailUrl,
        width: assets.width,
        height: assets.height,
        fileExtension: assets.fileExtension,
        isPremium: assets.isPremium
      })
      .from(searchQueries)
      .innerJoin(assetObservations, eq(assetObservations.searchQueryId, searchQueries.id))
      .innerJoin(assets, eq(assets.id, assetObservations.assetId))
      .where(and(eq(searchQueries.researchRunId, researchRunId), eq(searchQueries.isComplete, true)))
  ]);

  const assetsByQueryAndSort = new Map<string, ExistingSearchAsset[]>();
  for (const row of searchAssetRows) {
    const key = `${row.query}\u001f${row.sortMode}`;
    const current = assetsByQueryAndSort.get(key) ?? [];
    current.push({
      query: row.query,
      sortMode: row.sortMode as SortMode,
      externalId: row.externalId,
      title: row.title,
      assetUrl: row.assetUrl,
      thumbnailUrl: row.thumbnailUrl,
      width: row.width,
      height: row.height,
      fileExtension: row.fileExtension,
      isPremium: row.isPremium
    });
    assetsByQueryAndSort.set(key, current);
  }

  return {
    completedKeys: new Set(completedRows.map((row) => `${row.query}\u001f${row.sortMode}`)),
    enrichedAssetIds: new Set(keywordRows.map((row) => row.externalId)),
    assetsByQueryAndSort
  };
}

