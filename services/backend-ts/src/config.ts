import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);
const absoluteContainerPath = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).refine((value) => value.startsWith("/"), "must be an absolute container path").default("/runtime-data/pi-auth.json"),
);

const DEV_BETTER_AUTH_SECRET = "dev-insecure-better-auth-secret-local";

const envSchema = z.object({
  APP_ENV: z.string().default("dev"),
  HOST: z.string().default("::"),
  PORT: z.coerce.number().int().positive().default(8010),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://postgres:postgres@127.0.0.1:5432/kuuna"),
  REDIS_URL: z.string().default("redis://localhost:6379/0"),
  SENTRY_DSN: z.string().optional(),
  INTERNAL_OPS_TOKEN: z.string().optional(),
  REQUIRED_ADMIN_EMAIL: z.string().email().default("admin@kuuna.ai"),
  DASHBOARD_REQUIRED_ADMIN_PASSWORD: z.string().default("admin123456!"),
  DASHBOARD_DEV_RESET_BOOTSTRAP_ADMIN_PASSWORD: z.coerce.boolean().default(false),
  BETTER_AUTH_SECRET: z.string().default(DEV_BETTER_AUTH_SECRET),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:8000"),
  DASHBOARD_ORIGIN: z.string().url().default("http://localhost:3000"),
  AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  AUTH_LOCKOUT_THRESHOLD: z.coerce.number().int().positive().default(5),
  AUTH_LOCKOUT_SECONDS: z.coerce.number().int().positive().default(900),
  AUTH_PASSWORD_MIN_LENGTH: z.coerce.number().int().positive().default(12),
  AUTH_PASSWORD_MAX_CONSECUTIVE: z.coerce.number().int().positive().default(3),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(20),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_TIMEOUT_SECONDS: z.coerce.number().positive().default(30),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_AUDIO_TRANSCRIPTION_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  PI_TRANSPORT: z.enum(["sse", "websocket", "websocket-cached", "auto"]).default("websocket-cached"),
  PI_AUTH_HOST_PATH: optionalNonEmptyString,
  PI_AUTH_CONTAINER_PATH: absoluteContainerPath,
  S3_ENDPOINT_URL: z.string().optional(),
  S3_BUCKET: z.string().default("kuuna-dev"),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  MEDIA_PROCESSING_ENABLED: z.coerce.boolean().default(true),
  MEDIA_DOWNLOAD_TIMEOUT_SECONDS: z.coerce.number().positive().default(20),
  GATEWAY_BASE_URL: z.string().default("http://gateway:8090"),
  GATEWAY_SERVICE_TOKEN: z.string().optional(),
  GATEWAY_OPS_TOKEN: z.string().optional(),
  OUTBOUND_DISPATCH_TIMEOUT_SECONDS: z.coerce.number().positive().default(10),
  TODO_EXPORT_ENABLED: z.coerce.boolean().default(false),
  TODO_EXPORT_WEBHOOK_URL: z.string().optional(),
  TODO_EXPORT_TIMEOUT_SECONDS: z.coerce.number().positive().default(20),
  DOCKER_CLI_PATH: z.string().default("docker"),
  TEMPLATE_BUILD_CONTEXT_PATH: z.string().default("."),
  TEMPLATE_BUILD_DOCKERFILE_PATH: z.string().default("services/runtime-agent-ts/Dockerfile"),
  RUNTIME_AGENT_TIMEOUT_SECONDS: z.coerce.number().positive().default(300),
  RUNTIME_DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  RUNTIME_DOCKER_NETWORK: z.string().optional(),
  RUNTIME_AGENT_IMAGE: z.string().default("kuuna-runtime-agent-ts:latest"),
  RUNTIME_AGENT_CONTAINER_PORT: z.coerce.number().int().positive().default(8100),
  RUNTIME_TOOL_BACKEND_BASE_URL: z.string().default("http://backend:8000"),
  RUNTIME_TOOL_TOKEN: z.string().optional(),
  RUNTIME_CONTAINER_DATA_DIR: z.string().default("/runtime-data"),
  RUNTIME_CONTAINER_DATA_VOLUME_PREFIX: z.string().default("kuuna-runtime-data"),
  RUNTIME_CONTAINER_EXTRA_ENV_JSON: z.string().optional(),
});

export type Settings = z.infer<typeof envSchema>;

let cachedSettings: Settings | undefined;

export function getSettings(): Settings {
  if (!cachedSettings) {
    cachedSettings = envSchema.parse(process.env);
    assertProductionAuthSettings(cachedSettings);
  }
  return cachedSettings;
}

export function resetSettingsForTests(): void {
  cachedSettings = undefined;
}

function assertProductionAuthSettings(settings: Settings): void {
  const isProduction = process.env.NODE_ENV === "production" || settings.APP_ENV === "prod";
  if (!isProduction) return;

  if (
    !process.env.BETTER_AUTH_SECRET ||
    settings.BETTER_AUTH_SECRET === DEV_BETTER_AUTH_SECRET ||
    settings.BETTER_AUTH_SECRET.length < 32
  ) {
    throw new Error(
      "BETTER_AUTH_SECRET must be set to a non-default value with at least 32 characters in production",
    );
  }
}
