import { z } from "zod";

const TRUE_ENV_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["false", "0", "no", "off", ""]);

function envBoolean(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return value;
    }
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (TRUE_ENV_VALUES.has(normalized)) return true;
    if (FALSE_ENV_VALUES.has(normalized)) return false;
    return value;
  }, z.boolean());
}

const envSchema = z.object({
  BACKEND_BASE_URL: z.string().default("http://backend:8000"),
  GATEWAY_SERVICE_TOKEN: z.string().optional(),
  GATEWAY_OPS_TOKEN: z.string().optional(),
  GATEWAY_OPS_HOST: z.string().default("0.0.0.0"),
  GATEWAY_OPS_PORT: z.coerce.number().int().positive().default(8090),
  BAILEYS_AUTH_DIR: z.string().default("/data/baileys-auth"),
  GATEWAY_PRINT_QR: z.coerce.boolean().default(true),
  GATEWAY_SESSION_NAME: z.string().default("kuuna-gateway"),
  GATEWAY_SYNC_FULL_HISTORY: envBoolean(false),
  GATEWAY_PROCESS_HISTORY_SYNC: envBoolean(false),
  LOG_LEVEL: z.string().default("info"),
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default("dev"),
});

export type GatewaySettings = z.infer<typeof envSchema>;

let cachedSettings: GatewaySettings | undefined;

export function getSettings(): GatewaySettings {
  cachedSettings ??= envSchema.parse(process.env);
  return cachedSettings;
}

export function resetSettingsForTests(): void {
  cachedSettings = undefined;
}
