import type { Page, Route } from "playwright";

export interface AdobeResourcePolicy {
  setSearchMode(): void;
  setDetailMode(): void;
  dispose(): Promise<void>;
}

const HEAVY_RESOURCE_TYPES = new Set(["image", "font", "media"]);

export async function installAdobeResourcePolicy(page: Page): Promise<AdobeResourcePolicy> {
  let mode: "search" | "detail" = "search";

  const handler = async (route: Route) => {
    // Keep the complete search page available while Adobe inserts/lazy-loads
    // result cards. Heavy resources are blocked only during keyword detail
    // extraction, after the card metadata has already been collected.
    if (mode === "detail" && HEAVY_RESOURCE_TYPES.has(route.request().resourceType())) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  };

  await page.route("**/*", handler);

  return {
    setSearchMode() {
      mode = "search";
    },
    setDetailMode() {
      mode = "detail";
    },
    async dispose() {
      await page.unroute("**/*", handler).catch(() => undefined);
    }
  };
}
