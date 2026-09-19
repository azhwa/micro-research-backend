import type { FastifyInstance } from "fastify";
import {
  authenticateCredentials,
  clearSessionCookie,
  setSessionCookie
} from "../auth";

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LoginBody }>("/api/auth/login", async (request, reply) => {
    const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";

    if (!username || !password || !authenticateCredentials(username, password)) {
      return reply.status(401).send({ error: "INVALID_CREDENTIALS", message: "Username atau password salah" });
    }

    setSessionCookie(reply);
    return {
      userId: process.env.AUTH_USER_ID ?? "local-user",
      sessionId: null,
      organizationId: null,
      organizationRole: "org:admin",
      isAdmin: true,
      isDevBypass: false
    };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    clearSessionCookie(reply);
    return { loggedOut: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.auth) return reply.status(401).send({ error: "UNAUTHORIZED" });
    return {
      userId: request.auth.userId,
      sessionId: request.auth.sessionId,
      organizationId: request.auth.organizationId,
      organizationRole: request.auth.organizationRole,
      isAdmin: request.auth.isAdmin,
      isDevBypass: request.auth.isDevBypass
    };
  });
}
