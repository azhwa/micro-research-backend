import { PlaywrightCrawler } from "crawlee";
import type { Page } from "playwright";
import { and, eq } from "drizzle-orm";
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
  makeStableId
} from "../services/research.service";

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

async function collectSuggestions(page: Page, seed: string, max: number) {
  const prefixes = [
    `${seed} `,
    ...Array.from({ length: 26 }, (_, index) => `${seed} ${String.fromCharCode(97 + index)}`)
  ];
  const collected: Array<{ baseKeyword: string; suggestion: string; position: number }> = [];
  const seen = new Set<string>();

  const input = page.locator('input[name="k"], input[aria-label="Search"]').first();

  for (const prefix of prefixes) {
    await input.fill(prefix);
    await page.waitForTimeout(650);
    const values = await page.locator(".js-search-autocomplete-panel li").allTextContents();

    values
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach((suggestion, index) => {
        const key = suggestion.toLowerCase();
        if (!seen.has(key) && collected.length < max) {
          seen.add(key);
          collected.push({
            baseKeyword: seed,
            suggestion,
            position: index + 1
          });
        }
      });

    if (collected.length >= max) break;
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
  limit: number
) {
  await page.goto(searchUrl(query, assetType, sortMode), {
    waitUntil: "domcontentloaded",
    timeout: 30_000
  });

  await page
    .waitForSelector(
      'a.js-search-result-thumbnail[data-content-id], div[data-content-id]',
      { timeout: 15_000 }
    )
    .catch(() => undefined);
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

  for (const row of rows) {
    await database
      .insert(suggestions)
      .values({
        id: makeStableId("suggestion", researchRunId, row.suggestion),
        researchRunId,
        baseKeyword: row.baseKeyword,
        suggestion: row.suggestion,
        position: row.position,
        source: "autocomplete",
        locale
      })
      .onConflictDoNothing();
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

  for (const [index, item] of collectedAssets.entries()) {
    const assetId = makeStableId("asset", "adobe_stock", item.externalId);

    await database
      .insert(assets)
      .values({
        id: assetId,
        platform: "adobe_stock",
        externalId: item.externalId,
        assetType: assetType === "videos" ? "video" : "image",
        title: item.title,
        assetUrl: item.assetUrl,
        thumbnailUrl: item.thumbnailUrl,
        width: item.width,
        height: item.height,
        fileExtension: item.fileExtension,
        isPremium: item.isPremium
      })
      .onConflictDoUpdate({
        target: assets.id,
        set: {
          title: item.title,
          assetUrl: item.assetUrl,
          thumbnailUrl: item.thumbnailUrl,
          width: item.width,
          height: item.height,
          fileExtension: item.fileExtension,
          isPremium: item.isPremium,
          updatedAt: new Date()
        }
      });

    await database
      .insert(assetObservations)
      .values({
        id: makeStableId("observation", researchRunId, queryId, item.externalId, sortMode),
        researchRunId,
        assetId,
        searchQueryId: queryId,
        sortMode,
        rank: index + 1
      })
      .onConflictDoNothing();
  }

  await database
    .update(searchQueries)
    .set({ isComplete: true, observedAt: new Date() })
    .where(eq(searchQueries.id, queryId));
}

async function collectAndPersistAssetKeywords(
  page: Page,
  researchRunId: string,
  item: CollectedAsset
): Promise<"success" | "empty" | "failed"> {
  const database = getDatabase();
  const assetId = makeStableId("asset", "adobe_stock", item.externalId);

  try {
    await page.goto(item.assetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    await page
      .waitForSelector('[data-t="keywords-section"]', { timeout: 15_000 })
      .catch(() => undefined);
    await page.waitForTimeout(500);

    const keywordRows = await page.evaluate(() =>
      [...document.querySelectorAll(
        '[data-t="keywords-section"] [data-t^="similar-keyword-item-"]'
      )]
        .map((element) => (element.getAttribute("aria-label") || element.textContent || "").trim())
        .filter((keyword) => keyword && !/^\d+$/.test(keyword))
        .map((keyword, index) => ({ keyword, position: index + 1 }))
    );

    for (const row of keywordRows) {
      const normalizedKeyword = row.keyword.toLowerCase().replace(/\s+/g, " ");
      await database
        .insert(assetKeywords)
        .values({
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
        })
        .onConflictDoNothing();
    }
    return keywordRows.length ? "success" : "empty";
  } catch {
    // Detail keyword enrichment is optional per asset. Search metadata remains valid.
    return "failed";
  }
}

async function withRetry<T>(
  researchRunId: string,
  label: string,
  task: () => Promise<T>,
  maxAttempts = 2
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await appendResearchEvent(
          researchRunId,
          "warning",
          "query_retry",
          `${label} gagal, mencoba ulang (${attempt}/${maxAttempts - 1})`,
          { attempt, maxAttempts }
        );
        await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} gagal`);
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

  let requestHandled = false;

  const crawler = new PlaywrightCrawler({
    maxConcurrency: 1,
    maxRequestsPerCrawl: 1,
    useSessionPool: false,
    requestHandlerTimeoutSecs: 900,
    launchContext: {
      launchOptions: {
        headless: true,
        args: ["--disable-dev-shm-usage", "--disable-gpu"]
      }
    },
    requestHandler: async ({ page }) => {
      requestHandled = true;
      await page.goto(searchUrl(run.seedKeyword, run.assetType), {
        waitUntil: "domcontentloaded",
        timeout: 30_000
      });
      await appendResearchEvent(
        researchRunId,
        "info",
        "search_page_opened",
        "Halaman pencarian Adobe Stock dibuka",
        { assetType: run.assetType, locale: run.locale }
      );

      const suggestionRows = await collectSuggestions(
        page,
        run.seedKeyword,
        run.maxSuggestions
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
      const total = suggestionRows.length * SORT_MODES.length;
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
      for (const suggestion of suggestionRows) {
        for (const sortMode of SORT_MODES) {
          const latestRun = await getResearchRun(researchRunId);
          if (!latestRun || latestRun.status === "cancelled") return;

          const queryKey = `${suggestion.suggestion}\u001f${sortMode}`;
          if (resumeState.completedKeys.has(queryKey)) {
            if (sortMode === "downloads") {
              for (const item of resumeState.downloadAssetsByQuery.get(suggestion.suggestion) ?? []) {
                if (enrichedAssetIds.has(item.externalId)) continue;
                enrichedAssetIds.add(item.externalId);
                const status = await collectAndPersistAssetKeywords(page, researchRunId, item);
                if (status === "success") keywordSuccess += 1;
                if (status === "empty") keywordEmpty += 1;
                if (status === "failed") keywordFailed += 1;
              }
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
              run.assetsPerQuery
            )
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
            for (const item of searchResult.assets) {
              if (enrichedAssetIds.has(item.externalId)) continue;
              enrichedAssetIds.add(item.externalId);
              const status = await collectAndPersistAssetKeywords(page, researchRunId, item);
              if (status === "success") keywordSuccess += 1;
              if (status === "empty") keywordEmpty += 1;
              if (status === "failed") keywordFailed += 1;
            }
            await appendResearchEvent(
              researchRunId,
              "info",
              "keyword_enrichment_finished",
              `Selesai mencoba keyword detail dari ${searchResult.assets.length} asset Downloads`,
              {
                attempted: searchResult.assets.length,
                success: keywordSuccess,
                empty: keywordEmpty,
                failed: keywordFailed
              }
            );
          }

        }
      }
    }
  });

  const startUrl = searchUrl(run.seedKeyword, run.assetType);
  await crawler.run([
    {
      url: startUrl,
      uniqueKey: `${startUrl}#${researchRunId}`
    }
  ]);

  if (!requestHandled) {
    throw new Error("Crawler tidak memproses request Adobe Stock");
  }
}
