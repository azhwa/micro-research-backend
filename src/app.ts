import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { databaseRoutes } from "./routes/database";
import { healthRoutes } from "./routes/health";
import { insightsRoutes } from "./routes/insights";
import { comparisonRoutes } from "./routes/comparison";
import { monitoringRoutes } from "./routes/monitoring";
import { aiRoutes } from "./routes/ai";
import { authRoutes } from "./routes/auth";
import { researchRoutes } from "./routes/research";
import { geminiRoutes } from "./routes/gemini";
import { authenticateRequest } from "./auth";
import { clerkConfigured, env } from "./config/env";

export function buildApp() {
  const app = Fastify({
    logger: env.nodeEnv !== "test"
  });

  app.register(cors, {
    origin: env.frontendOrigin,
    allowedHeaders: ["Content-Type", "Authorization"]
  });
  app.register(helmet);
  app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    allowList: env.nodeEnv === "development" ? ["127.0.0.1", "::1"] : undefined
  });

  app.addHook("onRequest", async (request, reply) => {
    const publicPath = request.url.startsWith("/api/health");
    if (publicPath) {
      request.auth = null;
      return;
    }
    const auth = await authenticateRequest(request);
    if (!auth) {
      return reply.status(clerkConfigured || env.nodeEnv === "production" ? 401 : 503).send({
        error: clerkConfigured || env.nodeEnv === "production" ? "UNAUTHORIZED" : "AUTH_NOT_CONFIGURED"
      });
    }
    request.auth = auth;
  });

  app.register(healthRoutes);
  app.register(databaseRoutes);
  app.register(insightsRoutes);
  app.register(comparisonRoutes);
  app.register(monitoringRoutes);
  app.register(aiRoutes);
  app.register(authRoutes);
  app.register(researchRoutes);
  app.register(geminiRoutes);

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    return reply.status(500).send({
      error: "INTERNAL_SERVER_ERROR",
      message:
        env.nodeEnv === "production"
          ? "Internal server error"
          : error instanceof Error
            ? error.message
            : "Unknown error"
    });
  });

  return app;
}
