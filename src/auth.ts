import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authConfigured, env } from "./config/env";

const SESSION_COOKIE = "stockscope_session";
const SESSION_TTL_SECONDS = env.authSessionTtlHours * 60 * 60;

export interface AuthContext {
  userId: string;
  sessionId: string | null;
  organizationId: string | null;
  organizationRole: string | null;
  isAdmin: boolean;
  isDevBypass: boolean;
}

declare module "fastify" {
  interface FastifyRequest { auth: AuthContext | null; }
}

function cookieValue(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie ?? "";
  const prefix = `${name}=`;
  const value = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : null;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

function sign(value: string): string {
  return createHmac("sha256", env.authSessionSecret).update(value).digest("base64url");
}

function createSessionToken(): { token: string; sessionId: string } {
  const sessionId = randomBytes(18).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${env.authUserId}.${sessionId}.${expiresAt}`;
  return { token: `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`, sessionId };
}

function contextFromToken(token: string): AuthContext | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  try {
    const payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const expected = sign(payload);
    const providedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) return null;

    const [userId, sessionId, expiresAtText] = payload.split(".");
    const expiresAt = Number(expiresAtText);
    if (!userId || !sessionId || !Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return null;
    if (userId !== env.authUserId) return null;

    return {
      userId,
      sessionId,
      organizationId: null,
      organizationRole: "org:admin",
      isAdmin: true,
      isDevBypass: false
    };
  } catch {
    return null;
  }
}

export function setSessionCookie(reply: FastifyReply): void {
  const { token } = createSessionToken();
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (env.nodeEnv === "production") attributes.push("Secure");
  reply.header("set-cookie", attributes.join("; "));
}

export function clearSessionCookie(reply: FastifyReply): void {
  const attributes = [`${SESSION_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (env.nodeEnv === "production") attributes.push("Secure");
  reply.header("set-cookie", attributes.join("; "));
}

function verifyPassword(password: string, encodedHash: string): boolean {
  const [algorithm, nText, rText, pText, salt, hash] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !nText || !rText || !pText || !salt || !hash) return false;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  try {
    const derived = scryptSync(password, Buffer.from(salt, "base64url"), Buffer.from(hash, "base64url").length, { N: n, r, p });
    const expected = Buffer.from(hash, "base64url");
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function authenticateCredentials(username: string, password: string): boolean {
  return username === env.authUsername && verifyPassword(password, env.authPasswordHash);
}

export async function authenticateRequest(request: FastifyRequest): Promise<AuthContext | null> {
  if (!authConfigured) {
    if (env.nodeEnv === "production") return null;
    return {
      userId: "dev-user",
      sessionId: null,
      organizationId: null,
      organizationRole: "org:admin",
      isAdmin: true,
      isDevBypass: true
    };
  }

  const token = cookieValue(request, SESSION_COOKIE) ?? bearerToken(request);
  return token ? contextFromToken(token) : null;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth) return reply.status(401).send({ error: "UNAUTHORIZED" });
  if (!request.auth.isAdmin) return reply.status(403).send({ error: "FORBIDDEN" });
}
