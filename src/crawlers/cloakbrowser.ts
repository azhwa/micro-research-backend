import type { Browser, LaunchOptions as PlaywrightLaunchOptions } from "playwright";
import path from "node:path";
import { env } from "../config/env";

type PlaywrightProxy = PlaywrightLaunchOptions["proxy"];
type CloakBrowserModule = typeof import("cloakbrowser");

const ADOBE_SEARCH_INPUT_SELECTOR =
  '.js-search-input.js-search-text-input, input[name="search"], input[name="k"], input[aria-label*="Search" i], input[type="search"]';

// The backend is CommonJS while CloakBrowser is ESM-only. Keep the import
// native at runtime so Node does not rewrite it to require().
const nativeImport = new Function("modulePath", "return import(modulePath)") as (
  modulePath: string
) => Promise<CloakBrowserModule>;

export function cloakBrowserProfilePath(): string {
  return path.resolve(process.cwd(), env.cloakBrowserProfileDir);
}

export async function bootstrapCloakBrowserProfile(
  targetUrl: string,
  proxy?: PlaywrightProxy,
  timeoutMs = 30_000
) {
  const { launchPersistentContext } = await nativeImport("cloakbrowser");
  const context = await launchPersistentContext({
    userDataDir: cloakBrowserProfilePath(),
    headless: env.playwrightHeadless,
    humanize: env.cloakBrowserHumanize,
    locale: env.cloakBrowserLocale,
    ...(env.cloakBrowserTimezone ? { timezone: env.cloakBrowserTimezone } : {}),
    ...(proxy ? { proxy } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    viewport: { width: 1920, height: 1080 }
  });

  try {
    const page = context.pages().find((candidate) => !candidate.isClosed()) ?? await context.newPage();
    const response = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs
    });
    const searchInputReady = await page
      .locator(ADOBE_SEARCH_INPUT_SELECTOR)
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);

    return {
      httpStatus: response?.status() ?? null,
      searchInputReady,
      title: await page.title().catch(() => ""),
      url: page.url()
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function buildCloakLaunchOptions(proxy?: PlaywrightProxy) {
  const { buildLaunchOptions } = await nativeImport("cloakbrowser");
  return buildLaunchOptions({
    headless: env.playwrightHeadless,
    humanize: env.cloakBrowserHumanize,
    locale: env.cloakBrowserLocale,
    ...(env.cloakBrowserTimezone ? { timezone: env.cloakBrowserTimezone } : {}),
    ...(proxy ? { proxy } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    launchOptions: {
      viewport: { width: 1920, height: 1080 }
    }
  });
}

export async function humanizeCloakBrowser(browser: Browser): Promise<void> {
  const { humanizeBrowser } = await nativeImport("cloakbrowser");
  await humanizeBrowser(browser, { humanize: true });
}
