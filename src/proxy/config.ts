import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_MODEL: z.string().trim().default("gpt-4o-mini"),
  TELEGRAM_BOT_TOKEN: z.string().trim().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().trim().optional(),
  AGENTS_DIR: z.string().trim().default("./agents"),
  DEFAULT_AGENT: z.string().trim().default("operator"),
  PROXY_WORKSPACE_DIR: z.string().trim().default("./workspace"),
  PROXY_RESET_WORKSPACE_ON_START: z.string().optional(),
  PROXY_MODEL_CONTEXT_FILE: z.string().trim().default("./docs/proxy-model-context.md"),
  EXEC_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(60_000),
  MAX_STDIO_CHARS: z.coerce.number().int().positive().max(250_000).default(20_000),
  PROXY_MAX_ITERATIONS: z.coerce.number().int().positive().max(12).default(4),
  PROXY_MAX_COMMANDS_PER_TURN: z.coerce.number().int().positive().max(1500).default(1500),
  PROXY_MAX_COMMANDS_TOTAL: z.coerce.number().int().positive().max(1500).default(1500),
  PROXY_MAX_HISTORY_ITEMS: z.coerce.number().int().positive().max(200).default(40),
  PROXY_RECENT_CONVERSATION_TURNS: z.coerce.number().int().positive().max(120).default(30),
  PROXY_RECENT_MESSAGE_MAX_CHARS: z.coerce.number().int().positive().max(2000).default(280),
  PROXY_RECENT_CONVERSATION_MAX_CHARS: z.coerce.number().int().positive().max(40_000).default(9000),
  PROXY_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(4096).default(1000),
  PROXY_IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(4096).default(700),
  PROXY_IMAGE_MAX_FILE_BYTES: z.coerce.number().int().positive().max(50_000_000).default(20_000_000),
  OPENAI_AUDIO_MODEL: z.string().trim().default("whisper-1"),
  OPENAI_AUDIO_LANGUAGE: z.string().trim().default("es"),
  OPENAI_AUDIO_MAX_FILE_BYTES: z.coerce.number().int().positive().max(50_000_000).default(20_000_000),
  PROXY_REQUIRE_CONFIRMATION: z.string().optional(),
  PROXY_MEMORY_ENABLED: z.string().optional(),
  PROXY_MEMORY_DIR: z.string().trim().default("./proxy-memory"),
  PROXY_MEMORY_CONTEXT_FILE_MAX_CHARS: z.coerce.number().int().positive().max(20_000).default(1800),
  PROXY_MEMORY_CONTEXT_TOTAL_MAX_CHARS: z.coerce.number().int().positive().max(80_000).default(9000),
  PROXY_MEMORY_MAX_RESULTS: z.coerce.number().int().positive().max(20).default(6),
  PROXY_MEMORY_SNIPPET_MAX_CHARS: z.coerce.number().int().positive().max(2000).default(320),
  PROXY_MEMORY_MAX_INJECTED_CHARS: z.coerce.number().int().positive().max(30_000).default(1800),
  PROXY_MEMORY_BACKEND: z.enum(["hybrid", "scan"]).default("hybrid"),
  PROXY_WEB_API_ENABLED: z.string().optional(),
  PROXY_WEB_API_HOST: z.string().trim().default("127.0.0.1"),
  PROXY_WEB_API_PORT: z.coerce.number().int().positive().max(65535).default(3222),
  PROXY_WEB_API_TOKEN: z.string().trim().optional(),
  PROXY_WEB_API_MAX_BODY_BYTES: z.coerce.number().int().positive().max(2_000_000).default(100_000),
  PROXY_WEB_SEARCH_MAX_RESULTS: z.coerce.number().int().positive().max(10).default(5),
  PROXY_WEB_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(20_000),
  PROXY_WEB_FETCH_MAX_BYTES: z.coerce.number().int().positive().max(10_000_000).default(2_000_000),
  PROXY_WEB_CONTENT_MAX_CHARS: z.coerce.number().int().positive().max(200_000).default(8_000),
  PROXY_SCHEDULE_POLL_MS: z.coerce.number().int().positive().max(3_600_000).default(10_000),
});

