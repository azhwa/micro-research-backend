import type { FastifyInstance } from "fastify";
import {
  cancelSeedDiscoveryJob,
  createSeedDiscoveryJob,
  getSeedDiscoveryJob,
  listSeedDiscoveryJobs
} from "../services/seed-discovery.service";

interface CreateBody {
  topic?: unknown;
  category?: unknown;
  assetType?: unknown;
  locale?: unknown;
  count?: unknown;
  model?: unknown;
  forceNew?: unknown;
}

function authOrThrow(request: { auth: import("../auth").AuthContext | null }) {
  if (!request.auth) throw new Error("UNAUTHORIZED");
  return request.auth;
}

export async function seedDiscoveryRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateBody }>(
    "/api/seed-discovery",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            topic: { type: "string", maxLength: 120 },
            category: { type: "string", minLength: 1, maxLength: 40 },
            assetType: { type: "string", enum: ["images", "videos"] },
            locale: { type: "string", minLength: 1, maxLength: 20 },
            count: { type: "integer", minimum: 1, maximum: 50 },
            model: { type: "string", minLength: 1, maxLength: 120 },
            forceNew: { type: "boolean" }
          }
        }
      }
    },
    async (request, reply) => {
    const auth = authOrThrow(request);
    const result = await createSeedDiscoveryJob(auth.userId, auth, {
      topic: typeof request.body?.topic === "string" ? request.body.topic : undefined,
      category: typeof request.body?.category === "string" ? request.body.category : undefined,
      assetType: typeof request.body?.assetType === "string" ? request.body.assetType : undefined,
      locale: typeof request.body?.locale === "string" ? request.body.locale : undefined,
      count: typeof request.body?.count === "number" ? request.body.count : undefined,
      model: typeof request.body?.model === "string" ? request.body.model : undefined,
      forceNew: request.body?.forceNew === true
    });
    if (!result) {
      return reply.status(400).send({
        error: "GLOBAL_CONTEXT_EMPTY",
        message: "Belum ada data insight global. Jalankan minimal satu research terlebih dahulu."
      });
    }
    return reply.status(202).send(result);
  });

  app.get<{ Querystring: { limit?: string } }>("/api/seed-discovery", async (request) => {
    return listSeedDiscoveryJobs(authOrThrow(request), Number(request.query.limit ?? 20));
  });

  app.get<{ Params: { id: string } }>("/api/seed-discovery/:id", async (request, reply) => {
    const result = await getSeedDiscoveryJob(request.params.id, authOrThrow(request));
    return result ?? reply.status(404).send({ error: "SEED_DISCOVERY_NOT_FOUND" });
  });

  app.post<{ Params: { id: string } }>("/api/seed-discovery/:id/cancel", async (request, reply) => {
    const result = await cancelSeedDiscoveryJob(request.params.id, authOrThrow(request));
    return result ?? reply.status(404).send({ error: "SEED_DISCOVERY_NOT_FOUND" });
  });
}
