import type { Page } from "playwright";

export type SortMode = "downloads" | "relevance" | "recent";

export interface CollectedAsset {
  externalId: string;
  title: string;
  assetUrl: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  fileExtension: string | null;
  isPremium: boolean;
}

export const SORT_MODES: SortMode[] = ["downloads", "relevance", "recent"];
export const PRIMARY_SORT_MODES: SortMode[] = ["relevance", "recent", "downloads"];
export const FAST_SORT_MODES: SortMode[] = ["downloads"];
export const BATCH_SIZE = 25;

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

export function chunks<T>(rows: T[], size = BATCH_SIZE): T[][] {
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

export function searchPageUrl(assetType: string, locale?: string): string {
  return new URL(searchPath(assetType, locale), "https://stock.adobe.com").toString();
}

export function numberOrNull(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export type FailureType =
  | "bot_detected"
  | "timeout"
  | "selector_timeout"
  | "navigation_error"
  | "http_error"
  | "asset_not_found"
  | "database_error"
  | "unknown";

export interface PageDiagnostics {
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

export class CrawlerStageError extends Error {
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
export const AUTOCOMPLETE_INPUT_SELECTOR =
  '.js-search-input.js-search-text-input, input[name="search"], input[name="k"], input[aria-label*="Search" i], input[type="search"]';
export const AUTOCOMPLETE_PANEL_SELECTOR =
  '.js-search-autocomplete-panel, [role="listbox"], [data-t="search-autocomplete"]';
export const AUTOCOMPLETE_ITEM_SELECTOR =
  '.js-search-autocomplete-panel li, [role="listbox"] [role="option"], [data-t="search-autocomplete"] li';
export const SORT_SELECT_SELECTOR = 'select[data-t="search-sort-menu"]';
export const ADOBE_RESULT_SELECTOR = 'a.js-search-result-thumbnail[data-content-id], div[data-content-id]';
// Adobe may return a short-lived HTTP 403 challenge before replacing it with
// the real search page. Wait for that transition before classifying a query.
export const ADOBE_CHALLENGE_WAIT_MS = 30_000;

export function adobeSortValue(sortMode: SortMode): string {
  if (sortMode === "downloads") return "nb_downloads";
  if (sortMode === "recent") return "creation";
  return "relevance";
}

export async function waitForAdobeSearchInput(page: Page, timeoutMs = ADOBE_CHALLENGE_WAIT_MS): Promise<boolean> {
  return page
    .locator(AUTOCOMPLETE_INPUT_SELECTOR)
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

export async function ensureAdobeSearchPage(
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

export async function selectAdobeSort(
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

export interface AdobeSortState {
  value: string | null;
  disabled: boolean;
  urlSort: string | null;
  queryMatches: boolean;
  resultCount: number;
}

export async function readAdobeSortState(page: Page, sortValue: string, query: string): Promise<AdobeSortState> {
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

export async function currentAdobeSearchState(page: Page): Promise<{ query: string; sort: string | null }> {
  return page.evaluate(() => {
    const url = new URL(location.href);
    return {
      query: (url.searchParams.get("k") || "").trim().toLowerCase(),
      sort: url.searchParams.get("order")
    };
  }).catch(() => ({ query: "", sort: null }));
}

function readAdobeResultSignature(selector: string): string {
  const nodes = document.querySelectorAll(selector);
  let signature = String(nodes.length);
  const sampleSize = Math.min(nodes.length, 8);
  for (let index = 0; index < sampleSize; index += 1) {
    signature += `|${nodes[index].getAttribute("data-content-id") || ""}`;
  }
  return signature;
}

async function waitForAdobeResultStability(
  page: Page,
  initialSignature: string,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let previousSignature = "";
  let stableRounds = 0;

  while (Date.now() < deadline) {
    const signature = await page
      .evaluate(readAdobeResultSignature, ADOBE_RESULT_SELECTOR)
      .catch(() => "");
    const changedFromInitial = Boolean(signature) && signature !== initialSignature;
    const minimumWaitElapsed = Date.now() - startedAt >= 300;

    if (signature && (changedFromInitial || minimumWaitElapsed)) {
      stableRounds = signature === previousSignature ? stableRounds + 1 : 0;
      if (stableRounds >= 2) return;
    } else {
      stableRounds = 0;
    }
    previousSignature = signature;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function prepareAdobeQuery(
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
    if (!searchInputReady) {
      throw new CrawlerStageError(
        `Input pencarian Adobe belum siap pada ${page.url()}`,
        "selector_timeout"
      );
    }
    // Keep the current result page when only the sort changes. Re-entering
    // the same query causes an unnecessary navigation and can restart Adobe's
    // challenge/session state for every sort mode.
    if (currentState.query !== query.trim().toLowerCase()) {
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
  }

  return { httpStatus };
}

export async function settleAdobeSort(
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
      const initialResultSignature = await page
        .evaluate(readAdobeResultSignature, ADOBE_RESULT_SELECTOR)
        .catch(() => "");
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
          && initialSortState.queryMatches),
        initialResultSignature
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

export async function waitForAdobeResults(
  page: Page,
  query: string,
  sortValue: string,
  timeoutMs: number,
  requireEnabled: boolean,
  initialResultSignature = ""
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
      // Adobe replaces result cards asynchronously after the sort state
      // changes. Continue as soon as the card signature settles instead of
      // sleeping for a fixed duration.
      await waitForAdobeResultStability(page, initialResultSignature, 2_000);
      return true;
    })
    .catch(() => false);
}

export async function getPageDiagnostics(page: Page, httpStatus: number | null = null): Promise<PageDiagnostics> {
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

export function classifyFailure(error: unknown, diagnostics?: PageDiagnostics): FailureType {
  if (error instanceof CrawlerStageError) return error.failureType;

  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/net::|navigation|page\.goto/i.test(text)) return "navigation_error";
  if (/404|not found/i.test(text)) return "asset_not_found";
  if (/http|status code|403|500/i.test(text)) return "http_error";
  if (/turso|sqlite|database|constraint/i.test(text)) return "database_error";
  return "unknown";
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = error.cause;
  if (cause instanceof Error && cause !== error) {
    return `${error.message}; cause: ${cause.message}`;
  }

  return error.message;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface ScrapingLocation {
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

const SCRAPING_LOCATION_CACHE_TTL_MS = 10 * 60_000;
const scrapingLocationCache = new Map<
  string,
  { value: ScrapingLocation; expiresAt: number }
>();

/**
 * Resolve the public egress IP from inside the Playwright context. A
 * Node-side request could bypass the browser proxy and report the VPS IP.
 */
export async function collectScrapingLocation(
  page: Page,
  cacheKey = "direct"
): Promise<ScrapingLocation> {
  const cached = scrapingLocationCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.value;
    scrapingLocationCache.delete(cacheKey);
  }

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

    const location: ScrapingLocation = {
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
    scrapingLocationCache.set(cacheKey, {
      value: location,
      expiresAt: Date.now() + SCRAPING_LOCATION_CACHE_TTL_MS
    });
    return location;
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

export function diagnosticMetadata(
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
