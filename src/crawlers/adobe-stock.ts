import { PlaywrightCrawler } from "crawlee";
import { chromium, type Page } from "playwright";
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
import { env } from "../config/env";
import { normalizeKeyword, parseAdobeResultCount, type ResultCountQualifier } from "../services/research-metrics";

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
const PRIMARY_SORT_MODES: SortMode[] = ["relevance", "recent", "downloads"];
const FAST_SORT_MODES: SortMode[] = ["downloads"];
const BATCH_SIZE = 25;

export function randomJitter(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STEALTH_INIT_SCRIPT = `
(() => {
  try {
    const nav = navigator;
    const navProto = Object.getPrototypeOf(navigator);
    if ("webdriver" in navProto) {
      delete navProto.webdriver;
    }
    if ("webdriver" in navigator) {
      try {
        delete navigator.webdriver;
      } catch (e) {}
    }

    const win = window;
    if (!win.chrome) {
      Object.defineProperty(win, "chrome", {
        writable: true,
        enumerable: true,
        configurable: false,
        value: {}
      });
    }

    if (!win.chrome.app) {
      Object.defineProperty(win.chrome, "app", {
        writable: true,
        enumerable: true,
        configurable: true,
        value: {
          isInstalled: false,
          InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
          RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" }
        }
      });
    }

    if (!win.chrome.runtime) {
      Object.defineProperty(win.chrome, "runtime", {
        writable: true,
        enumerable: true,
        configurable: true,
        value: {
          OnInstalledReason: {},
          OnRestartRequiredReason: {},
          PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
          PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
          PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
          RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" }
        }
      });
    }

    if (!win.chrome.loadTimes) {
      Object.defineProperty(win.chrome, "loadTimes", {
        writable: true,
        enumerable: true,
        configurable: true,
        value: function () {
          return {
            commitLoadTime: Date.now() / 1000 - 0.5,
            connectionInfo: "h2",
            finishDocumentLoadTime: Date.now() / 1000 - 0.2,
            finishLoadTime: Date.now() / 1000 - 0.1,
            firstPaintAfterLoadTime: 0,
            firstPaintTime: Date.now() / 1000 - 0.3,
            navigationType: "Other",
            npnNegotiatedProtocol: "h2",
            requestTime: Date.now() / 1000 - 0.8,
            startLoadTime: Date.now() / 1000 - 0.8,
            wasAlternateProtocolAvailable: false,
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true
          };
        }
      });
    }

    if (!win.chrome.csi) {
      Object.defineProperty(win.chrome, "csi", {
        writable: true,
        enumerable: true,
        configurable: true,
        value: function () {
          return {
            startE: Date.now() - 800,
            onloadT: Date.now() - 200,
            pageT: 600,
            tran: 15
          };
        }
      });
    }

    if (!nav.plugins || nav.plugins.length === 0) {
      const dummyPlugin = {
        0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format" },
        description: "Portable Document Format",
        filename: "internal-pdf-viewer",
        length: 1,
        name: "Chrome PDF Plugin"
      };
      Object.defineProperty(nav, "plugins", {
        get: () => [dummyPlugin, dummyPlugin],
        configurable: true
      });
    }

    Object.defineProperty(nav, "languages", {
      get: () => ["en-US", "en"],
      configurable: true
    });

    if (nav.permissions && nav.permissions.query) {
      const originalQuery = nav.permissions.query.bind(nav.permissions);
      nav.permissions.query = (parameters) =>
        parameters && parameters.name === "notifications"
          ? Promise.resolve({ state: (win.Notification && win.Notification.permission) || "default" })
          : originalQuery(parameters);
    }

    if (typeof WebGLRenderingContext !== "undefined") {
      const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (parameter) {
        if (parameter === 37445) return "Google Inc. (NVIDIA)";
        if (parameter === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)";
        return originalGetParameter.apply(this, [parameter]);
      };
    }
  } catch {}
})();
`;

export async function applyStealthScripts(page: Page): Promise<void> {
  await page.addInitScript(STEALTH_INIT_SCRIPT);
}

function chunks<T>(rows: T[], size = BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

function adobeLocalePrefix(locale?: string): string {
  const normalizedLocale = locale?.toLowerCase().replace(/_/g, "-") ?? "";
  return normalizedLocale.startsWith("id")
    ? "/id"
    : normalizedLocale.startsWith("en-gb") || normalizedLocale.startsWith("en-uk")
      ? "/uk"
      : "";
}

function searchPath(assetType: string, locale?: string): string {
  return adobeLocalePrefix(locale) + (assetType === "videos" ? "/search/video" : "/search/images");
}

function searchPageUrl(assetType: string, locale?: string): string {
  return new URL(searchPath(assetType, locale), "https://stock.adobe.com").toString();
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
  pageUsable: boolean;
  searchInputCount: number;
  searchInputVisible: boolean;
  assetCount: number;
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
const AUTOCOMPLETE_INPUT_SELECTOR =
  '.js-search-input.js-search-text-input, input[name="search"], input[name="k"], input[aria-label*="Search" i], input[type="search"]';
const AUTOCOMPLETE_PANEL_SELECTOR =
  '.js-search-autocomplete-panel, [role="listbox"], [data-t="search-autocomplete"]';
const AUTOCOMPLETE_ITEM_SELECTOR =
  '.js-search-autocomplete-panel li, [role="listbox"] [role="option"], [data-t="search-autocomplete"] li';
const SORT_SELECT_SELECTOR = 'select[data-t="search-sort-menu"]';
const ADOBE_RESULT_SELECTOR = 'a.js-search-result-thumbnail[data-content-id], div[data-content-id]';
// Adobe may return a short-lived HTTP 403 challenge before replacing it with
// the real search page. Wait for that transition before classifying a query.
const ADOBE_CHALLENGE_WAIT_MS = 30_000;

function adobeSortValue(sortMode: SortMode): string {
  if (sortMode === "downloads") return "nb_downloads";
  if (sortMode === "recent") return "creation";
  return "relevance";
}

async function waitForAdobeSearchInput(page: Page, timeoutMs = ADOBE_CHALLENGE_WAIT_MS): Promise<boolean> {
  return page
    .locator(AUTOCOMPLETE_INPUT_SELECTOR)
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

async function ensureAdobeSearchPage(
  page: Page,
  assetType: string,
  locale: string,
  navigationTimeout: number,
  requireCleanQuery = false
) {
  const targetUrl = new URL(searchPageUrl(assetType, locale));
  const currentUrl = new URL(page.url());
  const alreadyOnSearchPage = currentUrl.origin === targetUrl.origin
    && currentUrl.pathname === targetUrl.pathname
    && (!requireCleanQuery || !currentUrl.searchParams.has("k"));
  let httpStatus: number | null = null;

  // PlaywrightCrawler has already navigated to the start URL before calling
  // requestHandler. Reusing that page is important: navigating to the clean
  // URL again resets Adobe's short-lived challenge before it can complete.
  if (!alreadyOnSearchPage) {
    const response = await page.goto(targetUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeout
    });
    httpStatus = response?.status() ?? null;
  }

  const searchInputReady = await waitForAdobeSearchInput(page);
  return { httpStatus, searchInputReady };
}

async function selectAdobeSort(
  page: Page,
  sortValue: string,
  timeoutMs: number,
  query: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const remaining = Math.max(500, deadline - Date.now());
    const select = page.locator(SORT_SELECT_SELECTOR).first();

    try {
      await page.waitForLoadState("domcontentloaded", { timeout: Math.min(remaining, 5_000) }).catch(() => undefined);
      const state = await readAdobeSortState(page, sortValue, query);
      const optionExists = await select.locator(`option[value="${sortValue}"]`).count() > 0;

      // Adobe can keep the native select disabled while the SPA is rendering,
      // even though it already applied the requested sort to the URL/state.
      // In that case the result loader is the readiness signal, not disabled.
      if (state.value === sortValue && state.urlSort === sortValue && state.queryMatches) return;

      if (!state.disabled && optionExists) {
        await select.selectOption(sortValue, { timeout: Math.min(remaining, 5_000) });
        await page.waitForFunction(
          ({ selector, value, requestedQuery }) => {
            const element = document.querySelector(selector);
            const url = new URL(location.href);
            const currentQuery = (url.searchParams.get("k") || "").trim().toLowerCase();
            return element instanceof HTMLSelectElement
              && element.value === value
              && url.searchParams.get("order") === value
              && currentQuery === requestedQuery.trim().toLowerCase()
              && !element.disabled;
          },
          { selector: SORT_SELECT_SELECTOR, value: sortValue, requestedQuery: query },
          { timeout: Math.min(remaining, 10_000) }
        );
        return;
      }

      lastError = new Error(`Adobe tidak mempertahankan sort '${sortValue}'`);
    } catch (error) {
      lastError = error;
    }

    await page.waitForTimeout(Math.min(500, Math.max(100, deadline - Date.now())));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Dropdown sort Adobe belum siap untuk '${sortValue}'`);
}

interface AdobeSortState {
  value: string | null;
  disabled: boolean;
  urlSort: string | null;
  queryMatches: boolean;
  resultCount: number;
}

async function readAdobeSortState(page: Page, sortValue: string, query: string): Promise<AdobeSortState> {
  return page.evaluate(({ selector, value, requestedQuery, resultSelector }) => {
    const element = document.querySelector(selector);
    const url = new URL(location.href);
    const normalizedQuery = requestedQuery.trim().toLowerCase();
    const currentQuery = (url.searchParams.get("k") || "").trim().toLowerCase();

    return {
      value: element instanceof HTMLSelectElement ? element.value : null,
      disabled: element instanceof HTMLSelectElement ? element.disabled : true,
      urlSort: url.searchParams.get("order"),
      queryMatches: currentQuery === normalizedQuery,
      resultCount: document.querySelectorAll(resultSelector).length
    };
  }, { selector: SORT_SELECT_SELECTOR, value: sortValue, requestedQuery: query, resultSelector: ADOBE_RESULT_SELECTOR });
}

async function currentAdobeSearchState(page: Page): Promise<{ query: string; sort: string | null }> {
  return page.evaluate(() => {
    const url = new URL(location.href);
    return {
      query: (url.searchParams.get("k") || "").trim().toLowerCase(),
      sort: url.searchParams.get("order")
    };
  }).catch(() => ({ query: "", sort: null }));
}

async function prepareAdobeQuery(
  page: Page,
  query: string,
  assetType: string,
  locale: string,
  sortValue: string,
  navigationTimeout: number
): Promise<{ httpStatus: number | null }> {
  const isPageOne = query.trim() === "";
  let { httpStatus, searchInputReady } = await ensureAdobeSearchPage(
    page,
    assetType,
    locale,
    navigationTimeout,
    isPageOne
  );

  if (!searchInputReady) {
    throw new CrawlerStageError(
      `Halaman Adobe belum siap setelah menunggu challenge ${ADOBE_CHALLENGE_WAIT_MS}ms pada ${page.url()}`,
      "selector_timeout"
    );
  }

  const currentState = await currentAdobeSearchState(page);
  if (isPageOne && currentState.sort && currentState.sort !== sortValue) {
    const response = await page.reload({
      waitUntil: "domcontentloaded",
      timeout: navigationTimeout
    });
    httpStatus = response?.status() ?? httpStatus;
    searchInputReady = await waitForAdobeSearchInput(page);
    if (!searchInputReady) {
      throw new CrawlerStageError(
        `Halaman Page One Adobe belum siap pada ${page.url()}`,
        "selector_timeout"
      );
    }
  }

  if (!isPageOne) {
    const input = page.locator(AUTOCOMPLETE_INPUT_SELECTOR).first();
    if (currentState.query === query.trim().toLowerCase() && currentState.sort) {
      const response = await page.reload({
        waitUntil: "domcontentloaded",
        timeout: navigationTimeout
      });
      httpStatus = response?.status() ?? httpStatus;
      searchInputReady = await waitForAdobeSearchInput(page);
    }
    if (!searchInputReady) {
      throw new CrawlerStageError(
        `Input pencarian Adobe belum siap pada ${page.url()}`,
        "selector_timeout"
      );
    }
    try {
      await input.fill(query);
      await input.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: navigationTimeout }).catch(() => undefined);
    } catch (error) {
      throw new CrawlerStageError(
        `Input pencarian Adobe tidak dapat digunakan pada ${page.url()}: ${errorMessage(error)}`,
        classifyFailure(error) === "timeout" ? "selector_timeout" : "navigation_error"
      );
    }
    if (!await waitForAdobeSearchInput(page, Math.min(navigationTimeout, ADOBE_CHALLENGE_WAIT_MS))) {
      throw new CrawlerStageError(
        `Hasil pencarian Adobe belum siap pada ${page.url()}`,
        "navigation_error"
      );
    }
  }

  return { httpStatus };
}

async function settleAdobeSort(
  page: Page,
  query: string,
  sortValue: string,
  navigationTimeout: number,
  selectorTimeout: number
): Promise<void> {
  const sortSelect = page.locator(SORT_SELECT_SELECTOR).first();
  const resultSelectorTimeout = Math.max(selectorTimeout, 20_000);
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await sortSelect.waitFor({ state: "visible", timeout: Math.max(selectorTimeout, ADOBE_CHALLENGE_WAIT_MS) });
      const initialSortState = await readAdobeSortState(page, sortValue, query);
      const sortTimeout = attempt === 1
        ? Math.min(selectorTimeout, 8_000)
        : Math.max(selectorTimeout, ADOBE_CHALLENGE_WAIT_MS);
      await selectAdobeSort(page, sortValue, sortTimeout, query);
      await page.waitForLoadState("domcontentloaded", { timeout: navigationTimeout }).catch(() => undefined);
      const resultReady = await waitForAdobeResults(
        page,
        query,
        sortValue,
        resultSelectorTimeout,
        !(initialSortState.value === sortValue
          && initialSortState.urlSort === sortValue
          && initialSortState.queryMatches)
      );
      if (!resultReady) {
        throw new Error(`Hasil Adobe belum siap setelah sort '${sortValue}'`);
      }

      const selectedSortValue = await sortSelect.inputValue();
      const currentUrlSort = new URL(page.url()).searchParams.get("order");
      if (selectedSortValue !== sortValue && currentUrlSort !== sortValue) {
        throw new Error(`Adobe memilih sort '${selectedSortValue}', expected '${sortValue}'`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;

      await page.waitForTimeout(1_000);
      const currentState = await currentAdobeSearchState(page);
      if (currentState.sort !== sortValue) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: navigationTimeout });
        await waitForAdobeSearchInput(page);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Adobe sort '${sortValue}' gagal`);
}

async function waitForAdobeResults(
  page: Page,
  query: string,
  sortValue: string,
  timeoutMs: number,
  requireEnabled: boolean
): Promise<boolean> {
  return page
    .waitForFunction(
      ({ requestedQuery, expectedSort, resultSelector, sortSelector, requireEnabled }) => {
        const url = new URL(location.href);
        const currentQuery = (url.searchParams.get("k") || "").trim().toLowerCase();
        const queryMatches = currentQuery === requestedQuery.trim().toLowerCase();
        const select = document.querySelector(sortSelector);
        const selectedValue = select instanceof HTMLSelectElement ? select.value : null;
        const sortMatches = url.searchParams.get("order") === expectedSort || selectedValue === expectedSort;
        const sortControlReady = !requireEnabled
          || !(select instanceof HTMLSelectElement)
          || !select.disabled;
        const body = document.body?.innerText || "";
        const noResults = /no results|0 results|didn't find any/i.test(body);
        const resultCount = document.querySelectorAll(resultSelector).length;

        return queryMatches && sortMatches && sortControlReady && (resultCount > 0 || noResults);
      },
      { requestedQuery: query, expectedSort: sortValue, resultSelector: ADOBE_RESULT_SELECTOR, sortSelector: SORT_SELECT_SELECTOR, requireEnabled },
      { timeout: timeoutMs }
    )
    .then(async () => {
      // Adobe replaces the result cards after the control becomes enabled.
      // Give the SPA one short paint cycle before extraction begins.
      await page.waitForTimeout(750);
      return true;
    })
    .catch(() => false);
}

async function getPageDiagnostics(page: Page, httpStatus: number | null = null): Promise<PageDiagnostics> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const body = await page
    .locator("body")
    .innerText({ timeout: 2_000 })
    .catch(() => "");
  const bodyPreview = body.replace(/\s+/g, " ").trim().slice(0, 240);
  const searchInputLocator = page.locator(AUTOCOMPLETE_INPUT_SELECTOR);
  const searchInputCount = await searchInputLocator.count().catch(() => 0);
  const searchInputVisible = searchInputCount > 0
    && await searchInputLocator.first().isVisible().catch(() => false);
  const assetCount = await page.locator("[data-content-id]").count().catch(() => 0);
  const html = !bodyPreview || title === "adobe.com"
    ? await page.content().catch(() => "")
    : "";
  const pageUsable = searchInputVisible || assetCount > 0;
  const challengeDetected = VISIBLE_BOT_MARKERS.test(`${url} ${title} ${bodyPreview}`)
    || HTML_BOT_MARKERS.test(html.slice(0, 20_000));
  const botDetected = !pageUsable && challengeDetected;

  return {
    url,
    title,
    httpStatus,
    botDetected,
    pageUsable,
    searchInputCount,
    searchInputVisible,
    assetCount,
    bodyPreview
  };
}

function classifyFailure(error: unknown, diagnostics?: PageDiagnostics): FailureType {
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
  if (!(error instanceof Error)) return String(error);

  const cause = error.cause;
  if (cause instanceof Error && cause !== error) {
    return `${error.message}; cause: ${cause.message}`;
  }

  return error.message;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface ScrapingLocation {
  ip: string | null;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  isp: string | null;
  organization: string | null;
  latitude: number | null;
  longitude: number | null;
  httpStatus: number | null;
  lookupError?: string;
}

/**
 * Resolve the public egress IP from inside the Playwright context. A
 * Node-side request could bypass the browser proxy and report the VPS IP.
 */
async function collectScrapingLocation(page: Page): Promise<ScrapingLocation> {
  let probe: Page | null = null;
  let httpStatus: number | null = null;

  try {
    probe = await page.context().newPage();
    const response = await probe.goto("https://ipwho.is/", {
      waitUntil: "domcontentloaded",
      timeout: 10_000
    });
    httpStatus = response?.status() ?? null;
    const body = await probe.locator("body").innerText({ timeout: 3_000 });
    const payload = JSON.parse(body) as Record<string, unknown>;

    if (payload.success === false) {
      throw new Error(stringValue(payload.message) ?? "IP geolocation lookup failed");
    }

    const connection = payload.connection && typeof payload.connection === "object"
      ? payload.connection as Record<string, unknown>
      : {};

    return {
      ip: stringValue(payload.ip),
      country: stringValue(payload.country),
      countryCode: stringValue(payload.country_code),
      region: stringValue(payload.region),
      city: stringValue(payload.city),
      isp: stringValue(connection.isp),
      organization: stringValue(connection.org),
      latitude: numberValue(payload.latitude),
      longitude: numberValue(payload.longitude),
      httpStatus
    };
  } catch (error) {
    return {
      ip: null,
      country: null,
      countryCode: null,
      region: null,
      city: null,
      isp: null,
      organization: null,
      latitude: null,
      longitude: null,
      httpStatus,
      lookupError: errorMessage(error)
    };
  } finally {
    await probe?.close().catch(() => undefined);
  }
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
          pageUsable: diagnostics.pageUsable,
          searchInputCount: diagnostics.searchInputCount,
          searchInputVisible: diagnostics.searchInputVisible,
          assetCount: diagnostics.assetCount,
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
  maxPrefixes: number,
  selectorTimeout: number,
  initialDiagnostics: PageDiagnostics
) {
  const prefixes = [
    `${seed} `,
    ...Array.from({ length: 26 }, (_, index) => `${seed} ${String.fromCharCode(97 + index)}`)
  ].slice(0, maxPrefixes);
  const collected: Array<{ baseKeyword: string; suggestion: string; position: number; prefix: string | null }> = [];
  const seen = new Set<string>();
  let source: "adobe_autocomplete" | "seed_fallback" = "adobe_autocomplete";
  let emptyPanelStreak = 0;

  // Keep these selectors aligned with the working browser extension. Adobe
  // changes the accessible name between localized search pages, while the
  // class-based selector has remained the most stable one.
  const input = page.locator(AUTOCOMPLETE_INPUT_SELECTOR).first();

  if (initialDiagnostics.botDetected) {
    source = "seed_fallback";
    await appendResearchEvent(
      researchRunId,
      "info",
      "autocomplete_unavailable",
      "Autocomplete dilewati karena halaman challenge terdeteksi",
      { ...initialDiagnostics, source }
    );
  } else {
    try {
      await input.waitFor({ state: "visible", timeout: Math.min(selectorTimeout, 5_000) });
      await appendResearchEvent(
        researchRunId,
        "info",
      "autocomplete_input_found",
      "Input autocomplete Adobe ditemukan",
        { selector: "extension-compatible", searchInputCount: initialDiagnostics.searchInputCount }
      );
    } catch (error) {
      source = "seed_fallback";
      const diagnostics = await getPageDiagnostics(page);
      const failureType = classifyFailure(error, diagnostics);
      await appendResearchEvent(
        researchRunId,
        "info",
        "autocomplete_unavailable",
        `Input autocomplete tidak tersedia [${failureType}]`,
        diagnosticMetadata(error, diagnostics, failureType)
      );
    }
  }

  for (const [index, prefix] of source === "adobe_autocomplete" ? prefixes.entries() : []) {
    try {
      await randomJitter(350, 750);
      // The extension types into the existing Adobe input and emits input
      // events. Use the same value mutation and input dispatch as the
      // extension; keyboard events can be ignored by Adobe's search handler.
      await page.evaluate(async ({ selector, value }) => {
        const element = document.querySelector(selector) as HTMLInputElement | null;
        if (!element) throw new Error("Autocomplete input tidak ditemukan saat typing");
        element.focus();
        element.value = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
        for (const character of value) {
          element.value += character;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          const typingDelay = Math.floor(Math.random() * (130 - 60 + 1)) + 60;
          await new Promise((resolve) => setTimeout(resolve, typingDelay));
        }
      }, { selector: AUTOCOMPLETE_INPUT_SELECTOR, value: prefix });

      const panel = page.locator(AUTOCOMPLETE_PANEL_SELECTOR).first();
      const panelItems = panel.locator("li, [role=\"option\"]").first();
      let panelFound = false;
      try {
        await panelItems.waitFor({ state: "visible", timeout: 3_000 });
        panelFound = true;
        emptyPanelStreak = 0;
        await appendResearchEvent(
          researchRunId,
          "info",
          "autocomplete_panel_found",
          `Panel autocomplete ditemukan untuk prefix “${prefix}”`,
          { prefix }
        );
      } catch {
        // A valid page can have no suggestions for a particular prefix.
        emptyPanelStreak += 1;
        if (emptyPanelStreak >= 3) {
          source = "seed_fallback";
          await appendResearchEvent(
            researchRunId,
            "info",
            "autocomplete_unavailable",
            "Panel autocomplete tidak muncul setelah 3 prefix; fallback digunakan",
            { prefix, attempts: index + 1 }
          );
          break;
        }
      }

      if (!panelFound) continue;

      const values = await page.locator(AUTOCOMPLETE_ITEM_SELECTOR).allTextContents();

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
              position: suggestionIndex + 1,
              prefix
            });
          }
        });

      if (collected.length >= max) break;
    } catch (error) {
      const diagnostics = await getPageDiagnostics(page);
      const failureType = classifyFailure(error, diagnostics);
      if (collected.length === 0) source = "seed_fallback";
      await appendResearchEvent(
        researchRunId,
        "warning",
        "suggestions_failed",
        `Autocomplete gagal pada percobaan ${index + 1}/${prefixes.length} [${failureType}]`,
        { prefix, ...diagnosticMetadata(error, diagnostics, failureType) }
      );
      break;
    }
  }

  if (collected.length === 0) {
    source = "seed_fallback";
    collected.push({ baseKeyword: seed, suggestion: seed, position: 1, prefix: null });
    await appendResearchEvent(
      researchRunId,
      "info",
      "suggestions_fallback",
      "Autocomplete tidak tersedia; seed keyword dipakai untuk melanjutkan research",
      { seedKeyword: seed }
    );
  }

  return { rows: collected, source };
}

