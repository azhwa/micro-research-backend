import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { proxyEndpoints } from "../db/schema";
import { env } from "../config/env";

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);
const ADOBE_TEST_URL = "https://stock.adobe.com/search/images?k=cat&limit=5&search_page=1&search_type=usertyped";
const PROXY_TEST_TIMEOUT_MS = 60_000;

function encryptionKey(): Buffer {
  const value = env.geminiEncryptionKey.trim();
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("GEMINI_ENCRYPTION_KEY harus berupa 64 karakter hex atau base64 32-byte");
  }
  return key;
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(".");
}

function decrypt(value: string): string {
  const [ivHex, tagHex, encryptedHex] = value.split(".");
  if (!ivHex || !tagHex || !encryptedHex) throw new Error("Encrypted proxy URL tidak valid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}

function normalizeProxyUrl(value: string) {
  const input = value.trim();
  if (!input) throw new Error("Proxy URL wajib diisi");
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Format proxy tidak valid. Gunakan host:port atau http://host:port");
  }
  if (!PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Proxy hanya mendukung http, https, socks5, atau socks5h. socks4 belum didukung Playwright");
  }
  const defaultPort = parsed.protocol === "http:" ? "80" : parsed.protocol === "https:" ? "443" : "";
  const port = parsed.port || defaultPort;
  if (!parsed.hostname || !port) {
    throw new Error("Proxy harus memiliki host dan port");
  }
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new Error("Proxy URL tidak boleh memiliki path, query, atau hash");
  }
  const protocol = parsed.protocol === "socks5h:" ? "socks5:" : parsed.protocol;
  const hostname = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
  const hostPort = `${hostname}:${port}`;
  const proxyUrl = `${protocol}//${parsed.username ? `${parsed.username}:${parsed.password}@` : ""}${hostPort}`;
  const displayUrl = `${parsed.protocol}//${hostPort}`;
  return { proxyUrl, displayUrl };
}

function launchProxy(proxyUrl: string) {
  const parsed = new URL(proxyUrl);
  return {
    server: `${parsed.protocol}//${parsed.host}`,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {})
  };
}

