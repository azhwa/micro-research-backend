import type { FastifyInstance } from "fastify";
import { checkDatabase, isDatabaseConfigured } from "../db/client";

export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health/db", async (request, reply) => {
    if (!isDatabaseConfigured) {
      return reply.status(503).send({
        status: "not_configured",
        service: "turso"
      });
    }

    try {
      const connected = await checkDatabase();

      return {
        status: connected ? "ok" : "error",
        service: "turso"
      };
    } catch (error) {
      request.log.error(error);
      return reply.status(503).send({
        status: "error",
        service: "turso"
      });
    }
  });
}
