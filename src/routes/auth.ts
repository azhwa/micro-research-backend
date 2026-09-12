import type { FastifyInstance } from "fastify";

export async function authRoutes(app: FastifyInstance): Promise<void> {
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
