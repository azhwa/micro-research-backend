import { PlaywrightCrawler } from "crawlee";
import { chromium, type Browser, type Page } from "playwright";
import { eq } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { researchRuns } from "../db/schema";
import {
  appendResearchEvent,
  getResearchRun,
  type ResearchMode
} from "../services/research.service";
import {
  markProxyFailure,
  markProxySuccess,
  selectProxyForResearch
} from "../services/proxy.service";
import { env } from "../config/env";
import {
  FAST_SORT_MODES,
  PRIMARY_SORT_MODES,
  SORT_MODES,
  applyStealthScripts,
  classifyFailure,
  collectScrapingLocation,
  diagnosticMetadata,
  ensureAdobeSearchPage,
  getPageDiagnostics,
  randomJitter,
  searchPageUrl,
  type CollectedAsset,
  type SortMode
} from "./adobe-stock.core";
import { collectSearchResults } from "./adobe-stock.search";
import { collectSuggestions } from "./adobe-stock.suggestions";
import {
  collectAndPersistAssetKeywords,
  loadResumeState,
  persistFailedSearch,
  persistSearch,
  persistSuggestions,
  type ResearchHooks,
  withRetry
} from "./adobe-stock.persistence";

export { applyStealthScripts } from "./adobe-stock.core";

