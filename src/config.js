import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader so the app runs without extra packages.
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = process.env;
const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes)$/i.test(v));

export const config = {
  root,
  port: Number(env.PORT || 3000),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ""),
  adminPassword: env.ADMIN_PASSWORD || "",
  dataDir: path.resolve(root, env.DATA_DIR || "data"),
  shopFile: path.resolve(root, env.SHOP_CONFIG || "config/shop.json"),
  anthropicModel: env.AGENT_MODEL || "claude-opus-5-5",
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || "",
    authToken: env.TWILIO_AUTH_TOKEN || "",
    phoneNumber: env.TWILIO_PHONE_NUMBER || "",
    validateSignatures: bool(env.TWILIO_VALIDATE_SIGNATURES, true),
  },
  ownerMobile: env.OWNER_MOBILE || "",
  ringOwnerFirstSeconds: Number(env.RING_OWNER_FIRST_SECONDS || 0),
  notifyOwnerBySms: bool(env.NOTIFY_OWNER_BY_SMS, true),
  smsCustomerConfirmations: bool(env.SMS_CUSTOMER_CONFIRMATIONS, true),
  voice: {
    language: env.VOICE_LANGUAGE || "en-GB",
    ttsProvider: env.VOICE_TTS_PROVIDER || "ElevenLabs",
    name: env.VOICE_NAME || "",
  },
};

export function loadShop() {
  return JSON.parse(fs.readFileSync(config.shopFile, "utf8"));
}
