import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth";
import {
  createProxyEndpoint,
  deleteProxyEndpoint,
  listProxyEndpoints,
  setProxyEndpointStatus,
  testProxyEndpoint
} from "../services/proxy.service";

interface CreateProxyBody {
  label?: unknown;
  proxyUrl?: unknown;
}

interface StatusBody {
  status?: unknown;
}

export async function proxyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/proxies", { preHandler: requireAdmin }, async () => listProxyEndpoints());

  app.post<{ Body: CreateProxyBody }>(
    "/api/proxies",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const label = typeof request.body?.label === "string" ? request.body.label : "Proxy";
      const proxyUrl = typeof request.body?.proxyUrl === "string" ? request.body.proxyUrl : "";
      try {
        const result = await createProxyEndpoint(request.auth?.userId ?? "", label, proxyUrl);
        return reply.status(201).send(result);
      } catch (error) {
        return reply.status(400).send({
          error: "INVALID_PROXY",
          message: error instanceof Error ? error.message : "Proxy tidak valid"
        });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/proxies/:id/test",
    { preHandler: requireAdmin },
    async (request, reply) => {
      try {
        const result = await testProxyEndpoint(request.params.id);
        return result ? reply.send(result) : reply.status(404).send({ error: "PROXY_NOT_FOUND" });
      } catch (error) {
        return reply.status(502).send({
          error: "PROXY_TEST_FAILED",
          message: error instanceof Error ? error.message : "Proxy test gagal"
        });
      }
    }
  );

  app.patch<{ Params: { id: string }; Body: StatusBody }>(
    "/api/proxies/:id/status",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const status = request.body?.status;
      if (status !== "active" && status !== "disabled") {
        return reply.status(400).send({ error: "INVALID_STATUS" });
      }
      const result = await setProxyEndpointStatus(request.params.id, status);
      return result ? result : reply.status(404).send({ error: "PROXY_NOT_FOUND" });
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/proxies/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const deleted = await deleteProxyEndpoint(request.params.id);
      return deleted ? { deleted: true } : reply.status(404).send({ error: "PROXY_NOT_FOUND" });
    }
  );
}
