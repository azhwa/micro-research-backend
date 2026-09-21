import type { Page } from "playwright";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { env } from "../config/env";
import {
  assetObservations,
  assetKeywords,
  assets,
  searchQueries,
  suggestions
} from "../db/schema";
import { appendResearchEvent, getResearchRun, makeStableId } from "../services/research.service";
import { ResearchCancelledError, throwIfResearchCancelled } from "../services/research-cancellation";
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

function extractAdobeKeywordRows(): Array<{ keyword: string; position: number }> {
  const section = document.querySelector('[data-t="keywords-section"]');
  if (!section) return [];

  const rows: Array<{ keyword: string; position: number }> = [];
  const elements = section.querySelectorAll('[data-t^="similar-keyword-item-"]');
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const keyword = (element.getAttribute("aria-label") || element.textContent || "").trim();
    if (keyword && !/^\d+$/.test(keyword)) {
      rows.push({ keyword, position: rows.length + 1 });
    }
  }

  // Search-result detail uses a side panel. Its keyword links do not have
  // the data-t attribute used by the standalone detail page, but Adobe marks
  // them with load_type=tagged in the href.
  if (rows.length > 0) return rows;
  const links = section.querySelectorAll("a[href]");
  const seen = new Set<string>();
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const href = link.getAttribute("href") || "";
    const keyword = (link.textContent || "").trim();
    const key = keyword.toLowerCase();
    if (
      !keyword ||
      !href.includes("load_type=tagged") ||
      /^view all$/i.test(keyword) ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    rows.push({ keyword, position: rows.length + 1 });
  }
  return rows;
}

function hasAdobeKeywordRows(): boolean {
  const section = document.querySelector('[data-t="keywords-section"]');
  if (!section) return false;
  if (section.querySelector('[data-t^="similar-keyword-item-"]')) return true;
  const links = section.querySelectorAll("a[href]");
  for (let index = 0; index < links.length; index += 1) {
    const href = links[index].getAttribute("href") || "";
    const keyword = (links[index].textContent || "").trim();
    if (keyword && href.includes("load_type=tagged")) return true;
  }
  return false;
}

export async function closeAdobeDetailPanel(page: Page, timeout: number): Promise<void> {
  const closeTimeout = Math.min(timeout, 3_000);
  const closeButton = page.locator("button.js-details-close-button").first();
  if (await closeButton.count()) {
    await closeButton.click({ timeout: closeTimeout }).catch(() => undefined);
  }
  await page
    .locator('[data-t="detail-panel-file-id"]')
    .first()
    .waitFor({ state: "hidden", timeout: closeTimeout })
    .catch(() => undefined);
}

async function clickAdobeAssetCard(
  page: Page,
  item: CollectedAsset,
  timeout: number
): Promise<void> {
  const card = page
    .locator(
      `a[href][data-content-id="${item.externalId}"], [data-content-id="${item.externalId}"] a[href]`
    )
    .first();
  await card.waitFor({ state: "attached", timeout });
  await card.scrollIntoViewIfNeeded({ timeout });
  await card.click({ timeout });
}

