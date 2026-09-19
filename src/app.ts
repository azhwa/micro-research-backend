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
import { proxyRoutes } from "./routes/proxies";
import { seedDiscoveryRoutes } from "./routes/seed-discovery";
import { promptRoutes } from "./routes/prompts";
import { authenticateRequest } from "./auth";
import { authConfigured, env } from "./config/env";

export function buildApp() {
  const app = Fastify({
    logger: env.nodeEnv !== "test"
  });

  app.register(cors, {
    origin: env.frontendOrigin,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    maxAge: 600
  });
  app.register(helmet);
  app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    allowList: env.nodeEnv === "development" ? ["127.0.0.1", "::1"] : undefined
  });

  app.addHook("onRequest", async (request, reply) => {
    const publicPath = request.url.startsWith("/api/health") ||
      request.url.startsWith("/api/auth/login") ||
      request.url.startsWith("/api/auth/logout");
    if (publicPath) {
      request.auth = null;
      return;
    }
    const auth = await authenticateRequest(request);
    if (!auth) {
      return reply.status(authConfigured || env.nodeEnv === "production" ? 401 : 503).send({
        error: authConfigured || env.nodeEnv === "production" ? "UNAUTHORIZED" : "AUTH_NOT_CONFIGURED"
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
  app.register(proxyRoutes);
  app.register(seedDiscoveryRoutes);
  app.register(promptRoutes);

  app.setErrorHandler((error, request, reply) => {
    request.log.error(
      {
        err: error,
        method: request.method,
        url: request.url
      },
      "Unhandled request error"
    );
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
