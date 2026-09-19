import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2] ?? process.env.AUTH_PASSWORD ?? "";
if (!password) {
  console.error("Usage: npm run auth:hash -- 'your-password'");
  process.exit(1);
}

const n = 16_384;
const r = 8;
const p = 1;
const salt = randomBytes(16);
const derivedKey = scryptSync(password, salt, 64, { N: n, r, p });
console.log(`scrypt$${n}$${r}$${p}$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`);
