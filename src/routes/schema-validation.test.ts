import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function assertValidation(response: { statusCode: number; json: () => unknown }): void {
  assert.equal(response.statusCode, 400);
  const body = response.json() as { error?: string; message?: string };
  assert.equal(body.error, "VALIDATION_ERROR");
  assert.equal(body.message, "Request tidak valid");
}

async function run(): Promise<void> {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_DRIVER: process.env.DATABASE_DRIVER,
    LOCAL_DATABASE_PATH: process.env.LOCAL_DATABASE_PATH,
    PORT: process.env.PORT,
    HOST: process.env.HOST
  };
  let tempDirectory: string | undefined;
  let app: FastifyInstance | undefined;
  let closeDatabase: (() => Promise<void>) | undefined;

  try {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "micro-research-validation-"));
    process.env.NODE_ENV = "development";
    process.env.DATABASE_DRIVER = "local";
    process.env.LOCAL_DATABASE_PATH = path.join(tempDirectory, "validation.sqlite");
    process.env.PORT = "3317";
    process.env.HOST = "127.0.0.1";

    const { buildApp } = await import("../app");
    const database = await import("../db/client");
    closeDatabase = async () => {
      await Promise.resolve(database.localClient.close());
    };
    const { initializeLocalDatabase, getDatabase } = database;
    const { researchRuns } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");

    await initializeLocalDatabase();
    app = buildApp();

    {
    const researchWithoutKeyword = await app.inject({ method: "POST", url: "/api/research-runs", payload: { assetType: "images", locale: "en-GB" } });
    assertValidation(researchWithoutKeyword);

    const researchWithUnknownAssetType = await app.inject({ method: "POST", url: "/api/research-runs", payload: { keyword: "cat", assetType: "audio" } });
    assertValidation(researchWithUnknownAssetType);

    const primaryResearchWithoutKeyword = await app.inject({ method: "POST", url: "/api/research-runs", payload: { mode: "primary", assetType: "images" } });
    assert.equal(primaryResearchWithoutKeyword.statusCode, 201);
    const primaryRun = primaryResearchWithoutKeyword.json() as { id: string };
    await getDatabase().delete(researchRuns).where(eq(researchRuns.id, primaryRun.id));

    const fastResearchWithoutKeyword = await app.inject({ method: "POST", url: "/api/research-runs", payload: { mode: "fast", assetType: "images" } });
    assertValidation(fastResearchWithoutKeyword);

    const researchWithInvalidLimit = await app.inject({ method: "POST", url: "/api/research-runs", payload: { keyword: "cat", assetsPerQuery: 101 } });
    assertValidation(researchWithInvalidLimit);

    const queueWithInvalidAssetType = await app.inject({ method: "POST", url: "/api/research-queue", payload: { keyword: "cat", assetType: "audio" } });
    assertValidation(queueWithInvalidAssetType);

    for (const [label, payload] of [["missing", {}], ["null", { items: null }], ["object", { items: { keyword: "cat" } }], ["empty", { items: [] }]] as const) {
      const invalidResearchBatch: Awaited<ReturnType<FastifyInstance["inject"]>> = await app.inject({ method: "POST", url: "/api/research-queue/batch", payload });
      assert.equal(invalidResearchBatch.statusCode, 400, `research batch ${label}: ${invalidResearchBatch.body}`);
      assertValidation(invalidResearchBatch);
    }

    const researchBatchWithInvalidItem = await app.inject({ method: "POST", url: "/api/research-queue/batch", payload: { items: [{ keyword: "cat", assetType: "images" }, { keyword: "dog", assetType: "audio" }] } });
    assert.equal(researchBatchWithInvalidItem.statusCode, 201);
    const researchBatchBody = researchBatchWithInvalidItem.json() as { rejected?: Array<{ keyword: string; reason: string }> };
    assert.deepEqual(researchBatchBody.rejected, [{ keyword: "dog", reason: "INVALID_ASSET_TYPE" }]);

    for (const payload of [{}, { items: null }, { items: { keyword: "cat" } }, { items: [] }]) {
      const invalidPromptBatch = await app.inject({ method: "POST", url: "/api/prompt-queue/batch", payload });
      assertValidation(invalidPromptBatch);
    }

    const promptBatchOverLimit = await app.inject({ method: "POST", url: "/api/prompt-queue/batch", payload: { items: Array.from({ length: 21 }, (_, index) => ({ keyword: `keyword-${index}` })) } });
    assert.equal(promptBatchOverLimit.statusCode, 200);
    const promptBatchBody = promptBatchOverLimit.json() as { rejected?: Array<{ reason: string }> };
    assert.equal(promptBatchBody.rejected?.length, 1);
    assert.equal(promptBatchBody.rejected?.[0]?.reason, "MAX_BATCH_20");

    const promptBatchWithInvalidItems = await app.inject({ method: "POST", url: "/api/prompt-queue/batch", payload: { items: [{ keyword: "valid", researchAssetType: "images" }, { keyword: "invalid", researchAssetType: "audio" }, null] } });
    assert.equal(promptBatchWithInvalidItems.statusCode, 200);
    const promptInvalidItemsBody = promptBatchWithInvalidItems.json() as { created?: Array<{ keyword: string }>; rejected?: Array<{ reason: string }> };
    assert.deepEqual(promptInvalidItemsBody.created?.map((item) => item.keyword), ["valid"]);
    assert.deepEqual(promptInvalidItemsBody.rejected?.map((item) => item.reason), ["INVALID_ASSET_TYPE", "INVALID_ITEM"]);

    const promptBatchWithInvalidBeforeLimit = await app.inject({ method: "POST", url: "/api/prompt-queue/batch", payload: { items: [{ keyword: "invalid-first", researchAssetType: "audio" }, ...Array.from({ length: 20 }, (_, index) => ({ keyword: `limit-${index}` }))] } });
    assert.equal(promptBatchWithInvalidBeforeLimit.statusCode, 200);
    const promptLimitBody = promptBatchWithInvalidBeforeLimit.json() as { created?: Array<{ keyword: string }>; rejected?: Array<{ keyword: string; reason: string }> };
    assert.equal(promptLimitBody.created?.length, 19);
    assert.deepEqual(promptLimitBody.rejected?.map((item) => item.reason), ["MAX_BATCH_20", "INVALID_ASSET_TYPE"]);
    assert.equal(promptLimitBody.rejected?.[0]?.keyword, "limit-19");
    assert.equal(promptLimitBody.rejected?.[1]?.keyword, "invalid-first");

    const promptBatchWithNullableObservedAt = await app.inject({ method: "POST", url: "/api/prompt-queue/batch", payload: { items: [{ keyword: "nullable-date", sourceObservedAt: null }] } });
    assert.equal(promptBatchWithNullableObservedAt.statusCode, 200);
    assert.deepEqual(promptBatchWithNullableObservedAt.json().rejected, []);

    const promptBatchWithInvalidObservedAt = await app.inject({ method: "POST", url: "/api/prompt-queue/batch", payload: { items: [{ keyword: "bad-date", sourceObservedAt: 123 }] } });
    assert.equal(promptBatchWithInvalidObservedAt.statusCode, 200);
    assert.deepEqual(promptBatchWithInvalidObservedAt.json().rejected, [{ keyword: "bad-date", reason: "INVALID_SOURCE_OBSERVED_AT" }]);

    const queueWithoutKeyword = await app.inject({ method: "POST", url: "/api/research-queue", payload: { category: "animals" } });
    assertValidation(queueWithoutKeyword);

    const promptQueueWithNullObservedAt = await app.inject({ method: "POST", url: "/api/prompt-queue", payload: { keyword: "cat", sourceObservedAt: null } });
    assert.equal(promptQueueWithNullObservedAt.statusCode, 200);

    const loginWithEmptyPassword = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "demo", password: "" } });
    assertValidation(loginWithEmptyPassword);

    const promptWithInvalidCount = await app.inject({ method: "POST", url: "/api/prompt-generations", payload: { seed: "cat", count: 21 } });
    assertValidation(promptWithInvalidCount);

    const seedDiscoveryWithInvalidAssetType = await app.inject({ method: "POST", url: "/api/seed-discovery", payload: { topic: "nature", assetType: "audio" } });
    assertValidation(seedDiscoveryWithInvalidAssetType);

    const promptQueueWithInvalidOutputType = await app.inject({ method: "POST", url: "/api/prompt-queue", payload: { keyword: "cat", promptOutputType: "audio" } });
    assertValidation(promptQueueWithInvalidOutputType);

    const promptWithInvalidAssetType = await app.inject({ method: "POST", url: "/api/prompt-generations", payload: { seed: "cat", assetType: "audio" } });
    assertValidation(promptWithInvalidAssetType);

      console.log("schema validation tests passed");
    }
  } finally {
    if (app) await app.close();
    if (closeDatabase) await closeDatabase();
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

void run();
