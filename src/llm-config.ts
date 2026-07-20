import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writeJsonFileAtomically } from "./storage.ts";
import { extractSecretTokenFromMessage, getAppDir } from "./utils.ts";

export const DEFAULT_LLM_CONFIG_FILE = join("persistent", "llm.config.json");
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 60_000;

export const DEFAULT_LLM_MODEL_SELECTION_FILE = "llm.model.json";

interface PersistedGlobalModelSelection {
  modelsUrl: string;
  model: string;
}

/** Configuración explícita del proveedor LLM. */
export interface LlmConfig {
  /** Endpoint completo compatible con OpenAI para chat completions. */
  chatCompletionsUrl: string;
  /** Endpoint completo que lista modelos disponibles. */
  modelsUrl: string;
  /** Único modelo global activo para chats, tareas y subagentes. */
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

export interface LlmEndpointUrls {
  baseUrl: string;
  chatCompletionsUrl: string;
  modelsUrl: string;
}

export type ProviderSetupStep = "baseUrl" | "apiKey" | "defaultModel";

interface ProviderSetupSession {
  step: ProviderSetupStep;
  draft: Partial<LlmConfig>;
  requestTimeoutMs: number;
  baseUrlCandidates: string[];
  availableModels: string[];
}

export interface ProviderDiscoveryDraft {
  baseUrlCandidates: string[];
  apiKey: string;
  requestTimeoutMs: number;
}

export type ProviderSetupSubmission =
  | { kind: "next"; nextStep: ProviderSetupStep }
  | { kind: "discover-models"; secretInput: boolean }
  | { kind: "completed"; config: LlmConfig };

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

  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function extractHttpUrlInput(value: string): string {
  const trimmed = value.trim();
  const match = /https?:\/\/[^\s<>{}\[\]`"']+/iu.exec(trimmed);
  return (match?.[0] ?? trimmed).replace(/[.,;]+$/g, "");
}

function stripKnownLlmEndpoint(pathname: string): string {
  const clean = pathname.replace(/\/+$/, "");
  const suffixes = [
    "/chat/completions",
    "/completions",
    "/responses",
    "/models",
  ];

  for (const suffix of suffixes) {
    if (clean.toLowerCase().endsWith(suffix)) {
      return clean.slice(0, -suffix.length).replace(/\/+$/, "");
    }
  }

  return clean;
}

/**
 * Normaliza una URL base OpenAI-compatible. Acepta también que el usuario
 * pegue por error /models o /chat/completions y recupera la base automáticamente.
 * Si solo se proporciona el origen, asume el estándar /v1.
 */
export function normalizeLlmBaseUrl(value: unknown): string {
  const raw = extractHttpUrlInput(requireString(value, "baseUrl"));
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('El campo "baseUrl" debe contener una URL válida.');
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error('El campo "baseUrl" solo admite URLs http o https.');
  }

  parsed.search = "";
  parsed.hash = "";
  const pathname = stripKnownLlmEndpoint(parsed.pathname);
  parsed.pathname = (!pathname || pathname === "/")
    ? "/"
    : pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

/** Deriva los endpoints estándar de chat y catálogo desde una única URL base. */
export function deriveLlmEndpointUrls(baseUrl: unknown): LlmEndpointUrls {
  const normalizedBaseUrl = normalizeLlmBaseUrl(baseUrl);
  return {
    baseUrl: normalizedBaseUrl,
    chatCompletionsUrl: `${normalizedBaseUrl}/chat/completions`,
    modelsUrl: `${normalizedBaseUrl}/models`,
  };
}

/**
 * Genera alternativas conservadoras para detectar proveedores que exponen sus
 * endpoints en la raíz en lugar de /v1, sin pedir URLs adicionales al usuario.
 */
export function buildLlmBaseUrlCandidates(value: unknown): string[] {
  const extracted = extractHttpUrlInput(requireString(value, "baseUrl"));
  const normalized = normalizeLlmBaseUrl(extracted);
  const candidates: string[] = [];

  let parsed: URL;
  try {
    parsed = new URL(extracted);
  } catch {
    return candidates;
  }

  parsed.search = "";
  parsed.hash = "";
  const stripped = stripKnownLlmEndpoint(parsed.pathname);
  const explicitPath = stripped.replace(/\/+$/, "");

  if (!explicitPath || explicitPath === "/") {
    const root = `${parsed.origin}`;
    candidates.push(`${root}/v1`, root);
  } else {
    if (!candidates.includes(normalized)) candidates.push(normalized);
    if (!explicitPath.toLowerCase().endsWith("/v1")) {
      const withV1 = `${normalized}/v1`;
      if (!candidates.includes(withV1)) candidates.push(withV1);
    }
  }

  return candidates;
}

/** Intenta recuperar la URL base desde una configuración ya persistida. */
export function inferLlmBaseUrl(config: Pick<LlmConfig, "chatCompletionsUrl" | "modelsUrl">): string {
  try {
    return normalizeLlmBaseUrl(config.chatCompletionsUrl);
  } catch {
    return normalizeLlmBaseUrl(config.modelsUrl);
  }
}

/** Valida el identificador del modelo predeterminado. */
export function normalizeDefaultModel(value: unknown): string {
  return requireString(value, "defaultModel");
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

/** Ruta del modelo global, vecina al archivo de configuración LLM. */
export function getLlmModelSelectionPath(
  configPath = DEFAULT_LLM_CONFIG_FILE,
): string {
  return join(dirname(resolveConfigPath(configPath)), DEFAULT_LLM_MODEL_SELECTION_FILE);
}

/**
 * Carga el modelo global solo cuando pertenece al mismo catálogo/proveedor.
 * Una selección antigua de otro provider nunca se reutiliza accidentalmente.
 */
export function loadGlobalLlmModel(
  modelsUrl: string,
  configPath = DEFAULT_LLM_CONFIG_FILE,
): string | null {
  const path = getLlmModelSelectionPath(configPath);
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<PersistedGlobalModelSelection>;
    if (
      typeof parsed.modelsUrl !== "string" ||
      typeof parsed.model !== "string" ||
      parsed.model.trim() === ""
    ) {
      return null;
    }

    const expectedModelsUrl = normalizeLlmHttpUrl(modelsUrl, "modelsUrl");
    const persistedModelsUrl = normalizeLlmHttpUrl(parsed.modelsUrl, "modelsUrl");
    if (persistedModelsUrl !== expectedModelsUrl) return null;
    return normalizeDefaultModel(parsed.model);
  } catch {
    return null;
  }
}

/** Persiste la única selección de modelo activa de Luna para el provider actual. */
export function saveGlobalLlmModel(
  config: Pick<LlmConfig, "modelsUrl" | "defaultModel">,
  configPath = DEFAULT_LLM_CONFIG_FILE,
): void {
  writeJsonFileAtomically(getLlmModelSelectionPath(configPath), {
    modelsUrl: normalizeLlmHttpUrl(config.modelsUrl, "modelsUrl"),
    model: normalizeDefaultModel(config.defaultModel),
  } satisfies PersistedGlobalModelSelection);
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
      "Un administrador puede generarla desde el chat con /setup-provider.",
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
 * Estado temporal del asistente /setup-provider. La API key solo vive en
 * memoria hasta que el catálogo se valida y el administrador elige un modelo.
 */
export class ProviderSetupManager {
  private readonly sessions = new Map<string, ProviderSetupSession>();

  start(jid: string, currentConfig?: LlmConfig | null): void {
    this.sessions.set(jid, {
      step: "baseUrl",
      draft: {},
      requestTimeoutMs:
        currentConfig?.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      baseUrlCandidates: [],
      availableModels: [],
    });
  }

  has(jid: string): boolean {
    return this.sessions.has(jid);
  }

  getStep(jid: string): ProviderSetupStep | undefined {
    return this.sessions.get(jid)?.step;
  }

  getAvailableModels(jid: string): string[] {
    return [...(this.sessions.get(jid)?.availableModels ?? [])];
  }

  getDiscoveryDraft(jid: string): ProviderDiscoveryDraft {
    const session = this.sessions.get(jid);
    if (!session) {
      throw new Error("No hay una configuración de proveedor en curso.");
    }
    if (session.step !== "apiKey" || session.baseUrlCandidates.length === 0) {
      throw new Error("La URL base del proveedor aún no está lista para consultar modelos.");
    }

    return {
      baseUrlCandidates: [...session.baseUrlCandidates],
      apiKey: session.draft.apiKey ?? "",
      requestTimeoutMs: session.requestTimeoutMs,
    };
  }

  setDiscoveredModels(jid: string, baseUrl: string, models: readonly string[]): void {
    const session = this.sessions.get(jid);
    if (!session) {
      throw new Error("No hay una configuración de proveedor en curso.");
    }

    const normalizedModels = [...new Set(
      models.map((model) => model.trim()).filter(Boolean),
    )];
    if (normalizedModels.length === 0) {
      throw new Error("El proveedor no devolvió ningún modelo utilizable.");
    }

    const endpoints = deriveLlmEndpointUrls(baseUrl);
    session.draft.chatCompletionsUrl = endpoints.chatCompletionsUrl;
    session.draft.modelsUrl = endpoints.modelsUrl;
    session.availableModels = normalizedModels;
    session.step = "defaultModel";
  }

  resetToBaseUrl(jid: string): void {
    const session = this.sessions.get(jid);
    if (!session) return;
    session.step = "baseUrl";
    session.draft = {};
    session.baseUrlCandidates = [];
    session.availableModels = [];
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
      case "baseUrl": {
        session.baseUrlCandidates = buildLlmBaseUrlCandidates(input);
        session.step = "apiKey";
        return { kind: "next", nextStep: session.step };
      }

      case "apiKey": {
        const normalizedInput = input.trim();
        const withoutKey = new Set(["-", "no", "ninguna", "sin-clave", "sin clave"]);
        session.draft.apiKey = withoutKey.has(normalizedInput.toLowerCase())
          ? ""
          : extractSecretTokenFromMessage(normalizedInput);
        return {
          kind: "discover-models",
          secretInput: session.draft.apiKey !== "",
        };
      }

      case "defaultModel": {
        if (session.availableModels.length === 0) {
          throw new Error("El catálogo de modelos todavía no está disponible.");
        }

        const match = /(?:modelo\s*)?(\d+)/iu.exec(input.trim());
        if (!match) {
          throw new Error("Selecciona el modelo escribiendo únicamente su número.");
        }

        const index = Number.parseInt(match[1] ?? "", 10) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= session.availableModels.length) {
          throw new Error(`Número inválido. Elige entre 1 y ${session.availableModels.length}.`);
        }

        session.draft.defaultModel = session.availableModels[index];
        const config = normalizeLlmConfig({
          ...session.draft,
          requestTimeoutMs: session.requestTimeoutMs,
        });
        return { kind: "completed", config };
      }
    }
  }
}
