import type { Browser, LaunchOptions as PlaywrightLaunchOptions } from "playwright";
import path from "node:path";
import { env } from "../config/env";

type PlaywrightProxy = PlaywrightLaunchOptions["proxy"];
type CloakBrowserModule = typeof import("cloakbrowser");

// The backend is CommonJS while CloakBrowser is ESM-only. Keep the import
// native at runtime so Node does not rewrite it to require().
const nativeImport = new Function("modulePath", "return import(modulePath)") as (
  modulePath: string
) => Promise<CloakBrowserModule>;

export function cloakBrowserProfilePath(): string {
  return path.resolve(process.cwd(), env.cloakBrowserProfileDir);
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
