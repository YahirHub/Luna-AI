import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { writeJsonFileAtomically } from "./storage.ts";
import { extractSecretTokenFromMessage, getAppDir } from "./utils.ts";

export const DEFAULT_LLM_CONFIG_FILE = join("persistent", "llm.config.json");
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 60_000;

/** Configuración explícita del proveedor LLM. */
export interface LlmConfig {
  /** Endpoint completo compatible con OpenAI para chat completions. */
  chatCompletionsUrl: string;
  /** Endpoint completo que lista modelos disponibles. */
  modelsUrl: string;
  /** Modelo usado por chats nuevos y como fallback. */
  defaultModel: string;
  /** API key del proveedor. Puede estar vacía si no se requiere. */
  apiKey: string;
  /** Tiempo máximo por solicitud HTTP. */
  requestTimeoutMs: number;
}

interface RawLlmConfig {
  chatCompletionsUrl?: unknown;
  modelsUrl?: unknown;
  defaultModel?: unknown;
  apiKey?: unknown;
  requestTimeoutMs?: unknown;
}

export type ProviderSetupStep =
  | "chatCompletionsUrl"
  | "modelsUrl"
  | "defaultModel"
  | "apiKey";

interface ProviderSetupSession {
  step: ProviderSetupStep;
  draft: Partial<LlmConfig>;
  requestTimeoutMs: number;
}

export type ProviderSetupSubmission =
  | { completed: false; nextStep: ProviderSetupStep }
  | { completed: true; config: LlmConfig; secretInput: boolean };

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`El campo "${field}" debe ser un texto no vacío.`);
  }
  return value.trim();
}

/** Valida y normaliza un endpoint HTTP/HTTPS del proveedor. */
export function normalizeLlmHttpUrl(value: unknown, field: string): string {
  const raw = requireString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`El campo "${field}" debe contener una URL válida.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`El campo "${field}" solo admite URLs http o https.`);
  }

  return raw.replace(/\/+$/, "");
}

/** Valida el identificador del modelo predeterminado. */
export function normalizeDefaultModel(value: unknown): string {
  return requireString(value, "defaultModel");
}

function extractHttpUrlInput(value: string): string {
  const trimmed = value.trim();
  const match = /https?:\/\/[^\s<>{}\[\]`"']+/iu.exec(trimmed);
  return (match?.[0] ?? trimmed).replace(/[.,;]+$/g, "");
}

function extractModelIdInput(value: string): string {
  const trimmed = value.trim();
  const quoted = /[`"']([^`"']+)[`"']\s*$/u.exec(trimmed);
  if (quoted?.[1]) return quoted[1].trim();

  const natural = /(?:modelo|model)\s+(?:es|is|:)?\s*([a-z0-9._:/-]+)\s*$/iu.exec(trimmed);
  if (natural?.[1]) return natural[1];

  const delimited = /[:=]\s*([a-z0-9._:/-]+)\s*$/iu.exec(trimmed);
  if (delimited?.[1]) return delimited[1];

  return trimmed;
}

function parseApiKey(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error('El campo "apiKey" debe ser un texto.');
  }
  return value.trim();
}

function parseTimeout(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('El campo "requestTimeoutMs" debe ser un entero positivo.');
  }

  return parsed;
}

/** Valida un objeto de configuración completo y devuelve una copia normalizada. */
export function normalizeLlmConfig(value: RawLlmConfig): LlmConfig {
  return {
    chatCompletionsUrl: normalizeLlmHttpUrl(
      value.chatCompletionsUrl,
      "chatCompletionsUrl",
    ),
    modelsUrl: normalizeLlmHttpUrl(value.modelsUrl, "modelsUrl"),
    defaultModel: normalizeDefaultModel(value.defaultModel),
    apiKey: parseApiKey(value.apiKey),
    requestTimeoutMs: parseTimeout(value.requestTimeoutMs),
  };
}

function resolveConfigPath(configPath: string): string {
  return isAbsolute(configPath)
    ? configPath
    : resolve(getAppDir(), configPath);
}

/**
 * Carga y valida la configuración LLM desde disco.
 * La API key nunca se registra ni se incluye en mensajes de error.
 */
