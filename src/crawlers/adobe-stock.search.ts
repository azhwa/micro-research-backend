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

function extractAdobeResults(maxAssets: number) {
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
    if (!href) continue;
    const thumbnailCandidates: Array<string | null> = [
      image?.getAttribute("data-src") ?? null,
      image?.getAttribute("data-lazy") ?? null,
      image?.getAttribute("data-lazy-src") ?? null,
      image?.getAttribute("data-original") ?? null
    ];
    const imageSrcsets = [
      image?.getAttribute("data-srcset"),
      image?.getAttribute("srcset")
    ];
    for (const srcset of imageSrcsets) {
      if (!srcset) continue;
      let lastCandidate: string | null = null;
      for (const entry of srcset.split(",")) {
        const candidate = entry.trim().split(/\s+/)[0];
        if (candidate) lastCandidate = candidate;
      }
      thumbnailCandidates.push(lastCandidate);
    }
    for (const source of Array.from(node.querySelectorAll("source"))) {
      thumbnailCandidates.push(
        source.getAttribute("data-lazy"),
        source.getAttribute("data-src")
      );
      const sourceSrcsets = [
        source.getAttribute("data-lazy-srcset"),
        source.getAttribute("data-srcset"),
        source.getAttribute("srcset")
      ];
      for (const srcset of sourceSrcsets) {
        if (!srcset) continue;
        let lastCandidate: string | null = null;
        for (const entry of srcset.split(",")) {
          const candidate = entry.trim().split(/\s+/)[0];
          if (candidate) lastCandidate = candidate;
        }
        thumbnailCandidates.push(lastCandidate);
      }
    }
    thumbnailCandidates.push(
      node.querySelector('meta[itemprop="thumbnailUrl"]')?.getAttribute("content") ?? null,
      node.querySelector('meta[itemprop="contentUrl"]')?.getAttribute("content") ?? null,
      image?.currentSrc ?? null,
      image?.getAttribute("src") ?? null
    );
    let thumbnailUrl: string | null = null;
    for (const candidate of thumbnailCandidates) {
      if (
        !candidate ||
        /^data:/i.test(candidate) ||
        /(?:spacer|placeholder|transparent)\.gif(?:$|[?#])/i.test(candidate)
      ) {
        continue;
      }
      try {
        thumbnailUrl = new URL(candidate, location.href).toString();
        break;
      } catch {
        continue;
      }
    }

    seen.add(externalId);
    items.push({
      externalId,
      title: title.trim(),
      assetUrl: new URL(href, location.href).toString(),
      thumbnailUrl,
      width: widthMeta?.getAttribute("content") || null,
      height: heightMeta?.getAttribute("content") || null,
      fileExtension: extensionMatch?.[1]?.toLowerCase() || null,
      isPremium: /premium/i.test(node.textContent || "")
    });

    if (items.length >= maxAssets) break;
  }

  return { body, items };
}

async function scrollAdobeResults(maxAssets: number): Promise<void> {
  let previousCount = 0;
  let stableRounds = 0;
  for (let step = 0; step < 24 && stableRounds < 3; step += 1) {
    const currentCount = document.querySelectorAll("[data-content-id]").length;
    if (currentCount >= maxAssets) break;
    window.scrollBy({ top: 420 + Math.random() * 180, behavior: "smooth" });
    await new Promise<void>(function(resolve) {
      setTimeout(resolve, 260 + Math.random() * 140);
    });
    const nextCount = document.querySelectorAll("[data-content-id]").length;
    stableRounds = nextCount === previousCount ? stableRounds + 1 : 0;
    previousCount = nextCount;
  }
  window.scrollTo(0, 0);
}

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
  let httpStatus: number | null = null;
  try {
    ({ httpStatus } = await prepareAdobeQuery(
      page,
      query,
      assetType,
      locale,
      sortValue,
      navigationTimeout
    ));
  } catch (error) {
    const diagnostics = await getPageDiagnostics(page, httpStatus);
    const failureType = diagnostics.botDetected ? "bot_detected" : classifyFailure(error, diagnostics);
    throw new CrawlerStageError(
      `Persiapan query ${sortMode} gagal pada ${diagnostics.url}: ${errorMessage(error)}`,
      failureType === "unknown" ? "navigation_error" : failureType
    );
  }
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

  try {
    await page.evaluate(scrollAdobeResults, limit);
  } catch (error) {
    const diagnostics = await getPageDiagnostics(page, httpStatus);
    throw new CrawlerStageError(
      `Pengambilan asset setelah sort ${sortMode} gagal pada ${diagnostics.url}: ${errorMessage(error)}`,
      diagnostics.botDetected ? "bot_detected" : "navigation_error"
    );
  }
  await randomJitter(400, 800);

  const result = await page.evaluate(extractAdobeResults, limit);

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