function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value === "undefined") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "si", "sí", "s"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "n"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseAllowedUserIds(raw: string | undefined): Set<number> {
  if (!raw || !raw.trim()) {
    return new Set<number>();
  }
  const values = raw
    .split(/[,\s]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item) && item > 0) as number[];
  return new Set(values);
}

const env = EnvSchema.parse(process.env);

export const proxyConfig = {
  openAiApiKey: env.OPENAI_API_KEY?.trim() || "",
  openAiModel: env.OPENAI_MODEL,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || "",
  telegramAllowedUserIds: parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS),
  agentsDir: path.resolve(process.cwd(), env.AGENTS_DIR),
  defaultAgent: env.DEFAULT_AGENT,
  workspaceDir: path.resolve(process.cwd(), env.PROXY_WORKSPACE_DIR),
  resetWorkspaceOnStart: parseBooleanFlag(env.PROXY_RESET_WORKSPACE_ON_START, true),
  modelContextFile: path.resolve(process.cwd(), env.PROXY_MODEL_CONTEXT_FILE),
  execTimeoutMs: env.EXEC_TIMEOUT_MS,
  maxStdioChars: env.MAX_STDIO_CHARS,
  maxIterations: env.PROXY_MAX_ITERATIONS,
  maxCommandsPerTurn: env.PROXY_MAX_COMMANDS_PER_TURN,
  maxCommandsTotal: env.PROXY_MAX_COMMANDS_TOTAL,
  maxHistoryItems: env.PROXY_MAX_HISTORY_ITEMS,
  recentConversationTurns: env.PROXY_RECENT_CONVERSATION_TURNS,
  recentMessageMaxChars: env.PROXY_RECENT_MESSAGE_MAX_CHARS,
  recentConversationMaxChars: env.PROXY_RECENT_CONVERSATION_MAX_CHARS,
  maxOutputTokens: env.PROXY_MAX_OUTPUT_TOKENS,
  imageAnalysisMaxOutputTokens: env.PROXY_IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS,
  imageMaxFileBytes: env.PROXY_IMAGE_MAX_FILE_BYTES,
  audioModel: env.OPENAI_AUDIO_MODEL,
  audioLanguage: env.OPENAI_AUDIO_LANGUAGE,
  audioMaxFileBytes: env.OPENAI_AUDIO_MAX_FILE_BYTES,
  requireConfirmation: parseBooleanFlag(env.PROXY_REQUIRE_CONFIRMATION, false),
  memoryEnabled: parseBooleanFlag(env.PROXY_MEMORY_ENABLED, true),
  memoryDir: path.resolve(process.cwd(), env.PROXY_MEMORY_DIR),
  memoryContextFileMaxChars: env.PROXY_MEMORY_CONTEXT_FILE_MAX_CHARS,
  memoryContextTotalMaxChars: env.PROXY_MEMORY_CONTEXT_TOTAL_MAX_CHARS,
  memoryMaxResults: env.PROXY_MEMORY_MAX_RESULTS,
  memorySnippetMaxChars: env.PROXY_MEMORY_SNIPPET_MAX_CHARS,
  memoryMaxInjectedChars: env.PROXY_MEMORY_MAX_INJECTED_CHARS,
  memoryBackend: env.PROXY_MEMORY_BACKEND,
  webApiEnabled: parseBooleanFlag(env.PROXY_WEB_API_ENABLED, true),
  webApiHost: env.PROXY_WEB_API_HOST,
  webApiPort: env.PROXY_WEB_API_PORT,
  webApiToken: env.PROXY_WEB_API_TOKEN?.trim() || undefined,
  webApiMaxBodyBytes: env.PROXY_WEB_API_MAX_BODY_BYTES,
  webSearchMaxResults: env.PROXY_WEB_SEARCH_MAX_RESULTS,
  webFetchTimeoutMs: env.PROXY_WEB_FETCH_TIMEOUT_MS,
  webFetchMaxBytes: env.PROXY_WEB_FETCH_MAX_BYTES,
  webContentMaxChars: env.PROXY_WEB_CONTENT_MAX_CHARS,
  schedulePollMs: env.PROXY_SCHEDULE_POLL_MS,
};