export function loadLlmConfig(configPath = DEFAULT_LLM_CONFIG_FILE): LlmConfig {
  const absolutePath = resolveConfigPath(configPath);
  let rawText: string;

  try {
    rawText = readFileSync(absolutePath, "utf-8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No se pudo leer la configuración LLM en "${absolutePath}": ${reason}. ` +
      "Un administrador puede generarla desde WhatsApp con /setup-provider.",
    );
  }

  let parsed: RawLlmConfig;
  try {
    const value = JSON.parse(rawText) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("La raíz debe ser un objeto JSON.");
    }
    parsed = value as RawLlmConfig;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuración LLM inválida en "${absolutePath}": ${reason}`);
  }

  return normalizeLlmConfig(parsed);
}

/** Carga la configuración si existe; retorna null cuando aún no fue creada. */
export function loadLlmConfigIfPresent(
  configPath = DEFAULT_LLM_CONFIG_FILE,
): LlmConfig | null {
  const absolutePath = resolveConfigPath(configPath);
  if (!existsSync(absolutePath)) {
    return null;
  }
  return loadLlmConfig(absolutePath);
}

/** Guarda la configuración validada mediante reemplazo atómico y permisos 0600. */
export function saveLlmConfig(
  config: LlmConfig,
  configPath = DEFAULT_LLM_CONFIG_FILE,
): LlmConfig {
  const normalized = normalizeLlmConfig(config);
  writeJsonFileAtomically(resolveConfigPath(configPath), normalized);
  return normalized;
}


/** Elimina únicamente la configuración personalizada; OpenCode Free toma su lugar. */
export function deleteLlmConfig(
  configPath = DEFAULT_LLM_CONFIG_FILE,
): boolean {
  const absolutePath = resolveConfigPath(configPath);
  if (!existsSync(absolutePath)) {
    return false;
  }
  rmSync(absolutePath, { force: true });
  return true;
}

/** Obtiene la ruta configurada mediante --llm-config o usa persistent/. */
export function getLlmConfigPath(argv: string[] = process.argv): string {
  const inline = argv.find((arg) => arg.startsWith("--llm-config="));
  if (inline) {
    const value = inline.slice("--llm-config=".length).trim();
    if (value) return resolveConfigPath(value);
  }

  const index = argv.indexOf("--llm-config");
  if (index >= 0) {
    const next = argv[index + 1]?.trim();
    if (!next || next.startsWith("--")) {
      throw new Error("El argumento --llm-config requiere una ruta.");
    }
    return resolveConfigPath(next);
  }

  return resolveConfigPath(DEFAULT_LLM_CONFIG_FILE);
}

/**
 * Estado temporal del asistente /setup-provider. No persiste secretos hasta que
 * todos los campos son válidos y la configuración completa puede guardarse.
 */
export class ProviderSetupManager {
  private readonly sessions = new Map<string, ProviderSetupSession>();

  start(jid: string, currentConfig?: LlmConfig | null): void {
    this.sessions.set(jid, {
      step: "chatCompletionsUrl",
      draft: {},
      requestTimeoutMs:
        currentConfig?.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    });
  }

  has(jid: string): boolean {
    return this.sessions.has(jid);
  }

  getStep(jid: string): ProviderSetupStep | undefined {
    return this.sessions.get(jid)?.step;
  }

  cancel(jid: string): void {
    this.sessions.delete(jid);
  }

  submit(jid: string, input: string): ProviderSetupSubmission {
    const session = this.sessions.get(jid);
    if (!session) {
      throw new Error("No hay una configuración de proveedor en curso.");
    }

    switch (session.step) {
      case "chatCompletionsUrl":
        session.draft.chatCompletionsUrl = normalizeLlmHttpUrl(
          extractHttpUrlInput(input),
          "chatCompletionsUrl",
        );
        session.step = "modelsUrl";
        return { completed: false, nextStep: session.step };

      case "modelsUrl":
        session.draft.modelsUrl = normalizeLlmHttpUrl(extractHttpUrlInput(input), "modelsUrl");
        session.step = "defaultModel";
        return { completed: false, nextStep: session.step };

      case "defaultModel":
        session.draft.defaultModel = normalizeDefaultModel(extractModelIdInput(input));
        session.step = "apiKey";
        return { completed: false, nextStep: session.step };

      case "apiKey": {
        const normalizedInput = input.trim();
        const withoutKey = new Set(["-", "no", "ninguna", "sin-clave", "sin clave"]);
        session.draft.apiKey = withoutKey.has(normalizedInput.toLowerCase())
          ? ""
          : extractSecretTokenFromMessage(normalizedInput);

        const config = normalizeLlmConfig({
          ...session.draft,
          requestTimeoutMs: session.requestTimeoutMs,
        });
        return {
          completed: true,
          config,
          secretInput: config.apiKey !== "",
        };
      }
    }
  }
}
