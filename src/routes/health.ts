import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({
    status: "ok",
    service: "microstock-research-backend",
    timestamp: new Date().toISOString()
  }));
}
