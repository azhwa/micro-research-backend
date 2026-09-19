import { GoogleGenAI } from "@google/genai";
import {
  availableGeminiApiKeys,
  getGeminiApiKey,
  markGeminiApiKeyFailure,
  markGeminiApiKeySuccess
} from "./gemini-key.service";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

const recommendationSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    overallAssessment: { type: "string" },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          assetConcept: { type: "string" },
          format: { type: "string" },
          titleIdeas: { type: "array", items: { type: "string" } },
          keywordCluster: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
          demandSignal: { type: "string" },
          competitionSignal: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] }
        },
        required: [
          "assetConcept",
          "format",
          "titleIdeas",
          "keywordCluster",
          "rationale",
          "demandSignal",
          "competitionSignal",
          "confidence"
        ]
      }
    },
    cautions: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "overallAssessment", "recommendations", "cautions"]
};

function errorStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  const match = String(error).match(/\b(401|403|429|5\d\d)\b/);
  return match ? Number(match[1]) : null;
}

function safeReason(error: unknown) {
  const status = errorStatus(error);
  if (status === 401 || status === 403) return "API key ditolak Gemini";
  if (status === 429) return "Rate limit Gemini; key cooldown 60 detik";
  if (status && status >= 500) return `Gemini server error ${status}`;
  return "Permintaan Gemini gagal";
}

function parseResponse(value: string | undefined) {
  if (!value) throw new Error("Gemini mengembalikan respons kosong");
  const normalized = value.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(normalized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Format respons Gemini tidak valid");
  }
  return parsed;
}

function promptForContext(context: unknown) {
  return [
    "Anda adalah analis riset microstock untuk Adobe Stock.",
    "Berikan rekomendasi ide asset yang realistis berdasarkan data yang tersedia.",
    "Jangan mengklaim jumlah download aktual, angka penjualan, atau tren yang tidak ada di data.",
    "Bedakan sinyal demand dan competition dari fakta. Jika data lemah, turunkan confidence.",
    "Kembalikan hanya JSON sesuai schema yang diberikan, tanpa markdown.",
    "Sertakan 3 sampai 8 rekomendasi asset yang konkret, bukan sekadar keyword.",
    "DATA RISET:",
    JSON.stringify(context)
  ].join("\n");
}

export async function generateStructuredWithUserGeminiKey(
  userId: string,
  model: string,
  prompt: string,
  responseSchema: unknown,
  maxOutputTokens = 4_000
) {
  const keys = await availableGeminiApiKeys(userId);
  if (!keys.length) {
    throw new Error("NO_GEMINI_API_KEY");
  }

  let lastReason = "Permintaan Gemini gagal";
  for (const key of keys) {
    try {
      const client = new GoogleGenAI({ apiKey: key.value });
      const response = await client.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.3,
          maxOutputTokens,
          responseMimeType: "application/json",
          responseSchema
        }
      });
      const parsed = parseResponse(response.text);
      await markGeminiApiKeySuccess(key.id);
      return parsed;
    } catch (error) {
      const reason = safeReason(error);
      const status = errorStatus(error);
      await markGeminiApiKeyFailure(key.id, reason, status === 401 || status === 403);
      lastReason = reason;
    }
  }

  throw new Error(lastReason);
}

export async function generateWithUserGeminiKey(userId: string, model: string, context: unknown) {
  return generateStructuredWithUserGeminiKey(
    userId,
    model,
    promptForContext(context),
    recommendationSchema,
    4_000
  );
}

export async function testUserGeminiKey(userId: string, model = DEFAULT_GEMINI_MODEL, keyId?: string) {
  const key = keyId ? await getGeminiApiKey(userId, keyId) : (await availableGeminiApiKeys(userId))[0];
  if (!key) throw new Error("NO_GEMINI_API_KEY");
  try {
    const client = new GoogleGenAI({ apiKey: key.value });
    const response = await client.models.generateContent({
      model,
      contents: "Reply with exactly: OK",
      config: { temperature: 0, maxOutputTokens: 10 }
    });
    await markGeminiApiKeySuccess(key.id);
    return { ok: true, response: response.text?.trim() || "" };
  } catch (error) {
    const status = errorStatus(error);
    const reason = safeReason(error);
    await markGeminiApiKeyFailure(key.id, reason, status === 401 || status === 403);
    throw new Error(reason);
  }
}
