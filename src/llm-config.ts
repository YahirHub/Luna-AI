import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writeJsonFileAtomically } from "./storage.ts";
import { extractSecretTokenFromMessage, getAppDir } from "./utils.ts";

export const DEFAULT_LLM_CONFIG_FILE = join("persistent", "llm.config.json");
export const DEFAULT_LLM_MODEL_FILE = join("persistent", "llm.model.json");
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 60_000;

export interface LlmConfig {
  chatCompletionsUrl: string;
  modelsUrl: string;
  /** Único modelo global activo para chats, tareas y subagentes. */
  defaultModel: string;
  apiKey: string;
  requestTimeoutMs: number;
}

interface RawLlmConfig {
  chatCompletionsUrl?: unknown;
  modelsUrl?: unknown;
  defaultModel?: unknown;
  apiKey?: unknown;
  requestTimeoutMs?: unknown;
}

export interface ProviderEndpointCandidate {
  baseUrl: string;
  chatCompletionsUrl: string;
  modelsUrl: string;
}

export type ProviderSetupStep = "chatCompletionsUrl" | "apiKey" | "defaultModel";

interface ProviderSetupSession {
  step: ProviderSetupStep;
  endpointCandidates: ProviderEndpointCandidate[];
  selectedCandidate?: ProviderEndpointCandidate;
  models: string[];
  apiKey: string;
  requestTimeoutMs: number;
}

export type ProviderSetupSubmission =
  | { completed: false; nextStep: ProviderSetupStep; secretInput?: boolean; discover?: { candidates: ProviderEndpointCandidate[]; apiKey: string; requestTimeoutMs: number } }
  | { completed: true; config: LlmConfig; secretInput: boolean };

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`El campo "${field}" debe ser un texto no vacío.`);
  return value.trim();
}

export function normalizeLlmHttpUrl(value: unknown, field: string): string {
  const raw = requireString(value, field);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`El campo "${field}" debe contener una URL válida.`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`El campo "${field}" solo admite URLs http o https.`);
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

export function normalizeDefaultModel(value: unknown): string {
  return requireString(value, "defaultModel");
}