export async function runAdobeResearch(researchRunId: string, hooks: ResearchHooks = {}): Promise<void> {
  const run = await getResearchRun(researchRunId);
  if (!run) throw new Error("Research run tidak ditemukan");

  const mode: ResearchMode = run.mode === "fast" ? "fast" : run.mode === "primary" ? "primary" : "full";
  const sortModes = mode === "fast" ? FAST_SORT_MODES : mode === "primary" ? PRIMARY_SORT_MODES : SORT_MODES;
  const autocompletePrefixLimit = mode === "fast" ? 5 : 27;
  const navigationTimeout = mode === "fast" ? 20_000 : 30_000;
  const selectorTimeout = mode === "fast" ? 8_000 : 15_000;
  const keywordDetailLimitPerSort = mode === "fast" ? 1 : mode === "primary" ? 50 : Number.POSITIVE_INFINITY;

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
  await appendResearchEvent(
    researchRunId,
    "info",
    "crawler_browser_mode",
    `Browser crawler: ${env.playwrightHeadless ? "headless" : "headed"}`,
    { headless: env.playwrightHeadless, display: process.env.DISPLAY ?? null }
  );

  const executeScrapingSession = async (page: Page) => {
    await applyStealthScripts(page);
    requestHandled = true;
      const scrapingLocation = await collectScrapingLocation(page);
      const locationLabel = [
        scrapingLocation.city,
        scrapingLocation.region,
        scrapingLocation.country
      ].filter(Boolean).join(", ");
      const connectionLabel = selectedProxy
        ? `proxy ${selectedProxy.displayUrl}`
        : "koneksi langsung VPS";
      await appendResearchEvent(
        researchRunId,
        scrapingLocation.ip ? "info" : "warning",
        "scraping_location",
        scrapingLocation.ip
          ? `Scraping memakai ${connectionLabel} Â· IP ${scrapingLocation.ip}${locationLabel ? ` Â· ${locationLabel}` : ""}`
          : `Lokasi scraping tidak dapat diverifikasi melalui ${connectionLabel}`,
        {
          connection: selectedProxy ? "proxy" : "direct",
          proxyId: selectedProxy?.id ?? null,
          proxy: selectedProxy?.displayUrl ?? null,
          lookupUrl: "https://ipwho.is/",
          ...scrapingLocation
        }
      );
      let suggestionResult: Awaited<ReturnType<typeof collectSuggestions>>;
      if (mode === "primary") {
        suggestionResult = {
          rows: [],
          source: "seed_fallback"
        };
        await appendResearchEvent(
          researchRunId,
          "info",
          "primary_page_one_started",
          "Primary Page-One Snapshot dimulai tanpa keyword",
          { sortModes, assetsPerSort: run.assetsPerQuery, query: null }
        );
      } else if (run.autocompleteEnabled) {
        // Autocomplete must start from the clean Adobe search page. The
        // extension does not open a query URL first; it types into this page
        // and reads the resulting DOM panel.
        const { httpStatus, searchInputReady } = await ensureAdobeSearchPage(
          page,
          run.assetType,
          run.locale,
          navigationTimeout
        );
        const diagnostics = await getPageDiagnostics(page, httpStatus);
        if (!searchInputReady || diagnostics.botDetected) {
          await appendResearchEvent(
            researchRunId,
            "warning",
            "search_page_diagnostic",
            `Halaman autocomplete Adobe belum siap setelah menunggu challenge${httpStatus !== null ? ` (HTTP ${httpStatus})` : ""}; crawler memakai fallback`,
            {
              diagnostic: "challenge_page",
              pageUrl: diagnostics.url,
              pageTitle: diagnostics.title,
              httpStatus: diagnostics.httpStatus,
              botDetected: diagnostics.botDetected,
              bodyPreview: diagnostics.bodyPreview
            }
          );
        } else {
          await appendResearchEvent(
            researchRunId,
            "info",
            "autocomplete_page_opened",
            "Halaman search bersih Adobe Stock dibuka",
            { assetType: run.assetType, locale: run.locale, httpStatus: diagnostics.httpStatus }
          );
        }

        suggestionResult = await collectSuggestions(
          page,
          researchRunId,
          run.seedKeyword,
          run.maxSuggestions,
          autocompletePrefixLimit,
          selectorTimeout,
          diagnostics
        );
      } else {
        suggestionResult = {
          rows: [{ baseKeyword: run.seedKeyword, suggestion: run.seedKeyword, position: 1, prefix: null }],
          source: "seed_fallback"
        };
        await appendResearchEvent(
          researchRunId,
          "info",
          "autocomplete_disabled",
          "Autocomplete dinonaktifkan; seed keyword dipakai untuk research",
          { seedKeyword: run.seedKeyword }
        );
        await appendResearchEvent(
          researchRunId,
          "info",
          "suggestions_fallback",
          "Autocomplete tidak dijalankan; seed keyword dipakai untuk melanjutkan research",
          { seedKeyword: run.seedKeyword, reason: "disabled_by_user" }
        );
      }
      const suggestionRows = suggestionResult.rows;
      await persistSuggestions(researchRunId, suggestionRows, run.locale, suggestionResult.source);
      await appendResearchEvent(
        researchRunId,
        suggestionResult.source === "adobe_autocomplete" ? "success" : "info",
        "suggestions_collected",
        mode === "primary"
          ? "Page One tidak memakai keyword atau autocomplete"
          : suggestionResult.source === "adobe_autocomplete"
          ? `${suggestionRows.length} suggestion Adobe berhasil ditemukan`
          : `Research dilanjutkan dengan seed keyword â€œ${run.seedKeyword}â€`,
        { count: suggestionRows.length, source: suggestionResult.source, query: mode === "primary" ? null : run.seedKeyword }
      );

      const database = getDatabase();
      const queryTargets = mode === "primary"
        ? [{ suggestion: "", position: 0 }]
        : suggestionRows;
      const total = queryTargets.length * sortModes.length;
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
      const keywordPageRotationLimit = 20;
      let keywordPage: Page | null = null;
      let keywordPageUses = 0;
      const getKeywordPage = async (): Promise<Page> => {
        if (keywordPage && !keywordPage.isClosed() && keywordPageUses < keywordPageRotationLimit) {
          return keywordPage;
        }
        await keywordPage?.close().catch(() => undefined);
        keywordPage = await page.context().newPage();
        await applyStealthScripts(keywordPage);
        keywordPageUses = 0;
        return keywordPage;
      };
      const enrichAssetsForSort = async (items: CollectedAsset[], sortMode: SortMode) => {
        let selected = 0;
        let fetched = 0;
        for (const item of items) {
          if (selected >= keywordDetailLimitPerSort) break;
          selected += 1;
          if (enrichedAssetIds.has(item.externalId)) continue;
          fetched += 1;
          const detailPage = await getKeywordPage();
          keywordPageUses += 1;
          const status = await collectAndPersistAssetKeywords(
            detailPage,
            researchRunId,
            item,
            navigationTimeout,
            selectorTimeout
          );
          if (status === "success") keywordSuccess += 1;
          if (status === "empty") keywordEmpty += 1;
          if (status === "failed") keywordFailed += 1;
          if (status !== "failed") enrichedAssetIds.add(item.externalId);
          if (status === "failed") {
            await keywordPage?.close().catch(() => undefined);
            keywordPage = null;
            keywordPageUses = 0;
          }
        }
        return { selected, fetched, sortMode };
      };
      try {
        for (const suggestion of queryTargets) {
          const queryLabel = suggestion.suggestion || "Page One";
          for (const sortMode of sortModes) {
          const latestRun = await getResearchRun(researchRunId);
          if (!latestRun || latestRun.status === "cancelled") {
            requestSucceeded = true;
            return;
          }

          const queryKey = `${suggestion.suggestion}\u001f${sortMode}`;
          if (resumeState.completedKeys.has(queryKey)) {
            const resumedAssets = resumeState.assetsByQueryAndSort.get(queryKey) ?? [];
            if (resumedAssets.length) {
              await enrichAssetsForSort(resumedAssets, sortMode);
            }
            await appendResearchEvent(
              researchRunId,
              "info",
              "query_resumed_from_checkpoint",
              `Checkpoint dipakai untuk ${sortMode} Ã¢â‚¬Å“${suggestion.suggestion}Ã¢â‚¬Â`,
              { query: suggestion.suggestion, sortMode }
            );
            await hooks.onQueryProgress?.(completed, total);
            continue;
          }

          await appendResearchEvent(
            researchRunId,
            "info",
            "query_started",
            `Memproses ${sortMode} untuk ${queryLabel}`,
            { query: suggestion.suggestion || null, sortMode }
          );

          let searchResult;
          try {
            searchResult = await withRetry(
              researchRunId,
              `Query ${sortMode} ${queryLabel}`,
              () => collectSearchResults(
                page,
                suggestion.suggestion,
                run.assetType,
                run.locale,
                sortMode,
                run.assetsPerQuery,
                navigationTimeout,
                selectorTimeout
              ),
              2,
              () => getPageDiagnostics(page)
            );
          } catch (error) {
            await persistFailedSearch(researchRunId, suggestion.suggestion, run.assetType, sortMode, run.locale, run.assetsPerQuery);
            throw error;
          }
          await persistSearch(
            researchRunId,
            suggestion.suggestion,
            run.assetType,
            sortMode,
            run.locale,
            searchResult.resultCount,
            searchResult.resultCountRaw,
            searchResult.resultCountQualifier,
            run.assetsPerQuery,
            searchResult.assets
          );
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
              query: suggestion.suggestion || null,
              sortMode,
              assets: searchResult.assets.length,
              resultCount: searchResult.resultCount
            }
          );

          const enrichment = await enrichAssetsForSort(searchResult.assets, sortMode);
          if (enrichment.selected > 0) {
            await appendResearchEvent(
              researchRunId,
              "info",
              "keyword_enrichment_progress",
              `Keyword detail diproses untuk ${enrichment.selected} asset ${sortMode}`,
              {
                selected: enrichment.selected,
                fetched: enrichment.fetched,
                sortMode,
                success: keywordSuccess,
                empty: keywordEmpty,
                failed: keywordFailed
              }
            );
          }

          await randomJitter(700, 1800);
          }
        }
      } finally {
        const pageToClose: Page | null = keywordPage as Page | null;
        keywordPage = null;
        if (pageToClose) await pageToClose.close().catch(() => undefined);
      }
      requestSucceeded = true;
    };

    if (env.playwrightCdpUrl) {
      await appendResearchEvent(
        researchRunId,
        "info",
        "crawler_browser_mode",
        `Browser crawler: external CDP (${env.playwrightCdpUrl})`,
        { cdpUrl: env.playwrightCdpUrl }
      );
      let browser: Browser | null = null;
      try {
        browser = await chromium.connectOverCDP(env.playwrightCdpUrl);
        const context = browser.contexts()[0] || (await browser.newContext({
          viewport: { width: 1920, height: 1080 }
        }));
        // Reuse the browser's existing tab so Adobe's challenge cookies and
        // browser session remain available for the next research run. The
        // external Chromium process is owned by systemd, not this request.
        const page = context.pages().find((candidate) => !candidate.isClosed())
          ?? await context.newPage();
        await executeScrapingSession(page);
        if (!requestHandled || !requestSucceeded) {
          throw new Error("Crawler gagal menyelesaikan request Adobe Stock via CDP");
        }
        if (selectedProxy) await markProxySuccess(selectedProxy.id);
        await appendResearchEvent(
          researchRunId,
          "info",
          "crawler_cdp_session_kept_open",
          "Browser CDP eksternal tetap terbuka agar session challenge Adobe dapat dipakai ulang",
          { cdpUrl: env.playwrightCdpUrl, openPages: context.pages().length }
        );
      } catch (error) {
        if (selectedProxy) {
          await markProxyFailure(
            selectedProxy.id,
            error instanceof Error ? error.message : "Crawler gagal melalui proxy (CDP)"
          );
        }
        throw error;
      } finally {
        // Disconnect Playwright after each request. For a CDP-connected
        // browser, close() clears Playwright-owned contexts and disconnects;
        // it does not stop the external Chromium process managed by systemd.
        await browser?.close().catch(() => undefined);
      }
      return;
    }

    const crawler = new PlaywrightCrawler({
      maxConcurrency: 1,
      maxRequestsPerCrawl: 1,
      useSessionPool: false,
      requestHandlerTimeoutSecs: 900,
      launchContext: {
        launchOptions: {
          headless: env.playwrightHeadless,
          args: [
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-infobars",
            "--disable-blink-features=AutomationControlled",
            "--window-size=1920,1080"
          ],
          ignoreDefaultArgs: ["--enable-automation"],
          ...(selectedProxy ? { proxy: selectedProxy.proxy } : {})
        }
      },
      preNavigationHooks: [
        async ({ page }) => {
          await applyStealthScripts(page);
        }
      ],
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
        await executeScrapingSession(page);
      }
    });

    // Start from Adobe's clean search page. The request handler performs the
    // keyword entry and sort selection through the page UI.
    const startUrl = searchPageUrl(run.assetType, run.locale);
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
          error instanceof Error ? error.message : "Crawler gagal melalui proxy"
        );
      }
      throw error;
    }
}
