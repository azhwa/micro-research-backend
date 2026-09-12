import { PlaywrightCrawler } from "crawlee";
import type { Page } from "playwright";
import { and, eq, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import {
  assetObservations,
  assetKeywords,
  assets,
  researchRuns,
  searchQueries,
  suggestions
} from "../db/schema";
import {
  appendResearchEvent,
  getResearchRun,
  makeStableId,
  type ResearchMode
} from "../services/research.service";
import {
  markProxyFailure,
  markProxySuccess,
  selectProxyForResearch
} from "../services/proxy.service";

type SortMode = "downloads" | "relevance" | "recent";

interface CollectedAsset {
  externalId: string;
  title: string;
  assetUrl: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  fileExtension: string | null;
  isPremium: boolean;
}

const SORT_MODES: SortMode[] = ["downloads", "relevance", "recent"];
const FAST_SORT_MODES: SortMode[] = ["downloads"];
const BATCH_SIZE = 25;

function chunks<T>(rows: T[], size = BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

function searchUrl(query: string, assetType: string, sortMode?: SortMode): string {
  const path = assetType === "videos" ? "/search/video" : "/search/images";
  const url = new URL(path, "https://stock.adobe.com");
  url.searchParams.set("k", query);
  url.searchParams.set("limit", "100");
  url.searchParams.set("search_page", "1");
  url.searchParams.set("search_type", "usertyped");

  if (sortMode === "downloads") url.searchParams.set("order", "nb_downloads");
  if (sortMode === "recent") url.searchParams.set("order", "creation");

  return url.toString();
}

function numberOrNull(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

type FailureType =
  | "bot_detected"
  | "timeout"
  | "selector_timeout"
  | "navigation_error"
  | "http_error"
  | "asset_not_found"
  | "database_error"
  | "unknown";

interface PageDiagnostics {
  url: string;
  title: string;
  httpStatus: number | null;
  botDetected: boolean;
  bodyPreview: string;
}

class CrawlerStageError extends Error {
  constructor(
    message: string,
    readonly failureType: FailureType
  ) {
    super(message);
    this.name = "CrawlerStageError";
  }
}

const VISIBLE_BOT_MARKERS = /captcha|datadome|verify you are human|access denied|unusual traffic|security check|robot check|temporarily blocked/i;
// Do not flag a normal page merely because it loads a DataDome SDK. Require
// evidence of the actual challenge page or challenge delivery endpoint.
const HTML_BOT_MARKERS = /captcha-delivery\.com|DataDome CAPTCHA|dd-captcha|cf-chl-|challenge-platform/i;

async function getPageDiagnostics(page: Page, httpStatus: number | null = null): Promise<PageDiagnostics> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const body = await page
    .locator("body")
    .innerText({ timeout: 2_000 })
    .catch(() => "");
  const bodyPreview = body.replace(/\s+/g, " ").trim().slice(0, 240);
  const frameUrls = page.frames().map((frame) => frame.url()).join(" ");
  const html = !bodyPreview || title === "adobe.com"
    ? await page.content().catch(() => "")
    : "";
  const botDetected = VISIBLE_BOT_MARKERS.test(`${url} ${title} ${bodyPreview} ${frameUrls}`)
    || HTML_BOT_MARKERS.test(html.slice(0, 20_000));

  return { url, title, httpStatus, botDetected, bodyPreview };
}

function classifyFailure(error: unknown, diagnostics?: PageDiagnostics): FailureType {
  if (diagnostics?.botDetected) return "bot_detected";
  if (error instanceof CrawlerStageError) return error.failureType;

  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/net::|navigation|page\.goto/i.test(text)) return "navigation_error";
  if (/404|not found/i.test(text)) return "asset_not_found";
  if (/http|status code|403|500/i.test(text)) return "http_error";
  if (/turso|sqlite|database|constraint/i.test(text)) return "database_error";
  return "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function diagnosticMetadata(
  error: unknown,
  diagnostics?: PageDiagnostics,
  failureType?: FailureType
) {
  return {
    failureType: failureType ?? classifyFailure(error, diagnostics),
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: errorMessage(error),
    ...(diagnostics
      ? {
          pageUrl: diagnostics.url,
          pageTitle: diagnostics.title,
          httpStatus: diagnostics.httpStatus,
          botDetected: diagnostics.botDetected,
          bodyPreview: diagnostics.bodyPreview
        }
      : {})
  };
}

async function collectSuggestions(
  page: Page,
  researchRunId: string,
  seed: string,
  max: number,
  maxPrefixes: number
) {
  const prefixes = [
    `${seed} `,
    ...Array.from({ length: 26 }, (_, index) => `${seed} ${String.fromCharCode(97 + index)}`)
  ].slice(0, maxPrefixes);
  const collected: Array<{ baseKeyword: string; suggestion: string; position: number }> = [];
  const seen = new Set<string>();

  const input = page.locator('input[name="k"], input[aria-label="Search"]').first();

  for (const [index, prefix] of prefixes.entries()) {
    try {
      await input.fill(prefix);
      await page.waitForTimeout(650);
      const values = await page.locator(".js-search-autocomplete-panel li").allTextContents();

      values
        .map((value) => value.trim())
        .filter(Boolean)
        .forEach((suggestion, suggestionIndex) => {
          const key = suggestion.toLowerCase();
          if (!seen.has(key) && collected.length < max) {
            seen.add(key);
            collected.push({
              baseKeyword: seed,
              suggestion,
              position: suggestionIndex + 1
            });
          }
        });

      if (collected.length >= max) break;
    } catch (error) {
      const diagnostics = await getPageDiagnostics(page);
      const failureType = classifyFailure(error, diagnostics);
      await appendResearchEvent(
        researchRunId,
        "error",
        "suggestions_failed",
        `Autocomplete gagal pada percobaan ${index + 1}/${prefixes.length} [${failureType}]`,
        { prefix, ...diagnosticMetadata(error, diagnostics, failureType) }
      );
      throw new CrawlerStageError(
        `Autocomplete gagal [${failureType}]: ${errorMessage(error)}`,
        failureType
      );
    }
  }

  if (collected.length === 0) {
    collected.push({ baseKeyword: seed, suggestion: seed, position: 1 });
  }

  return collected;
}

async function collectSearchResults(
  page: Page,
  query: string,
  assetType: string,
  sortMode: SortMode,
  limit: number,
  navigationTimeout: number,
  selectorTimeout: number
) {
  const response = await page.goto(searchUrl(query, assetType, sortMode), {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeout
  });
  const httpStatus = response?.status() ?? null;
  if (httpStatus !== null && httpStatus >= 400) {
    const diagnostics = await getPageDiagnostics(page, httpStatus);
    throw new CrawlerStageError(
      `Adobe search mengembalikan HTTP ${httpStatus}${diagnostics.botDetected ? "; terindikasi bot challenge" : ""}`,
      diagnostics.botDetected ? "bot_detected" : "http_error"
    );
  }

  const resultSelector = 'a.js-search-result-thumbnail[data-content-id], div[data-content-id]';
  const selectorFound = await page
    .waitForSelector(resultSelector, { timeout: selectorTimeout })
    .then(() => true)
    .catch(() => false);

  if (!selectorFound) {
    const diagnostics = await getPageDiagnostics(page, httpStatus);
    const noResults = /no results|0 results|didn't find any/i.test(diagnostics.bodyPreview);
    if (!noResults) {
      throw new CrawlerStageError(
        `Selector hasil Adobe tidak ditemukan pada ${diagnostics.url}${diagnostics.botDetected ? "; halaman terlihat seperti bot challenge" : ""}`,
        diagnostics.botDetected ? "bot_detected" : "selector_timeout"
      );
    }
  }

  await page.waitForTimeout(800);

  const result = await page.evaluate((maxAssets) => {
    const body = document.body?.innerText ?? "";
    const resultMatch = body.match(/([\d,.]+)\s+results?\s+for\b/i);
    const resultCount = resultMatch
      ? Number(resultMatch[1].replace(/[^0-9]/g, ""))
      : null;

    const nodes = Array.from(document.querySelectorAll("[data-content-id]"));
    const seen = new Set<string>();
    const items: Array<Record<string, unknown>> = [];

    for (const node of nodes) {
      const externalId = node.getAttribute("data-content-id");
      if (!externalId || seen.has(externalId)) continue;

      const anchor = node.matches("a[href]")
        ? node
        : node.querySelector("a[href]");
      const image = node.querySelector("img");
      const titleMeta = node.querySelector('meta[itemprop="name"]');
      const contentUrlMeta = node.querySelector('meta[itemprop="contentUrl"]');
      const widthMeta = node.querySelector('meta[itemprop="width"]');
      const heightMeta = node.querySelector('meta[itemprop="height"]');
      const href = anchor?.getAttribute("href");
      const title =
        titleMeta?.getAttribute("content") ||
        image?.getAttribute("alt") ||
        anchor?.getAttribute("aria-label") ||
        `Asset ${externalId}`;
      const contentUrl = contentUrlMeta?.getAttribute("content") || "";
      const extensionMatch = contentUrl.match(/\.([a-z0-9]+)(?:\?|$)/i);

      seen.add(externalId);
      items.push({
        externalId,
        title: title.trim(),
        assetUrl: href ? new URL(href, location.href).toString() : location.href,
        thumbnailUrl: image?.getAttribute("src") || image?.getAttribute("data-src") || null,
        width: widthMeta?.getAttribute("content") || null,
        height: heightMeta?.getAttribute("content") || null,
        fileExtension: extensionMatch?.[1]?.toLowerCase() || null,
        isPremium: /premium/i.test(node.textContent || "")
      });

      if (items.length >= maxAssets) break;
    }

    return { resultCount, items };
  }, limit);

  return {
    resultCount: result.resultCount,
    assets: result.items.map((item) => ({
      externalId: String(item.externalId),
      title: String(item.title),
      assetUrl: String(item.assetUrl),
      thumbnailUrl: item.thumbnailUrl ? String(item.thumbnailUrl) : null,
      width: numberOrNull(item.width ? String(item.width) : null),
      height: numberOrNull(item.height ? String(item.height) : null),
      fileExtension: item.fileExtension ? String(item.fileExtension).toLowerCase() : null,
      isPremium: Boolean(item.isPremium)
    })) as CollectedAsset[]
  };
}

async function persistSuggestions(
  researchRunId: string,
  rows: Array<{ baseKeyword: string; suggestion: string; position: number }>,
  locale: string
) {
  const database = getDatabase();
  const values = rows.map((row) => ({
    id: makeStableId("suggestion", researchRunId, row.suggestion),
    researchRunId,
    baseKeyword: row.baseKeyword,
    suggestion: row.suggestion,
    position: row.position,
    source: "autocomplete",
    locale
  }));

  for (const batch of chunks(values)) {
    await database.insert(suggestions).values(batch).onConflictDoNothing();
  }
}

async function persistSearch(
  researchRunId: string,
  query: string,
  assetType: string,
  sortMode: SortMode,
  locale: string,
  resultCount: number | null,
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
      set: { resultCount, isComplete: false, observedAt: new Date() }
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

async function collectAndPersistAssetKeywords(
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
    if (initialDiagnostics.botDetected || httpStatus === 403) {
      throw new CrawlerStageError(
        `Halaman detail asset terkena bot challenge (HTTP ${httpStatus ?? "unknown"}): ${initialDiagnostics.url}`,
        "bot_detected"
      );
    }
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
    if (!keywordSelectorFound && diagnostics.botDetected) {
      throw new CrawlerStageError(
        `Halaman detail asset terkena bot challenge: ${diagnostics.url}`,
        "bot_detected"
      );
    }

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
      const normalizedKeyword = row.keyword.toLowerCase().replace(/\s+/g, " ");
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
      "warning",
      "keyword_detail_failed",
      `Keyword detail gagal untuk asset ${item.externalId} [${failureType}]`,
      { assetId, assetUrl: item.assetUrl, ...diagnosticMetadata(error, diagnostics, failureType) }
    );
    // Detail keyword enrichment is optional per asset. Search metadata remains valid.
    return "failed";
  }
}

