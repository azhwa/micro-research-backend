import type { Page } from "playwright";
import {
  ADOBE_CHALLENGE_WAIT_MS,
  ADOBE_RESULT_SELECTOR,
  CrawlerStageError,
  adobeSortValue,
  classifyFailure,
  errorMessage,
  getPageDiagnostics,
  numberOrNull,
  prepareAdobeQuery,
  randomJitter,
  readAdobeSortState,
  settleAdobeSort,
  type CollectedAsset,
  type SortMode
} from "./adobe-stock.core";
import { parseAdobeResultCount } from "../services/research-metrics";

export async function collectSearchResults(
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

    const srcsetUrl = (value: string | null): string | null => {
      if (!value) return null;
      const candidates = value
        .split(",")
        .map((entry) => entry.trim().split(/\s+/)[0])
        .filter(Boolean);
      return candidates[candidates.length - 1] ?? null;
    };

    const thumbnailUrl = (node: Element, image: HTMLImageElement | null): string | null => {
      const sources = Array.from(node.querySelectorAll("source"));
      const candidates = [
        image?.getAttribute("data-src"),
        image?.getAttribute("data-lazy"),
        image?.getAttribute("data-lazy-src"),
        image?.getAttribute("data-original"),
        srcsetUrl(image?.getAttribute("data-srcset") ?? null),
        srcsetUrl(image?.getAttribute("srcset") ?? null),
        ...sources.flatMap((source) => [
          source.getAttribute("data-lazy"),
          source.getAttribute("data-src"),
          srcsetUrl(source.getAttribute("data-lazy-srcset")),
          srcsetUrl(source.getAttribute("data-srcset")),
          srcsetUrl(source.getAttribute("srcset"))
        ]),
        node.querySelector('meta[itemprop="thumbnailUrl"]')?.getAttribute("content"),
        node.querySelector('meta[itemprop="contentUrl"]')?.getAttribute("content"),
        image?.currentSrc,
        image?.getAttribute("src")
      ];

      for (const candidate of candidates) {
        if (
          !candidate ||
          /^data:/i.test(candidate) ||
          /(?:spacer|placeholder|transparent)\.gif(?:$|[?#])/i.test(candidate)
        ) {
          continue;
        }
        try {
          return new URL(candidate, location.href).toString();
        } catch {
          continue;
        }
      }
      return null;
    };

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
        thumbnailUrl: thumbnailUrl(node, image),
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