async function waitForAdobeAssetPanel(
  page: Page,
  externalId: string,
  timeout: number
): Promise<boolean> {
  return page
    .locator(`[data-t="detail-panel-file-id"][data-content-id="${externalId}"]`)
    .first()
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

export type PersistedKeywordRow = {
  keyword: string;
  normalizedKeyword: string;
  source: string;
  position: number;
};

async function persistAssetKeywordRows(
  researchRunId: string,
  assetId: string,
  rows: PersistedKeywordRow[]
): Promise<void> {
  const database = getDatabase();
  const keywordValues = rows.map((row) => ({
    id: makeStableId(
      "asset-keyword",
      researchRunId,
      assetId,
      row.normalizedKeyword,
      row.source
    ),
    researchRunId,
    assetId,
    keyword: row.keyword,
    normalizedKeyword: row.normalizedKeyword,
    source: row.source,
    position: row.position
  }));

  for (const batch of chunks(keywordValues)) {
    await database.insert(assetKeywords).values(batch).onConflictDoNothing();
  }
}

async function readRecentCachedKeywords(
  database: ReturnType<typeof getDatabase>,
  assetIds: string[]
): Promise<Map<string, PersistedKeywordRow[]>> {
  const uniqueAssetIds = [...new Set(assetIds)].filter(Boolean);
  const cachedByAssetId = new Map<string, PersistedKeywordRow[]>();
  if (!uniqueAssetIds.length) return cachedByAssetId;

  const cacheCutoff = new Date(
    Date.now() - env.researchKeywordCacheHours * 60 * 60 * 1_000
  );
  const rows = await database
    .select({
      assetId: assetKeywords.assetId,
      keyword: assetKeywords.keyword,
      normalizedKeyword: assetKeywords.normalizedKeyword,
      source: assetKeywords.source,
      position: assetKeywords.position
    })
    .from(assetKeywords)
    .where(and(
      inArray(assetKeywords.assetId, uniqueAssetIds),
      eq(assetKeywords.source, "adobe_similar_keywords"),
      gte(assetKeywords.observedAt, cacheCutoff)
    ))
    .orderBy(desc(assetKeywords.observedAt), asc(assetKeywords.position));

  const seenByAssetId = new Map<string, Set<string>>();
  for (const row of rows) {
    const cached = cachedByAssetId.get(row.assetId) ?? [];
    const seen = seenByAssetId.get(row.assetId) ?? new Set<string>();
    if (seen.has(row.normalizedKeyword) || cached.length >= 200) continue;
    seen.add(row.normalizedKeyword);
    seenByAssetId.set(row.assetId, seen);
    cached.push({
      keyword: row.keyword,
      normalizedKeyword: row.normalizedKeyword,
      source: row.source,
      position: row.position
    });
    cachedByAssetId.set(row.assetId, cached);
  }

  for (const cached of cachedByAssetId.values()) {
    cached.sort((left, right) => left.position - right.position);
  }
  return cachedByAssetId;
}

export async function loadRecentCachedKeywords(
  assetIds: string[]
): Promise<Map<string, PersistedKeywordRow[]>> {
  try {
    return await readRecentCachedKeywords(getDatabase(), assetIds);
  } catch {
    // Cache is an optimization only. Live extraction remains the fallback.
    return new Map();
  }
}

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
  selectorTimeout: number,
  options: {
    openMode?: "card" | "next";
    keepPanelOpen?: boolean;
    cachedKeywords?: PersistedKeywordRow[];
    initialPanelTimeout?: number;
    onPanelOpenFailure?: () => void;
    onPanelReady?: () => void;
  } = {}
): Promise<"success" | "empty" | "cached" | "failed"> {
  const assetId = makeStableId("asset", "adobe_stock", item.externalId);
  let responseStatus: number | null = null;
  let preservePanel = options.keepPanelOpen === true;

  try {
    const cachedKeywords = options.cachedKeywords
      ?? (await loadRecentCachedKeywords([assetId])).get(assetId)
      ?? [];
    if (cachedKeywords.length > 0) {
      preservePanel = false;
      await closeAdobeDetailPanel(page, selectorTimeout);
      await persistAssetKeywordRows(researchRunId, assetId, cachedKeywords);
      return "cached";
    }

    // Adobe opens the asset detail as an in-page panel when a result card is
    // clicked. Keep the search page alive so its challenge/session and result
    // state are reused for every asset.
    let panelReady = false;
    const initialPanelTimeout = Math.min(
      navigationTimeout,
      options.initialPanelTimeout ?? navigationTimeout
    );

    const openCardPanel = async (timeout: number): Promise<boolean> => {
      try {
        await closeAdobeDetailPanel(page, selectorTimeout);
        await clickAdobeAssetCard(page, item, timeout);
        return await waitForAdobeAssetPanel(page, item.externalId, timeout);
      } catch {
        return false;
      }
    };

    if (options.openMode === "next") {
      const nextButton = page.locator("button.js-details-next-button").first();
      if (await nextButton.count()) {
        await nextButton.click({ timeout: initialPanelTimeout }).catch(() => undefined);
        panelReady = await waitForAdobeAssetPanel(page, item.externalId, initialPanelTimeout);
      }
    } else {
      panelReady = await openCardPanel(initialPanelTimeout);
    }

    // The result list can be re-rendered while the detail panel is changing.
    // If the blocked attempt cannot open the exact asset panel, switch to the
    // normal resource policy and retry once before reporting a failure.
    if (!panelReady) {
      options.onPanelOpenFailure?.();
      await appendResearchEvent(
        researchRunId,
        "warning",
        "keyword_detail_panel_retry",
        `Panel detail asset ${item.externalId} diulang dengan resource normal`,
        { assetId, initialPanelTimeout }
      );
      panelReady = await openCardPanel(navigationTimeout);
    }

    if (!panelReady) {
      const diagnostics = await getPageDiagnostics(page, responseStatus);
      if (/\/404(?:$|[?#])/.test(diagnostics.url)) {
        throw new CrawlerStageError(
          `Panel detail asset tidak ditemukan: ${diagnostics.url}`,
          "asset_not_found"
        );
      }
      throw new CrawlerStageError(
        `Panel detail asset ${item.externalId} tidak terbuka pada ${diagnostics.url}`,
        "selector_timeout"
      );
    }
    options.onPanelReady?.();
    const keywordSelectorFound = await page
      .waitForSelector('[data-t="keywords-section"]', { timeout: selectorTimeout })
      .then(() => true)
      .catch(() => false);
    if (keywordSelectorFound) {
      await page
        .waitForFunction(hasAdobeKeywordRows, undefined, { timeout: selectorTimeout })
        .catch(() => undefined);
    }

    const keywordRows = await page.evaluate(extractAdobeKeywordRows);

    await persistAssetKeywordRows(
      researchRunId,
      assetId,
      keywordRows.map((row) => ({
        keyword: row.keyword,
        normalizedKeyword: normalizeKeyword(row.keyword),
        source: "adobe_similar_keywords",
        position: row.position
      }))
    );
    if (!keywordRows.length) {
      const diagnostics = await getPageDiagnostics(page, responseStatus);
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
    preservePanel = false;
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
  } finally {
    // Also clean up after a partial panel failure so the next asset can be
    // clicked from the search results without inheriting stale detail state.
    if (!preservePanel) await closeAdobeDetailPanel(page, selectorTimeout);
  }
}

export async function withRetry<T>(
  researchRunId: string,
  label: string,
  task: () => Promise<T>,
  maxAttempts = 2,
  diagnostics?: () => Promise<PageDiagnostics>,
  cancellationSignal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfResearchCancelled(cancellationSignal);
    try {
      return await task();
    } catch (error) {
      if (cancellationSignal?.aborted) throw new ResearchCancelledError();
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
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cancellationSignal?.removeEventListener("abort", onAbort);
            resolve();
          }, 1_500 * attempt);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new ResearchCancelledError());
          };
          cancellationSignal?.addEventListener("abort", onAbort, { once: true });
        });
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
  cancellationSignal?: AbortSignal;
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
