import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";
const BROWSER_UNIT = process.env.BROWSER_UNIT || "adobe-browser.service";
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 15_000);
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 8_000);
const MAX_PAGE_TARGETS = Number(process.env.MAX_PAGE_TARGETS || 8);
const FAILURE_THRESHOLD = Number(process.env.FAILURE_THRESHOLD || 2);
const RESTART_COOLDOWN_MS = Number(process.env.RESTART_COOLDOWN_MS || 60_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(pathname, timeoutMs = PROBE_TIMEOUT_MS) {
  const response = await fetch(new URL(pathname, CDP_URL), {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`CDP HTTP ${response.status} pada ${pathname}`);
  return response.json();
}

async function countMainChromeProcesses() {
  const { stdout } = await execFileAsync("ps", ["-eo", "args="]);
  return stdout
    .split("\n")
    .filter((line) =>
      line.includes("chrome") &&
      line.includes("--remote-debugging-port=9222") &&
      line.includes("--user-data-dir=") &&
      !line.includes("--type=")
    ).length;
}

async function probe() {
  const version = await fetchJson("/json/version");
  const targets = await fetchJson("/json/list");
  const pageTargets = Array.isArray(targets)
    ? targets.filter((target) => target?.type === "page")
    : [];
  const mainChromeProcesses = await countMainChromeProcesses();

  if (mainChromeProcesses !== 1) {
    throw new Error(`jumlah proses utama Chrome tidak valid: ${mainChromeProcesses}`);
  }
  if (pageTargets.length > MAX_PAGE_TARGETS) {
    throw new Error(`jumlah tab page melebihi batas: ${pageTargets.length}/${MAX_PAGE_TARGETS}`);
  }

  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: PROBE_TIMEOUT_MS });
  try {
    const contexts = browser.contexts();
    const pages = contexts.reduce((count, context) => count + context.pages().length, 0);
    return {
      browser: version.Browser ?? "unknown",
      contexts: contexts.length,
      pages,
      pageTargets: pageTargets.length,
      mainChromeProcesses
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function restartBrowser(reason) {
  console.error(`[cdp-watchdog] restarting ${BROWSER_UNIT}: ${reason}`);
  await execFileAsync("systemctl", ["restart", BROWSER_UNIT]);
  await sleep(15_000);
}

let failures = 0;
let lastRestartAt = 0;

console.log(`[cdp-watchdog] monitoring ${CDP_URL} via ${BROWSER_UNIT}`);

while (true) {
  try {
    const result = await probe();
    if (failures > 0) console.log("[cdp-watchdog] CDP probe recovered");
    failures = 0;
    console.log(`[cdp-watchdog] healthy browser=${result.browser} contexts=${result.contexts} pages=${result.pages} pageTargets=${result.pageTargets}`);
  } catch (error) {
    failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cdp-watchdog] probe failed (${failures}/${FAILURE_THRESHOLD}): ${message}`);
    if (failures >= FAILURE_THRESHOLD && Date.now() - lastRestartAt >= RESTART_COOLDOWN_MS) {
      try {
        await restartBrowser(message);
        lastRestartAt = Date.now();
        failures = 0;
      } catch (restartError) {
        const restartMessage = restartError instanceof Error ? restartError.message : String(restartError);
        console.error(`[cdp-watchdog] browser restart failed: ${restartMessage}`);
      }
    }
  }
  await sleep(CHECK_INTERVAL_MS);
}