async function collectSearchResults(
  page: Page,
  query: string,
  assetType: string,
  locale: string,
  sortMode: SortMode,
  limit: number,
  navigationTimeout: number,
  selectorTimeout: number
) {
  // Use the same browser flow as a real user. Page One deliberately keeps the
  // clean Adobe feed without a `k` parameter; keyword research types the
  // requested keyword first, then both flows choose the sort from Adobe's
  // own dropdown. Sending `order=...` directly is unreliable with Adobe's
  // bot protection and does not always match the UI state.
  const sortValue = adobeSortValue(sortMode);
  const { httpStatus } = await prepareAdobeQuery(
    page,
    query,
    assetType,
    locale,
    sortValue,
    navigationTimeout
  );
  const resultSelectorTimeout = Math.max(selectorTimeout, 20_000);

  try {
    await settleAdobeSort(page, query, sortValue, navigationTimeout, selectorTimeout);
  } catch (error) {
    const diagnostics = await getPageDiagnostics(page, httpStatus);
    throw new CrawlerStageError(
      `Dropdown sort Adobe tidak dapat dipilih (${sortValue}) pada ${diagnostics.url}: ${errorMessage(error)}`,
      diagnostics.botDetected
        ? "bot_detected"
        : classifyFailure(error, diagnostics) === "timeout" ? "selector_timeout" : "navigation_error"
    );
  }

  // Fast mode reduces query count, but headed Chromium on the VPS can still
  // need more time for Adobe's result cards to be inserted after the HTML
  // shell and result count have already appeared.
  const selectorFound = await page
    .waitForSelector(ADOBE_RESULT_SELECTOR, { timeout: resultSelectorTimeout })
    .then(() => true)
    .catch(() => false);

  if (!selectorFound) {
    const diagnostics = await getPageDiagnostics(page, httpStatus);
    const noResults = /no results|0 results|didn't find any/i.test(diagnostics.bodyPreview);
    if (!noResults) {
      throw new CrawlerStageError(
        `Selector hasil Adobe tidak ditemukan pada ${diagnostics.url}`,
        "selector_timeout"
      );
    }
  }

  await page.evaluate(async (maxAssets) => {
    let previousCount = 0;
    let stableRounds = 0;
    for (let step = 0; step < 24 && stableRounds < 3; step += 1) {
      const currentCount = document.querySelectorAll("[data-content-id]").length;
      if (currentCount >= maxAssets) break;
      window.scrollBy({ top: 420 + Math.random() * 180, behavior: "smooth" });
      await new Promise((resolve) => setTimeout(resolve, 260 + Math.random() * 140));
      const nextCount = document.querySelectorAll("[data-content-id]").length;
      stableRounds = nextCount === previousCount ? stableRounds + 1 : 0;
      previousCount = nextCount;
    }
    window.scrollTo(0, 0);
  }, limit);
  await randomJitter(400, 800);

  const result = await page.evaluate((maxAssets) => {
    const body = document.body?.innerText ?? "";

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

    return { body, items };
  }, limit);

  const parsedResultCount = parseAdobeResultCount(result.body);

  return {
    resultCount: parsedResultCount.value,
    resultCountRaw: parsedResultCount.raw,
    resultCountQualifier: parsedResultCount.qualifier,
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

async function persistSearch(
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

async function persistFailedSearch(
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

interface ExistingSearchAsset extends CollectedAsset {
  query: string;
  sortMode: SortMode;
}

async function loadResumeState(researchRunId: string) {
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
          ? `Scraping memakai ${connectionLabel} · IP ${scrapingLocation.ip}${locationLabel ? ` · ${locationLabel}` : ""}`
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
          : `Research dilanjutkan dengan seed keyword “${run.seedKeyword}”`,
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
      const enrichAssetsForSort = async (items: CollectedAsset[], sortMode: SortMode) => {
        let selected = 0;
        let fetched = 0;
        for (const item of items) {
          if (selected >= keywordDetailLimitPerSort) break;
          selected += 1;
          if (enrichedAssetIds.has(item.externalId)) continue;
          fetched += 1;
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
          if (status !== "failed") enrichedAssetIds.add(item.externalId);
        }
        return { selected, fetched, sortMode };
      };
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
      try {
        const browser = await chromium.connectOverCDP(env.playwrightCdpUrl);
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