function publicProxy(row: typeof proxyEndpoints.$inferSelect) {
  return {
    id: row.id,
    label: row.label,
    displayUrl: row.displayUrl,
    status: row.status,
    failureCount: row.failureCount,
    lastTestAt: row.lastTestAt,
    lastTestOk: row.lastTestOk,
    lastUsedAt: row.lastUsedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function listProxyEndpoints() {
  const rows = await getDatabase()
    .select()
    .from(proxyEndpoints)
    .orderBy(asc(proxyEndpoints.createdAt));
  return rows.map(publicProxy);
}

export async function createProxyEndpoint(userId: string, label: string, value: string) {
  const { proxyUrl, displayUrl } = normalizeProxyUrl(value);
  const now = new Date();
  const [row] = await getDatabase().insert(proxyEndpoints).values({
    id: `proxy_${randomUUID()}`,
    createdByClerkUserId: userId,
    label: label.trim().slice(0, 80) || "Proxy",
    encryptedUrl: encrypt(proxyUrl),
    displayUrl,
    status: "active",
    createdAt: now,
    updatedAt: now
  }).returning();
  return row ? publicProxy(row) : null;
}

export async function createProxyBatch(userId: string, label: string, value: string) {
  const lines = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const created: Array<ReturnType<typeof publicProxy>> = [];
  const rejected: Array<{ value: string; reason: string }> = [];

  for (const [index, line] of lines.entries()) {
    try {
      const proxy = await createProxyEndpoint(
        userId,
        lines.length > 1 ? label + " " + (index + 1) : label,
        line
      );
      if (proxy) created.push(proxy);
    } catch (error) {
      rejected.push({
        value: line,
        reason: error instanceof Error ? error.message : "Proxy tidak valid"
      });
    }
  }

  return { created, rejected, total: lines.length };
}

export async function deleteProxyEndpoint(id: string) {
  const result = await getDatabase().delete(proxyEndpoints).where(eq(proxyEndpoints.id, id));
  return result.rowsAffected > 0;
}

export async function deleteAllProxyEndpoints() {
  const result = await getDatabase().delete(proxyEndpoints);
  return result.rowsAffected;
}

export async function setProxyEndpointStatus(id: string, status: "active" | "disabled") {
  const [row] = await getDatabase().update(proxyEndpoints)
    .set({ status, updatedAt: new Date() })
    .where(eq(proxyEndpoints.id, id))
    .returning();
  return row ? publicProxy(row) : null;
}

export async function selectProxyForResearch() {
  const [row] = await getDatabase()
    .select()
    .from(proxyEndpoints)
    .where(and(
      eq(proxyEndpoints.status, "active"),
      eq(proxyEndpoints.lastTestOk, true)
    ))
    .orderBy(asc(proxyEndpoints.lastUsedAt), asc(proxyEndpoints.createdAt))
    .limit(1);
  if (!row) return null;

  await getDatabase().update(proxyEndpoints)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(proxyEndpoints.id, row.id));

  return {
    id: row.id,
    displayUrl: row.displayUrl,
    proxy: launchProxy(decrypt(row.encryptedUrl))
  };
}

export async function markProxySuccess(id: string) {
  await getDatabase().update(proxyEndpoints).set({
    failureCount: 0,
    lastTestOk: true,
    lastError: null,
    updatedAt: new Date()
  }).where(eq(proxyEndpoints.id, id));
}

export async function markProxyFailure(id: string, reason: string) {
  await getDatabase().update(proxyEndpoints).set({
    failureCount: sql`${proxyEndpoints.failureCount} + 1`,
    lastTestOk: false,
    lastError: reason.slice(0, 240),
    updatedAt: new Date()
  }).where(eq(proxyEndpoints.id, id));
}

export async function testProxyEndpoint(id: string) {
  const [row] = await getDatabase()
    .select()
    .from(proxyEndpoints)
    .where(eq(proxyEndpoints.id, id))
    .limit(1);
  if (!row) return null;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const testedAt = new Date();
  try {
    browser = await chromium.launch({
      headless: env.playwrightHeadless,
      args: ["--disable-dev-shm-usage", "--disable-gpu"],
      proxy: launchProxy(decrypt(row.encryptedUrl))
    });
    const page = await browser.newPage();
    const response = await page.goto(ADOBE_TEST_URL, {
      waitUntil: "domcontentloaded",
      timeout: PROXY_TEST_TIMEOUT_MS
    });
    await page
      .waitForSelector('[data-content-id]', { timeout: 15_000 })
      .catch(() => undefined);
    const statusCode = response?.status() ?? null;
    const pageTitle = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const assetCount = await page.locator("[data-content-id]").count().catch(() => 0);
    const html = await page.content().catch(() => "");
    const pageUsable = assetCount > 0 || /results?\s+for\b/i.test(bodyText);
    const challengeMarkers = /captcha-delivery\.com|DataDome CAPTCHA|verify you are human|access denied/i.test(
      `${pageTitle} ${bodyText.slice(0, 2_000)} ${html.slice(0, 20_000)}`
    );
    // Adobe can return HTTP 403 while still rendering a usable results page.
    // Only treat it as a bot challenge when the page has no usable results.
    const challengeDetected = !pageUsable && (statusCode === 403 || challengeMarkers);
    const acceptableStatus = statusCode !== null
      && ((statusCode >= 200 && statusCode < 400) || (statusCode === 403 && pageUsable));
    const ok = acceptableStatus && pageUsable && !challengeDetected;
    const lastError = ok
      ? null
      : `Adobe test gagal${statusCode ? ` HTTP ${statusCode}` : ""}${challengeDetected ? " (challenge/bot detected)" : " (hasil Adobe tidak ditemukan)"}`;

    const [updated] = await getDatabase().update(proxyEndpoints).set({
      lastTestAt: testedAt,
      lastTestOk: ok,
      failureCount: ok ? 0 : sql`${proxyEndpoints.failureCount} + 1`,
      lastError,
      updatedAt: new Date()
    }).where(eq(proxyEndpoints.id, id)).returning();

    return {
      proxy: updated ? publicProxy(updated) : publicProxy(row),
      ok,
      statusCode,
      pageTitle,
      pageUsable,
      assetCount,
      challengeDetected,
      message: lastError ?? `Proxy berhasil terhubung ke Adobe Stock${statusCode === 403 ? "; Adobe mengirim 403 tetapi halaman hasil tersedia" : ""}`
    };
  } catch (error) {
    const lastError = error instanceof Error ? error.message : "Proxy test gagal";
    const [updated] = await getDatabase().update(proxyEndpoints).set({
      lastTestAt: testedAt,
      lastTestOk: false,
      failureCount: sql`${proxyEndpoints.failureCount} + 1`,
      lastError: lastError.slice(0, 240),
      updatedAt: new Date()
    }).where(eq(proxyEndpoints.id, id)).returning();
    return {
      proxy: updated ? publicProxy(updated) : publicProxy(row),
      ok: false,
      statusCode: null,
      pageTitle: "",
      message: lastError
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function validateAndRemoveInvalidProxies() {
  const rows = await getDatabase()
    .select()
    .from(proxyEndpoints)
    .where(eq(proxyEndpoints.status, "active"))
    .orderBy(asc(proxyEndpoints.createdAt));
  const removed: Array<{ id: string; label: string; reason: string }> = [];
  let validCount = 0;

  for (const row of rows) {
    const result = await testProxyEndpoint(row.id);
    if (result?.ok) {
      validCount += 1;
      continue;
    }
    await deleteProxyEndpoint(row.id);
    removed.push({
      id: row.id,
      label: row.label,
      reason: result?.message ?? "Proxy test gagal"
    });
  }

  return {
    checked: rows.length,
    validCount,
    removedCount: removed.length,
    removed
  };
}
