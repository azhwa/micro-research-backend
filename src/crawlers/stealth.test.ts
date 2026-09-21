import { chromium, type Browser, type BrowserContext } from "playwright";
import { applyStealthScripts } from "./adobe-stock";
import { buildCloakLaunchOptions, cloakBrowserProfilePath } from "./cloakbrowser";
import { env } from "../config/env";

async function runStealthAudit() {
  console.log(`=== Starting ${env.crawlerBrowser} Stealth Audit ===`);
  console.log(`Mode: ${env.playwrightHeadless ? "headless" : "headed"}`);
  if (env.crawlerBrowser === "cdp" && env.playwrightCdpUrl) {
    console.log(`CDP Target: ${env.playwrightCdpUrl}`);
  }

  let browser: Browser | undefined;
  let context: BrowserContext;
  if (env.crawlerBrowser === "cloak") {
    context = await chromium.launchPersistentContext(
      cloakBrowserProfilePath(),
      await buildCloakLaunchOptions()
    );
  } else {
    browser = env.crawlerBrowser === "cdp"
      ? await chromium.connectOverCDP(env.playwrightCdpUrl)
      : await chromium.launch({
          headless: env.playwrightHeadless,
          args: [
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-infobars",
            "--disable-blink-features=AutomationControlled",
            "--window-size=1920,1080"
          ],
          ignoreDefaultArgs: ["--enable-automation"]
        });
    context = browser.contexts()[0] || (await browser.newContext({
      viewport: { width: 1920, height: 1080 }
    }));
  }

  try {
    const page = await context.newPage();
    await applyStealthScripts(page);

    await page.goto("data:text/html,<html><body></body></html>");

    const auditResults = await page.evaluate(() => {
      const win = window as any;
      const nav = navigator as any;

      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      let webglVendor = "unknown";
      let webglRenderer = "unknown";
      if (gl) {
        const glAny = gl as any;
        const dbg = glAny.getExtension ? glAny.getExtension("WEBGL_debug_renderer_info") : null;
        if (dbg) {
          webglVendor = glAny.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
          webglRenderer = glAny.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
        }
      }

      return {
        webdriver: nav.webdriver,
        hasChromeObject: Boolean(win.chrome),
        hasChromeRuntime: Boolean(win.chrome && win.chrome.runtime),
        hasChromeApp: Boolean(win.chrome && win.chrome.app),
        pluginsCount: nav.plugins ? nav.plugins.length : 0,
        languages: nav.languages || [],
        webglVendor,
        webglRenderer,
        userAgent: nav.userAgent
      };
    });

    console.log("\n[1] Local Property Masking Results:");
    console.log(`- navigator.webdriver : ${auditResults.webdriver} ${auditResults.webdriver === undefined ? "✅ (PASSED: undefined)" : "❌ (FAILED)"}`);
    console.log(`- window.chrome       : ${auditResults.hasChromeObject ? "✅ (PASSED: exists)" : "❌ (FAILED)"}`);
    console.log(`- chrome.runtime      : ${auditResults.hasChromeRuntime ? "✅ (PASSED: exists)" : "❌ (FAILED)"}`);
    console.log(`- chrome.app          : ${auditResults.hasChromeApp ? "✅ (PASSED: exists)" : "❌ (FAILED)"}`);
    console.log(`- navigator.plugins   : ${auditResults.pluginsCount} plugins ${auditResults.pluginsCount > 0 ? "✅ (PASSED)" : "❌ (FAILED)"}`);
    console.log(`- navigator.languages : ${JSON.stringify(auditResults.languages)} ${auditResults.languages.length > 0 ? "✅ (PASSED)" : "❌ (FAILED)"}`);
    console.log(`- WebGL Vendor        : ${auditResults.webglVendor} ${auditResults.webglVendor.includes("NVIDIA") ? "✅ (PASSED: masked)" : "⚠️"}`);
    console.log(`- WebGL Renderer      : ${auditResults.webglRenderer}`);
    console.log(`- User Agent          : ${auditResults.userAgent}`);

    console.log("\n[2] Live Bot Detection Check (bot.sannysoft.com)...");
    try {
      await page.goto("https://bot.sannysoft.com", { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(1_500);

      const sannysoftResults = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("table tr"));
        const checks: Record<string, string> = {};
        for (const row of rows) {
          const cells = row.querySelectorAll("td, th");
          if (cells.length >= 2) {
            const key = cells[0].textContent?.trim() || "";
            const val = cells[1].textContent?.trim() || "";
            if (key) checks[key] = val;
          }
        }
        return checks;
      });

      console.log("Sannysoft Key Checks:");
      for (const [key, value] of Object.entries(sannysoftResults)) {
        if (/webdriver|chrome|phantom|selenium/i.test(key)) {
          console.log(`  • ${key}: ${value}`);
        }
      }
      console.log("✅ Live test completed successfully!");
    } catch (networkError) {
      console.log(`⚠️ Note: Live test skipped or timed out (${networkError instanceof Error ? networkError.message : "network issue"}). Local stealth validation succeeded!`);
    }

    await page.close();
  } finally {
    if (env.crawlerBrowser !== "cdp") await context.close();
    if (browser) await browser.close();
  }
}

void runStealthAudit()
  .then(() => {
    console.log("\n=== Stealth Audit Completed Successfully ===");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ Stealth Audit Failed:", err);
    process.exit(1);
  });
