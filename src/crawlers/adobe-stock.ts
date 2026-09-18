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

function searchUrl(query: string, assetType: string, sortMode?: SortMode, locale?: string): string {
  const url = new URL(searchPath(assetType, locale), "https://stock.adobe.com");
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
  const collected: Array<{ baseKeyword: string; suggestion: string; position: number }> = [];
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
              position: suggestionIndex + 1
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
    collected.push({ baseKeyword: seed, suggestion: seed, position: 1 });
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
  const response = await page.goto(searchUrl(query, assetType, sortMode, locale), {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeout
  });
  const httpStatus = response?.status() ?? null;

  const resultSelector = 'a.js-search-result-thumbnail[data-content-id], div[data-content-id]';
  // Fast mode reduces query count, but headed Chromium on the VPS can still
  // need more time for Adobe's result cards to be inserted after the HTML
  // shell and result count have already appeared.
  const resultSelectorTimeout = Math.max(selectorTimeout, 20_000);
  const selectorFound = await page
    .waitForSelector(resultSelector, { timeout: resultSelectorTimeout })
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

  await page.evaluate(async () => {
    const steps = 3;
    for (let i = 0; i < steps; i++) {
      window.scrollBy({ top: 300 + Math.random() * 180, behavior: "smooth" });
      await new Promise((r) => setTimeout(r, 140 + Math.random() * 90));
    }
  });
  await randomJitter(400, 800);

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
      if (run.autocompleteEnabled) {
        // Autocomplete must start from the clean Adobe search page. The
        // extension does not open a query URL first; it types into this page
        // and reads the resulting DOM panel.
        const response = await page.goto(searchPageUrl(run.assetType, run.locale), {
          waitUntil: "domcontentloaded",
          timeout: navigationTimeout
        });
        const httpStatus = response?.status() ?? null;
        await page
          .locator(AUTOCOMPLETE_INPUT_SELECTOR)
          .first()
          .waitFor({ state: "visible", timeout: Math.min(selectorTimeout, 5_000) })
          .catch(() => undefined);
        const diagnostics = await getPageDiagnostics(page, httpStatus);
        if (diagnostics.botDetected) {
          await appendResearchEvent(
            researchRunId,
            "warning",
            "search_page_diagnostic",
            `Halaman autocomplete Adobe berisi challenge${httpStatus !== null ? ` (HTTP ${httpStatus})` : ""}; crawler memakai fallback`,
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
          rows: [{ baseKeyword: run.seedKeyword, suggestion: run.seedKeyword, position: 1 }],
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
      await persistSuggestions(researchRunId, suggestionRows, run.locale);
      await appendResearchEvent(
        researchRunId,
        suggestionResult.source === "adobe_autocomplete" ? "success" : "info",
        "suggestions_collected",
        suggestionResult.source === "adobe_autocomplete"
          ? `${suggestionRows.length} suggestion Adobe berhasil ditemukan`
          : `Research dilanjutkan dengan seed keyword “${run.seedKeyword}”`,
        { count: suggestionRows.length, source: suggestionResult.source }
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
              run.locale,
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
        const page = await context.newPage();
        try {
          await executeScrapingSession(page);
          if (!requestHandled || !requestSucceeded) {
            throw new Error("Crawler gagal menyelesaikan request Adobe Stock via CDP");
          }
          if (selectedProxy) await markProxySuccess(selectedProxy.id);
        } finally {
          await page.close().catch(() => {});
          await browser.close().catch(() => {});
        }
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

    const startUrl = searchUrl(run.seedKeyword, run.assetType, undefined, run.locale);
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
