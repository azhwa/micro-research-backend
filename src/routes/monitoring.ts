import type { FastifyInstance } from "fastify";
import { getMonitoringSnapshot } from "../services/monitoring.service";
import { requireAdmin } from "../auth";

export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/monitoring", { preHandler: requireAdmin }, async () => getMonitoringSnapshot());
}
