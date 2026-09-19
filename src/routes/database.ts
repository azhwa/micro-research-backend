import type { FastifyInstance } from "fastify";
import { checkDatabase, isDatabaseConfigured, isTursoConfigured } from "../db/client";
import { env } from "../config/env";

export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health/db", async (request, reply) => {
    if (!isDatabaseConfigured) {
      return reply.status(503).send({
        status: "not_configured",
        service: env.databaseDriver === "local" ? "sqlite_local" : "turso"
      });
    }

    try {
      const connected = await checkDatabase();

      return {
        status: connected ? "ok" : "error",
        service: env.databaseDriver === "local" ? "sqlite_local" : "turso",
        tursoConfigured: isTursoConfigured
      };
    } catch (error) {
      request.log.error(error);
      return reply.status(503).send({
        status: "error",
        service: env.databaseDriver === "local" ? "sqlite_local" : "turso"
      });
    }
  });
}
