import dotenv from "dotenv";

dotenv.config();

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT harus berupa angka antara 1 dan 65535");
  }

  return port;
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parsePort(process.env.PORT),
  host: process.env.HOST ?? "127.0.0.1",
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  tursoDatabaseUrl: process.env.TURSO_DATABASE_URL ?? "",
  tursoAuthToken: process.env.TURSO_AUTH_TOKEN ?? "",
  clerkSecretKey: process.env.CLERK_SECRET_KEY ?? "",
  clerkJwtKey: (process.env.CLERK_JWT_KEY ?? "").replace(/\\n/g, "\n"),
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? "",
  clerkAdminUserIds: parseCsv(process.env.CLERK_ADMIN_USER_IDS),
  clerkAuthorizedParties: (process.env.CLERK_AUTHORIZED_PARTIES ?? process.env.FRONTEND_ORIGIN ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean),
  clerkAudience: process.env.CLERK_JWT_AUDIENCE ?? "",
  geminiEncryptionKey: process.env.GEMINI_ENCRYPTION_KEY ?? ""
} as const;

export const clerkConfigured = Boolean(
  env.clerkPublishableKey && (env.clerkSecretKey || env.clerkJwtKey)
);
export const authRequired = env.nodeEnv === "production" || clerkConfigured;

if (env.nodeEnv === "production" && !clerkConfigured) {
  throw new Error(
    "Production membutuhkan CLERK_PUBLISHABLE_KEY dan salah satu CLERK_SECRET_KEY atau CLERK_JWT_KEY"
  );
}
