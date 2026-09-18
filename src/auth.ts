import { verifyToken } from "@clerk/backend";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authRequired, clerkConfigured, env } from "./config/env";

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

function bearerToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

export async function authenticateRequest(request: FastifyRequest): Promise<AuthContext | null> {
  const token = bearerToken(request);
  if (!authRequired && !clerkConfigured) {
    if (token) return null;
    return {
      userId: "dev-user",
      sessionId: null,
      organizationId: null,
      organizationRole: "org:admin",
      isAdmin: true,
      isDevBypass: true
    };
  }

  if (!token) return null;

  try {
    const payload = await verifyToken(token, {
      secretKey: env.clerkSecretKey || undefined,
      jwtKey: env.clerkJwtKey || undefined,
      audience: env.clerkAudience || undefined,
      authorizedParties: env.clerkAuthorizedParties.length ? env.clerkAuthorizedParties : undefined
    });
    const organizationRole = typeof payload.org_role === "string" ? payload.org_role : null;
    return {
      userId: payload.sub,
      sessionId: typeof payload.sid === "string" ? payload.sid : null,
      organizationId: typeof payload.org_id === "string" ? payload.org_id : null,
      organizationRole,
      // This MVP has no member/role model: every authenticated user is an admin.
      isAdmin: true,
      isDevBypass: false
    };
  } catch {
    return null;
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth) return reply.status(401).send({ error: "UNAUTHORIZED" });
  if (!request.auth.isAdmin) return reply.status(403).send({ error: "FORBIDDEN" });
}