function extractHttpUrlInput(value: string): string {
  const trimmed = value.trim();
  const match = /https?:\/\/[^\s<>{}\[\]`"']+/iu.exec(trimmed);
  return (match?.[0] ?? trimmed).replace(/[.,;]+$/g, "");
}

function parseApiKey(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error('El campo "apiKey" debe ser un texto.');
  return value.trim();
}

function parseTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('El campo "requestTimeoutMs" debe ser un entero positivo.');
  return parsed;
}

export function normalizeLlmConfig(value: RawLlmConfig): LlmConfig {
  return {
    chatCompletionsUrl: normalizeLlmHttpUrl(value.chatCompletionsUrl, "chatCompletionsUrl"),
    modelsUrl: normalizeLlmHttpUrl(value.modelsUrl, "modelsUrl"),
    defaultModel: normalizeDefaultModel(value.defaultModel),
    apiKey: parseApiKey(value.apiKey),
    requestTimeoutMs: parseTimeout(value.requestTimeoutMs),
  };
}

function stripKnownEndpoint(pathname: string): string {
  return pathname
    .replace(/\/(?:models|chat\/completions|completions|responses)\/?$/i, "")
    .replace(/\/+$/, "");
}

export function normalizeProviderBaseUrl(value: string): string {
  const url = new URL(normalizeLlmHttpUrl(extractHttpUrlInput(value), "baseUrl"));
  url.pathname = stripKnownEndpoint(url.pathname) || "/";
  return url.toString().replace(/\/+$/, "");
}

export function endpointsFromProviderBase(baseUrl: string): ProviderEndpointCandidate {
  const base = normalizeProviderBaseUrl(baseUrl);
  return {
    baseUrl: base,
    chatCompletionsUrl: `${base}/chat/completions`,
    modelsUrl: `${base}/models`,
  };
}

/**
 * Genera candidatos tolerantes. Con una raíz prueba primero /v1 y luego la raíz;
 * con una base que ya termina en /v1 conserva esa ruta como primera opción.
 */
export function deriveProviderEndpointCandidates(value: string): ProviderEndpointCandidate[] {
  const normalized = normalizeProviderBaseUrl(value);
  const parsed = new URL(normalized);
  const path = parsed.pathname.replace(/\/+$/, "");
  const bases: string[] = [];
  if (!/\/v\d+(?:\/|$)/i.test(path)) {
    const v1 = new URL(parsed.toString());
    v1.pathname = `${path || ""}/v1`.replace(/\/+/g, "/");
    bases.push(v1.toString().replace(/\/+$/, ""));
  }
  bases.push(normalized);
  return [...new Set(bases)].map(endpointsFromProviderBase);
}

function resolveConfigPath(configPath: string): string {
  return isAbsolute(configPath) ? configPath : resolve(getAppDir(), configPath);
}

export function loadLlmConfig(configPath = DEFAULT_LLM_CONFIG_FILE): LlmConfig {
  const absolutePath = resolveConfigPath(configPath);
  let rawText: string;
  try { rawText = readFileSync(absolutePath, "utf-8"); }
  catch (error) {
    throw new Error(`No se pudo leer la configuración LLM en "${absolutePath}": ${error instanceof Error ? error.message : String(error)}. Un administrador puede generarla con /setup-provider.`);
  }
  try {
    const value = JSON.parse(rawText) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("La raíz debe ser un objeto JSON.");
    return normalizeLlmConfig(value as RawLlmConfig);
  } catch (error) {
    throw new Error(`Configuración LLM inválida en "${absolutePath}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadLlmConfigIfPresent(configPath = DEFAULT_LLM_CONFIG_FILE): LlmConfig | null {
  const absolutePath = resolveConfigPath(configPath);
  return existsSync(absolutePath) ? loadLlmConfig(absolutePath) : null;
}

export function saveLlmConfig(config: LlmConfig, configPath = DEFAULT_LLM_CONFIG_FILE): LlmConfig {
  const normalized = normalizeLlmConfig(config);
  writeJsonFileAtomically(resolveConfigPath(configPath), normalized);
  return normalized;
}

export function deleteLlmConfig(configPath = DEFAULT_LLM_CONFIG_FILE): boolean {
  const absolutePath = resolveConfigPath(configPath);
  if (!existsSync(absolutePath)) return false;
  rmSync(absolutePath, { force: true });
  return true;
}

export function getLlmConfigPath(argv: string[] = process.argv): string {
  const inline = argv.find((arg) => arg.startsWith("--llm-config="));
  if (inline) {
    const value = inline.slice("--llm-config=".length).trim();
    if (value) return resolveConfigPath(value);
  }
  const index = argv.indexOf("--llm-config");
  if (index >= 0) {
    const next = argv[index + 1]?.trim();
    if (!next || next.startsWith("--")) throw new Error("El argumento --llm-config requiere una ruta.");
    return resolveConfigPath(next);
  }
  return resolveConfigPath(DEFAULT_LLM_CONFIG_FILE);
}

export function getLlmModelSelectionPath(configPath = DEFAULT_LLM_CONFIG_FILE): string {
  const resolved = resolveConfigPath(configPath);
  return join(dirname(resolved), "llm.model.json");
}

interface GlobalModelSelection { version: 1; modelsUrl: string; model: string; updatedAt: string }

export function saveGlobalLlmModel(config: Pick<LlmConfig, "modelsUrl" | "defaultModel">, configPath = DEFAULT_LLM_CONFIG_FILE): void {
  writeJsonFileAtomically(getLlmModelSelectionPath(configPath), {
    version: 1,
    modelsUrl: normalizeLlmHttpUrl(config.modelsUrl, "modelsUrl"),
    model: normalizeDefaultModel(config.defaultModel),
    updatedAt: new Date().toISOString(),
  } satisfies GlobalModelSelection);
}

export function loadGlobalLlmModel(modelsUrl: string, configPath = DEFAULT_LLM_CONFIG_FILE): string | null {
  try {
    const parsed = JSON.parse(readFileSync(getLlmModelSelectionPath(configPath), "utf8")) as Partial<GlobalModelSelection>;
    if (parsed.version !== 1 || parsed.modelsUrl !== normalizeLlmHttpUrl(modelsUrl, "modelsUrl") || typeof parsed.model !== "string" || !parsed.model.trim()) return null;
    return parsed.model.trim();
  } catch { return null; }
}

export class ProviderSetupManager {
  private readonly sessions = new Map<string, ProviderSetupSession>();

  start(jid: string, currentConfig?: LlmConfig | null): void {
    this.sessions.set(jid, {
      step: "chatCompletionsUrl",
      endpointCandidates: currentConfig ? [endpointsFromProviderBase(currentConfig.modelsUrl.replace(/\/models\/?$/i, ""))] : [],
      models: [],
      apiKey: "",
      requestTimeoutMs: currentConfig?.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    });
  }
  has(jid: string): boolean { return this.sessions.has(jid); }
  getStep(jid: string): ProviderSetupStep | undefined { return this.sessions.get(jid)?.step; }
  getModels(jid: string): string[] { return [...(this.sessions.get(jid)?.models ?? [])]; }
  cancel(jid: string): void { this.sessions.delete(jid); }

  setDiscoveredModels(jid: string, candidate: ProviderEndpointCandidate, models: string[]): void {
    const session = this.sessions.get(jid);
    if (!session) throw new Error("No hay una configuración de proveedor en curso.");
    if (models.length === 0) throw new Error("El proveedor no devolvió modelos seleccionables.");
    session.selectedCandidate = candidate;
    session.models = [...new Set(models)];
    session.step = "defaultModel";
  }

  submit(jid: string, input: string): ProviderSetupSubmission {
    const session = this.sessions.get(jid);
    if (!session) throw new Error("No hay una configuración de proveedor en curso.");
    if (session.step === "chatCompletionsUrl") {
      session.endpointCandidates = deriveProviderEndpointCandidates(input);
      session.step = "apiKey";
      return { completed: false, nextStep: "apiKey" };
    }
    if (session.step === "apiKey") {
      const normalizedInput = input.trim();
      const withoutKey = new Set(["-", "no", "ninguna", "sin-clave", "sin clave"]);
      session.apiKey = withoutKey.has(normalizedInput.toLowerCase()) ? "" : extractSecretTokenFromMessage(normalizedInput);
      return {
        completed: false,
        nextStep: "defaultModel",
        secretInput: session.apiKey !== "",
        discover: { candidates: session.endpointCandidates, apiKey: session.apiKey, requestTimeoutMs: session.requestTimeoutMs },
      };
    }
    const numeric = Number.parseInt(input.trim(), 10);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > session.models.length) throw new Error(`Responde con un número entre 1 y ${session.models.length}.`);
    const candidate = session.selectedCandidate;
    if (!candidate) throw new Error("El catálogo todavía no fue detectado.");
    const config = normalizeLlmConfig({
      chatCompletionsUrl: candidate.chatCompletionsUrl,
      modelsUrl: candidate.modelsUrl,
      defaultModel: session.models[numeric - 1],
      apiKey: session.apiKey,
      requestTimeoutMs: session.requestTimeoutMs,
    });
    return { completed: true, config, secretInput: false };
  }
}