async function withRetry<T>(
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

interface ResearchHooks {
  onQueryProgress?: (completed: number, total: number) => Promise<void>;
}

interface ExistingDownloadAsset extends CollectedAsset {
  query: string;
}

async function loadResumeState(researchRunId: string) {
  const database = getDatabase();
  const [completedRows, keywordRows, downloadRows] = await Promise.all([
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
      .where(and(eq(searchQueries.researchRunId, researchRunId), eq(searchQueries.sortMode, "downloads")))
  ]);

  const downloadAssetsByQuery = new Map<string, ExistingDownloadAsset[]>();
  for (const row of downloadRows) {
    const current = downloadAssetsByQuery.get(row.query) ?? [];
    current.push({
      query: row.query,
      externalId: row.externalId,
      title: row.title,
      assetUrl: row.assetUrl,
      thumbnailUrl: row.thumbnailUrl,
      width: row.width,
      height: row.height,
      fileExtension: row.fileExtension,
      isPremium: row.isPremium
    });
    downloadAssetsByQuery.set(row.query, current);
  }

  return {
    completedKeys: new Set(completedRows.map((row) => `${row.query}\u001f${row.sortMode}`)),
    enrichedAssetIds: new Set(keywordRows.map((row) => row.externalId)),
    downloadAssetsByQuery
  };
}

export async function runAdobeResearch(researchRunId: string, hooks: ResearchHooks = {}): Promise<void> {
  const run = await getResearchRun(researchRunId);
  if (!run) throw new Error("Research run tidak ditemukan");

  const mode: ResearchMode = run.mode === "fast" ? "fast" : "full";
  const sortModes = mode === "fast" ? FAST_SORT_MODES : SORT_MODES;
  const autocompletePrefixLimit = mode === "fast" ? 5 : 27;
  const navigationTimeout = mode === "fast" ? 20_000 : 30_000;
  const selectorTimeout = mode === "fast" ? 8_000 : 15_000;
  const keywordDetailLimit = mode === "fast" ? 1 : Number.POSITIVE_INFINITY;

  let requestHandled = false;
  let requestSucceeded = false;
  const selectedProxy = await selectProxyForResearch();
  if (selectedProxy) {
    await appendResearchEvent(
      researchRunId,
      "info",
      "proxy_selected",
      "Proxy dipilih: " + selectedProxy.displayUrl,
      { proxyId: selectedProxy.id, proxy: selectedProxy.displayUrl }
    );
  } else {
    await appendResearchEvent(
      researchRunId,
      "warning",
      "proxy_direct_connection",
      "Tidak ada proxy aktif; crawler memakai koneksi langsung VPS"
    );
  }

  const crawler = new PlaywrightCrawler({
    maxConcurrency: 1,
    maxRequestsPerCrawl: 1,
    useSessionPool: false,
    requestHandlerTimeoutSecs: 900,
    launchContext: {
      launchOptions: {
        headless: true,
        args: ["--disable-dev-shm-usage", "--disable-gpu"],
        ...(selectedProxy ? { proxy: selectedProxy.proxy } : {})
      }
    },
    failedRequestHandler: async ({ request, error }) => {
      const failureType = classifyFailure(error);
      await appendResearchEvent(
        researchRunId,
        "error",
        "crawler_request_failed",
        `Request crawler gagal [${failureType}]: ${request.url}`,
        {
          requestUrl: request.url,
          ...diagnosticMetadata(error, undefined, failureType)
        }
      );
    },
    requestHandler: async ({ page }) => {
      requestHandled = true;
      const response = await page.goto(searchUrl(run.seedKeyword, run.assetType), {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeout
      });
      const httpStatus = response?.status() ?? null;
      const diagnostics = await getPageDiagnostics(page, httpStatus);
      if (diagnostics.botDetected || (httpStatus !== null && httpStatus >= 400)) {
        const failureType: FailureType = diagnostics.botDetected ? "bot_detected" : "http_error";
        await appendResearchEvent(
          researchRunId,
          "error",
          "search_page_failed",
          `Halaman pencarian gagal [${failureType}]${httpStatus !== null ? ` HTTP ${httpStatus}` : ""}${diagnostics.title ? ` (${diagnostics.title})` : ""}`,
          diagnosticMetadata(
            new CrawlerStageError(`Adobe search HTTP ${httpStatus ?? "unknown"}`, failureType),
            diagnostics,
            failureType
          )
        );
        throw new CrawlerStageError(
          `Halaman pencarian gagal [${failureType}]${httpStatus ? ` HTTP ${httpStatus}` : ""}`,
          failureType
        );
      }
      await appendResearchEvent(
        researchRunId,
        "info",
        "search_page_opened",
        "Halaman pencarian Adobe Stock dibuka",
        { assetType: run.assetType, locale: run.locale }
      );

      const suggestionRows = await collectSuggestions(
        page,
        researchRunId,
        run.seedKeyword,
        run.maxSuggestions,
        autocompletePrefixLimit
      );
      await persistSuggestions(researchRunId, suggestionRows, run.locale);
      await appendResearchEvent(
        researchRunId,
        "success",
        "suggestions_collected",
        `${suggestionRows.length} suggestion berhasil ditemukan`,
        { count: suggestionRows.length }
      );

      const database = getDatabase();
      const total = suggestionRows.length * sortModes.length;
      const resumeState = await loadResumeState(researchRunId);
      let completed = [...resumeState.completedKeys].length;
      await database
        .update(researchRuns)
        .set({ progressTotal: total, progressCompleted: completed })
        .where(eq(researchRuns.id, researchRunId));

      const enrichedAssetIds = resumeState.enrichedAssetIds;
      let keywordSuccess = 0;
      let keywordEmpty = 0;
      let keywordFailed = 0;
      const enrichDownloadAssets = async (items: CollectedAsset[]) => {
        let attempted = 0;
        for (const item of items) {
          if (attempted >= keywordDetailLimit) break;
          if (enrichedAssetIds.has(item.externalId)) continue;
          enrichedAssetIds.add(item.externalId);
          attempted += 1;
          const status = await collectAndPersistAssetKeywords(
            page,
            researchRunId,
            item,
            navigationTimeout,
            selectorTimeout
          );
          if (status === "success") keywordSuccess += 1;
          if (status === "empty") keywordEmpty += 1;
          if (status === "failed") keywordFailed += 1;
        }
        return attempted;
      };
      for (const suggestion of suggestionRows) {
        for (const sortMode of sortModes) {
          const latestRun = await getResearchRun(researchRunId);
          if (!latestRun || latestRun.status === "cancelled") {
            requestSucceeded = true;
            return;
          }

          const queryKey = `${suggestion.suggestion}\u001f${sortMode}`;
          if (resumeState.completedKeys.has(queryKey)) {
            if (sortMode === "downloads") {
              await enrichDownloadAssets(resumeState.downloadAssetsByQuery.get(suggestion.suggestion) ?? []);
            }
            await appendResearchEvent(
              researchRunId,
              "info",
              "query_resumed_from_checkpoint",
              `Checkpoint dipakai untuk ${sortMode} â€œ${suggestion.suggestion}â€`,
              { query: suggestion.suggestion, sortMode }
            );
            await hooks.onQueryProgress?.(completed, total);
            continue;
          }

          await appendResearchEvent(
            researchRunId,
            "info",
            "query_started",
            `Memproses ${sortMode} untuk “${suggestion.suggestion}”`,
            { query: suggestion.suggestion, sortMode }
          );

          const searchResult = await withRetry(
            researchRunId,
            `Query ${sortMode} â€œ${suggestion.suggestion}â€`,
            () => collectSearchResults(
              page,
              suggestion.suggestion,
              run.assetType,
              sortMode,
              run.assetsPerQuery,
              navigationTimeout,
              selectorTimeout
            ),
            2,
            () => getPageDiagnostics(page)
          );
          await persistSearch(researchRunId, suggestion.suggestion, run.assetType, sortMode, run.locale, searchResult.resultCount, searchResult.assets);
          resumeState.completedKeys.add(queryKey);

          completed += 1;
          await database
            .update(researchRuns)
            .set({ progressCompleted: completed })
            .where(eq(researchRuns.id, researchRunId));
          await hooks.onQueryProgress?.(completed, total);
          await appendResearchEvent(
            researchRunId,
            "success",
            "query_completed",
            `Query ${sortMode} tersimpan: ${searchResult.assets.length} asset`,
            {
              query: suggestion.suggestion,
              sortMode,
              assets: searchResult.assets.length,
              resultCount: searchResult.resultCount
            }
          );

          if (sortMode === "downloads") {
            const attempted = await enrichDownloadAssets(searchResult.assets);
            await appendResearchEvent(
              researchRunId,
              "info",
              "keyword_enrichment_finished",
              `Selesai mencoba keyword detail dari ${searchResult.assets.length} asset Downloads`,
              {
                attempted,
                limit: Number.isFinite(keywordDetailLimit) ? keywordDetailLimit : null,
                success: keywordSuccess,
                empty: keywordEmpty,
                failed: keywordFailed
              }
            );
          }

        }
      }
      requestSucceeded = true;
    }
  });

  const startUrl = searchUrl(run.seedKeyword, run.assetType);
  try {
  await crawler.run([
    {
      url: startUrl,
      uniqueKey: `${startUrl}#${researchRunId}`
    }
  ]);

  if (!requestHandled || !requestSucceeded) {
    throw new Error("Crawler gagal menyelesaikan request Adobe Stock");
  }
    if (selectedProxy) await markProxySuccess(selectedProxy.id);
  } catch (error) {
    if (selectedProxy) {
      await markProxyFailure(
        selectedProxy.id,
        error instanceof Error ? error.message : "Crawler gagal melalui proxy",
      );
    }
    throw error;
  }
}
