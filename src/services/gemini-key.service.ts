import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { asc, and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { geminiApiKeys } from "../db/schema";
import { env } from "../config/env";

const KEY_PATTERN = /^[^\s]{20,512}$/;

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
  if (!ivHex || !tagHex || !encryptedHex) throw new Error("Encrypted Gemini key tidak valid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]).toString("utf8");
}

function validateKey(value: string) {
  const key = value.trim();
  if (!KEY_PATTERN.test(key)) throw new Error("Gemini API key tidak valid");
  return key;
}

function publicKey(row: typeof geminiApiKeys.$inferSelect) {
  return {
    id: row.id,
    label: row.label,
    keyHint: row.keyHint,
    status: row.status,
    failureCount: row.failureCount,
    cooldownUntil: row.cooldownUntil,
    lastUsedAt: row.lastUsedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function listGeminiApiKeys(userId: string) {
  const rows = await getDatabase().select().from(geminiApiKeys)
    .where(eq(geminiApiKeys.ownerClerkUserId, userId))
    .orderBy(asc(geminiApiKeys.createdAt));
  return rows.map(publicKey);
}

export async function createGeminiApiKey(userId: string, label: string, value: string) {
  const key = validateKey(value);
  const cleanLabel = label.trim().slice(0, 80) || "Gemini key";
  const now = new Date();
  const [row] = await getDatabase().insert(geminiApiKeys).values({
    id: `gkey_${randomUUID()}`,
    ownerClerkUserId: userId,
    label: cleanLabel,
    encryptedKey: encrypt(key),
    keyHint: key.slice(-4),
    status: "active",
    createdAt: now,
    updatedAt: now
  }).returning();
  return row ? publicKey(row) : null;
}

export async function deleteGeminiApiKey(userId: string, id: string) {
  const result = await getDatabase().delete(geminiApiKeys)
    .where(and(eq(geminiApiKeys.id, id), eq(geminiApiKeys.ownerClerkUserId, userId)));
  return result.rowsAffected > 0;
}

export async function setGeminiApiKeyStatus(userId: string, id: string, status: "active" | "disabled") {
  const [row] = await getDatabase().update(geminiApiKeys)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(geminiApiKeys.id, id), eq(geminiApiKeys.ownerClerkUserId, userId)))
    .returning();
  return row ? publicKey(row) : null;
}

export async function availableGeminiApiKeys(userId: string) {
  const now = new Date();
  const rows = await getDatabase().select().from(geminiApiKeys)
    .where(and(
      eq(geminiApiKeys.ownerClerkUserId, userId),
      eq(geminiApiKeys.status, "active"),
      or(isNull(geminiApiKeys.cooldownUntil), lt(geminiApiKeys.cooldownUntil, now))
    ))
    .orderBy(asc(geminiApiKeys.lastUsedAt), asc(geminiApiKeys.createdAt));
  return rows.map((row) => ({ id: row.id, value: decrypt(row.encryptedKey) }));
}

export async function getGeminiApiKey(userId: string, id: string) {
  const [row] = await getDatabase().select().from(geminiApiKeys)
    .where(and(eq(geminiApiKeys.id, id), eq(geminiApiKeys.ownerClerkUserId, userId)))
    .limit(1);
  return row ? { id: row.id, value: decrypt(row.encryptedKey) } : null;
}

export async function markGeminiApiKeySuccess(id: string) {
  await getDatabase().update(geminiApiKeys).set({
    status: "active",
    failureCount: 0,
    cooldownUntil: null,
    lastError: null,
    lastUsedAt: new Date(),
    updatedAt: new Date()
  }).where(eq(geminiApiKeys.id, id));
}

export async function markGeminiApiKeyFailure(id: string, reason: string, permanent = false) {
  const cooldown = permanent ? null : new Date(Date.now() + 60_000);
  await getDatabase().update(geminiApiKeys).set({
    status: permanent ? "disabled" : "active",
    failureCount: sql`${geminiApiKeys.failureCount} + 1`,
    cooldownUntil: cooldown,
    lastError: reason.slice(0, 200),
    lastUsedAt: new Date(),
    updatedAt: new Date()
  }).where(eq(geminiApiKeys.id, id));
}
