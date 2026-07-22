import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, ToolDefinition } from "../ai.ts";
import { chatCompletion, chatCompletionWithTools } from "../ai.ts";
import type { LlmConfig } from "../llm-config.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { writeJsonFileAtomically } from "../storage.ts";
import type { TasklistManager, TasklistRecord } from "./tasklist.ts";

export type GoalStatus = "queued" | "running" | "waiting_user" | "completed" | "failed" | "cancelled" | "interrupted";

export interface GoalRecord {
  id: string;
  jid: string;
  objective: string;
  status: GoalStatus;
  tasklistId: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  iteration: number;
  maxIterations: number;
  noProgressIterations: number;
  lastSummary?: string;
  verifierFeedback?: string;
  error?: string;
  currentPhase?: "planning" | "executing" | "delegating" | "verifying" | "waiting_user" | "idle";
  currentActivity?: string;
  currentTool?: string;
  lastEventAt?: string;
  lastToolResult?: string;
  pendingInstructions?: string[];
  instructionHistory?: string[];
  delegatedTaskIds?: string[];
}

interface GoalFile { version: 1; goals: GoalRecord[] }

interface GoalVerifierResult {
  complete: boolean;
  missing: string[];
  reason: string;
}

export interface GoalToolTrace {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export interface GoalRuntimeDependencies {
  workspace: WorkspaceManager;
  tasklists: TasklistManager;
  getModel: (jid: string) => string | null;
  getLlmConfig: () => LlmConfig | null;
  getTools: (jid: string) => ToolDefinition[];
  executeTool: (jid: string, goalId: string, tasklistId: string, name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
  onProgress?: (jid: string, text: string) => void | Promise<void>;
  onCompleted?: (jid: string, goal: GoalRecord, text: string) => void | Promise<void>;
  onCancelled?: (jid: string, goal: GoalRecord) => void | Promise<void>;
}

function shortGoalId(): string {
  return `G-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function isActive(status: GoalStatus): boolean {
  return status === "queued" || status === "running" || status === "waiting_user";
}

function truncate(value: string, max = 6000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.floor(max * 0.7))}\n...[truncado]...\n${value.slice(-Math.floor(max * 0.3))}`;
}

function parseVerifier(raw: string): GoalVerifierResult {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? trimmed;
  const objectMatch = fenced.match(/\{[\s\S]*\}/)?.[0] ?? fenced;
  try {
    const parsed = JSON.parse(objectMatch) as Record<string, unknown>;
    return {
      complete: parsed.complete === true,
      missing: Array.isArray(parsed.missing) ? parsed.missing.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 500)).slice(0, 12) : [],
      reason: typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 2000) : "",
    };
  } catch {
    return { complete: false, missing: ["El verifier no produjo JSON válido; volver a verificar con evidencia más clara."], reason: "Respuesta del verifier no parseable." };
  }
}

export class GoalRuntime {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly deps: GoalRuntimeDependencies) {
    this.recoverInterrupted();
  }

  private stateDir(jid: string): string {
    return join(this.deps.workspace.getUserDir(jid), "goals");
  }

  private filePath(jid: string): string {
    return join(this.stateDir(jid), "goals.json");
  }

  private load(jid: string): GoalFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath(jid), "utf8")) as GoalFile;
      if (parsed?.version === 1 && Array.isArray(parsed.goals)) return parsed;
    } catch {}
    return { version: 1, goals: [] };
  }

  private save(jid: string, file: GoalFile): void {
    writeJsonFileAtomically(this.filePath(jid), file);
  }

  private recoverInterrupted(): void {
    try {
      const base = this.deps.workspace.contextsDir;
      if (!existsSync(base)) return;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const filePath = join(base, entry.name, "goals", "goals.json");
        if (!existsSync(filePath)) continue;
        try {
          const file = JSON.parse(readFileSync(filePath, "utf8")) as GoalFile;
          let changed = false;
          const now = new Date().toISOString();
          for (const goal of file.goals ?? []) {
            if (isActive(goal.status)) {
              goal.status = "interrupted";
              goal.updatedAt = now;
              goal.error = "Luna se reinició mientras el goal estaba activo. Usa /goal reanudar para continuarlo.";
              changed = true;
            }
          }
          if (changed) writeJsonFileAtomically(filePath, file);
        } catch {}
      }
    } catch {}
  }

  list(jid: string): GoalRecord[] {
    return this.load(jid).goals.slice(-20).reverse().map((goal) => structuredClone(goal));
  }

  get(jid: string, id?: string): GoalRecord | undefined {
    const goals = this.load(jid).goals;
    const record = id
      ? goals.find((goal) => goal.id.toLowerCase() === id.toLowerCase())
      : [...goals].reverse().find((goal) => isActive(goal.status)) ?? goals[goals.length - 1];
    return record ? structuredClone(record) : undefined;
  }

  private patch(jid: string, id: string, patch: Partial<Omit<GoalRecord, "id" | "jid" | "createdAt">>): GoalRecord | null {
    const file = this.load(jid);
    const goal = file.goals.find((item) => item.id === id);
    if (!goal) return null;
    Object.assign(goal, patch, { updatedAt: new Date().toISOString() });
    this.save(jid, file);
    return structuredClone(goal);
  }

  start(jid: string, objective: string, maxIterations = 18): GoalRecord {
    const clean = objective.replace(/\s+/g, " ").trim();
    if (!clean) throw new Error("El objetivo de /goal no puede estar vacío.");
    const already = this.list(jid).find((goal) => isActive(goal.status));
    if (already) throw new Error(`Ya hay un goal activo: ${already.id}. Cancélalo o espera a que termine.`);
    const id = shortGoalId();
    const tasklist = this.deps.tasklists.create(jid, `Goal ${id}`, [
      "Inspeccionar el objetivo y convertirlo en una tasklist específica y verificable",
      "Ejecutar todos los pasos necesarios, investigando o creando archivos cuando haga falta",
      "Validar el resultado completo contra el objetivo original",
    ], id);
    const now = new Date().toISOString();
    const record: GoalRecord = {
      id, jid, objective: clean, status: "queued", tasklistId: tasklist.id,
      createdAt: now, updatedAt: now, iteration: 0,
      currentPhase: "planning", currentActivity: "Preparando la primera iteración", lastEventAt: now, pendingInstructions: [], instructionHistory: [], delegatedTaskIds: [],
      maxIterations: Math.max(3, Math.min(40, Math.trunc(maxIterations))), noProgressIterations: 0,
    };
    const file = this.load(jid);
    file.goals.push(record);
    if (file.goals.length > 50) file.goals = file.goals.slice(-50);
    this.save(jid, file);
    const controller = new AbortController();
    this.active.set(`${jid}:${id}`, controller);
    void this.run(record, controller).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        this.patch(jid, id, { status: "cancelled", error: "Cancelado por el usuario.", completedAt: new Date().toISOString() });
        return;
      }
      const latest = this.patch(jid, id, { status: "failed", error: message, completedAt: new Date().toISOString() });
      if (latest) await this.deps.onCompleted?.(jid, latest, `❌ Goal ${id} falló: ${message}`);
    }).finally(() => this.active.delete(`${jid}:${id}`));
    return structuredClone(record);
  }

  resume(jid: string, id?: string): GoalRecord {
    const target = id ? this.get(jid, id) : this.list(jid).find((goal) => goal.status === "interrupted" || goal.status === "failed");
    if (!target) throw new Error("No hay un goal interrumpido para reanudar.");
    if (isActive(target.status)) throw new Error(`El goal ${target.id} ya está activo.`);
    if (!(["interrupted", "failed", "cancelled"] as GoalStatus[]).includes(target.status)) {
      throw new Error(`El goal ${target.id} está ${target.status} y no necesita reanudarse.`);
    }
    const controller = new AbortController();
    this.patch(jid, target.id, {
      status: "queued",
      error: undefined,
      completedAt: undefined,
      iteration: 0,
      noProgressIterations: 0,
    });
    this.active.set(`${jid}:${target.id}`, controller);
    const latest = this.get(jid, target.id)!;
    void this.run(latest, controller).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        this.patch(jid, target.id, { status: "cancelled", error: "Cancelado por el usuario.", completedAt: new Date().toISOString() });
        return;
      }
      const failed = this.patch(jid, target.id, { status: "failed", error: message, completedAt: new Date().toISOString() });
      if (failed) await this.deps.onCompleted?.(jid, failed, `❌ Goal ${target.id}: ${message}`);
    }).finally(() => this.active.delete(`${jid}:${target.id}`));
    return latest;
  }

  addInstruction(jid: string, instruction: string, id?: string): GoalRecord {
    const target = this.get(jid, id);
    if (!target || !isActive(target.status)) throw new Error("No hay un goal activo al cual enviar la instrucción.");
    const clean = instruction.replace(/\s+/g, " ").trim();
    if (!clean) throw new Error("La instrucción no puede estar vacía.");
    const pending = [...(target.pendingInstructions ?? []), clean].slice(-20);
    return this.patch(jid, target.id, {
      pendingInstructions: pending,
      currentActivity: `Nueva instrucción del usuario pendiente de aplicar: ${clean.slice(0, 220)}`,
      lastEventAt: new Date().toISOString(),
    })!;
  }

  noteDelegatedTask(jid: string, id: string, taskId: string): void {
    const goal = this.get(jid, id);
    if (!goal) return;
    const ids = [...new Set([...(goal.delegatedTaskIds ?? []), taskId])].slice(-30);
    this.patch(jid, id, { delegatedTaskIds: ids, lastEventAt: new Date().toISOString() });
  }

  noteActivity(jid: string, id: string, activity: string, tool?: string, phase?: GoalRecord["currentPhase"]): void {
    this.patch(jid, id, {
      currentActivity: activity.slice(0, 1200),
      currentTool: tool,
      currentPhase: phase,
      lastEventAt: new Date().toISOString(),
    });
  }

  cancel(jid: string, id?: string): boolean {
    const target = id ? this.get(jid, id) : this.list(jid).find((goal) => isActive(goal.status));
    if (!target || !isActive(target.status)) return false;
    this.active.get(`${jid}:${target.id}`)?.abort(new Error("goal-cancelled"));
    const cancelled = this.patch(jid, target.id, { status: "cancelled", error: "Cancelado por el usuario.", completedAt: new Date().toISOString(), currentPhase: "idle", currentActivity: "Cancelado por el usuario", currentTool: undefined, lastEventAt: new Date().toISOString() });
    if (cancelled) void Promise.resolve(this.deps.onCancelled?.(jid, cancelled)).catch(() => undefined);
    return true;
  }

  formatStatus(jid: string, id?: string): string {
    const goal = this.get(jid, id);
    if (!goal) return "🎯 No hay goals registrados.";
    const list = this.deps.tasklists.get(jid, goal.tasklistId);
    const progress = list ? this.deps.tasklists.progress(list) : null;
    return [
      `🎯 GOAL ${goal.id}`,
      `Estado: ${goal.status}`,
      `Objetivo: ${goal.objective}`,
      `Iteración: ${goal.iteration}/${goal.maxIterations}`,
      goal.currentPhase ? `Fase: ${goal.currentPhase}` : "",
      goal.currentActivity ? `Ahora: ${goal.currentActivity}` : "",
      goal.currentTool ? `Tool activa: ${goal.currentTool}` : "",
      goal.lastEventAt ? `Última actividad: ${goal.lastEventAt}` : "",
      goal.pendingInstructions?.length ? `Instrucciones pendientes del usuario: ${goal.pendingInstructions.length}` : "",
      progress ? `Tasklist: ${progress.done}/${progress.total} completados · ${progress.pending} pendientes · ${progress.blocked} bloqueados` : "Tasklist: no disponible",
      goal.verifierFeedback ? `Verifier: ${truncate(goal.verifierFeedback, 1200)}` : "",
      goal.error ? `Error: ${goal.error}` : "",
    ].filter(Boolean).join("\n");
  }

  buildContextSummary(jid: string): string {
    const goal = this.list(jid).find((item) => isActive(item.status));
    if (!goal) return "[GOAL]\nNo hay goal activo.";
    const tasklist = this.deps.tasklists.get(jid, goal.tasklistId);
    return [
      "[GOAL ACTIVO — estado autoritativo]",
      `${goal.id} | ${goal.status} | iteración ${goal.iteration}/${goal.maxIterations}`,
      `Objetivo: ${goal.objective}`,
      goal.currentActivity ? `Actividad actual: ${goal.currentActivity}` : "",
      goal.pendingInstructions?.length ? `Instrucciones nuevas pendientes: ${goal.pendingInstructions.join(" | ")}` : "",
      tasklist ? this.deps.tasklists.format(tasklist) : "Tasklist no disponible",
      "El goal corre en segundo plano. No bloquees el chat ni lo declares terminado hasta que el verifier lo marque completed.",
    ].join("\n");
  }

  private async verify(goal: GoalRecord, tasklist: TasklistRecord, finalContent: string, trace: GoalToolTrace[], signal: AbortSignal): Promise<GoalVerifierResult> {
    const config = this.deps.getLlmConfig();
    const model = this.deps.getModel(goal.jid);
    if (!config || !model) return { complete: false, missing: ["Proveedor o modelo no disponible para ejecutar el verifier."], reason: "No hay LLM disponible." };
    const workspaceSnapshot = this.deps.workspace.listRecursive(goal.jid, ".", 250).join("\n");
    const recentTrace = trace.slice(-24).map((item) => [
      `TOOL ${item.name}`,
      `ARGS ${truncate(JSON.stringify(item.args), 1600)}`,
      `RESULT ${truncate(item.result, 4000)}`,
    ].join("\n")).join("\n\n");
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "Eres el verifier estricto de un agente autónomo.",
          "Determina si el objetivo original está REALMENTE completado usando solo evidencia disponible.",
          "No confíes en una afirmación de 'terminé' si la tasklist, resultados de tools, archivos o pruebas no la respaldan.",
          "Si el objetivo implica crear/modificar código, exige evidencia de archivos y una validación razonable (tests/build/sintaxis) cuando sea posible.",
          "Si implica investigación, exige que la evidencia venga de búsquedas/agentes/fuentes y que los requisitos solicitados estén cubiertos.",
          "Responde exclusivamente JSON válido: {\"complete\":boolean,\"missing\":[string],\"reason\":string}.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `OBJETIVO ORIGINAL:\n${goal.objective}`,
          (goal.instructionHistory?.length || goal.pendingInstructions?.length)
            ? `REQUISITOS/CORRECCIONES POSTERIORES DEL USUARIO — forman parte obligatoria del objetivo efectivo:\n${[...(goal.instructionHistory ?? []), ...(goal.pendingInstructions ?? [])].map((item) => `- ${item}`).join("\n")}`
            : "",
          `TASKLIST:\n${this.deps.tasklists.format(tasklist)}`,
          `RESPUESTA/RESUMEN DEL EJECUTOR:\n${truncate(finalContent, 8000)}`,
          `TRAZA RECIENTE DE TOOLS:\n${recentTrace || "sin tools"}`,
          `WORKDIR ACTUAL:\n${truncate(workspaceSnapshot, 12000)}`,
        ].join("\n\n"),
      },
    ];
    const raw = await chatCompletion(messages, model, config, 2, 1800, { jid: goal.jid, purpose: "goal-verifier" }, signal);
    return parseVerifier(raw);
  }

  private progressSignature(jid: string, tasklist: TasklistRecord): string {
    // Solo cuenta archivos de trabajo. Los registros autoritativos del runtime
    // viven fuera del workdir, pero también excluimos metadatos heredados que
    // cambian por sí solos y falsearían la detección de progreso.
    const tree = this.deps.workspace.listRecursive(jid, ".", 220)
      .filter((line) => !/(^|\/)tasks\.json(?:\s|$)|(^|\/)artifacts\.json(?:\s|$)/i.test(line))
      .join("\n");
    return JSON.stringify({
      items: tasklist.items.map((item) => [item.id, item.status, item.text, item.evidence ?? ""]),
      tree,
    });
  }

  private tasklistStillGeneric(tasklist: TasklistRecord): boolean {
    const generic = [
      "Inspeccionar el objetivo y convertirlo en una tasklist específica y verificable",
      "Ejecutar todos los pasos necesarios, investigando o creando archivos cuando haga falta",
      "Validar el resultado completo contra el objetivo original",
    ];
    return tasklist.items.length === generic.length
      && tasklist.items.every((item, index) => item.text === generic[index]);
  }

  private async run(initial: GoalRecord, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    let goal = this.patch(initial.jid, initial.id, { status: "running", startedAt: initial.startedAt ?? new Date().toISOString(), error: undefined, currentPhase: "planning", currentActivity: "Preparando ejecución autónoma", currentTool: undefined, lastEventAt: new Date().toISOString() })!;
    let previousSignature = "";

    while (!signal.aborted && goal.iteration < goal.maxIterations) {
      const config = this.deps.getLlmConfig();
      const model = this.deps.getModel(goal.jid);
      if (!config || !model) throw new Error("No hay proveedor/modelo disponible para continuar el goal.");
      const tasklist = this.deps.tasklists.get(goal.jid, goal.tasklistId);
      if (!tasklist) throw new Error(`Tasklist ${goal.tasklistId} no encontrada.`);
      const iteration = goal.iteration + 1;
      goal = this.patch(goal.jid, goal.id, { iteration, status: "running", currentPhase: "executing", currentActivity: `Ejecutando iteración ${iteration}/${goal.maxIterations}`, currentTool: undefined, lastEventAt: new Date().toISOString() })!;
      const pendingInstructions = [...(goal.pendingInstructions ?? [])];
      const tools = this.deps.getTools(goal.jid);
      const trace: GoalToolTrace[] = [];
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: [
            "Eres el ejecutor autónomo de un /goal de Luna. Trabajas en segundo plano hasta completar el objetivo, no hasta producir una respuesta plausible.",
            `Goal: ${goal.id}. Tasklist obligatoria: ${goal.tasklistId}.`,
            "Al inicio inspecciona la tasklist. Si todavía es genérica, reemplázala con tasklist_replace por pasos específicos, verificables y completos.",
            "Actualiza tasklist_update después de cada avance importante. No marques completed sin evidencia concreta en evidence.",
            "Puedes crear/leer/editar/buscar/mover/copiar archivos en el workdir y ejecutar Bash/Python/Node/Bun cuando el runtime esté disponible. Usa workspace_exec para tests, builds y scripts finitos; no inventes su resultado.",
            "Si el objetivo requiere dejar un bot, servidor o servicio ejecutándose después de este turno, usa process_start. Verifica process_status/process_logs, corrige errores y reinicia cuando sea necesario; no mantengas un workspace_exec infinito.",
            "Cuando falte documentación o información actual, delega con spawn_agents. Usa researcher-web si api-search está disponible y browser-web en caso contrario o para navegación/scraping. Pide al investigador guardar documentación útil en Markdown dentro de su carpeta de tarea cuando vaya a ser necesaria para continuar la implementación.",
            "Si después de una investigación aún falta un dato, realiza otra investigación enfocada únicamente en el hueco restante; no abandones el goal por un primer intento incompleto.",
            "Para imágenes útiles a modelos sin visión, delega browser-web hacia páginas de archivo de Wikimedia Commons: conserva URL de la página File:, descripción textual, autor/licencia cuando estén visibles y descarga el recurso si el objetivo lo necesita. No adivines el contenido visual.",
            "No salgas del workdir. No uses terminal para escribir archivos cuando existe una tool de filesystem más precisa, salvo que el propio build/script deba generarlos.",
            "No hagas git push, despliegues, pagos, cambios de seguridad ni acciones externas irreversibles salvo que el objetivo del usuario las autorice explícitamente.",
            "Cuando creas que terminaste, deja todos los pasos verificables en completed y entrega un resumen final conciso. Un verifier independiente decidirá si realmente terminó; si falla, recibirás sus huecos en otra iteración.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `OBJETIVO ORIGINAL:\n${goal.objective}`,
            `ESTADO ACTUAL:\n${this.deps.tasklists.format(tasklist)}`,
            goal.verifierFeedback ? `FEEDBACK DEL VERIFIER ANTERIOR:\n${goal.verifierFeedback}` : "",
            pendingInstructions.length ? `NUEVAS INSTRUCCIONES DEL USUARIO — son obligatorias y corrigen/amplían el objetivo:\n${pendingInstructions.map((item) => `- ${item}`).join("\n")}` : "",
            `WORKDIR (vista parcial):\n${truncate(this.deps.workspace.listRecursive(goal.jid, ".", 180).join("\n"), 10000)}`,
            `ITERACIÓN: ${iteration}/${goal.maxIterations}`,
            "Continúa desde el estado actual. No repitas trabajo ya evidenciado.",
          ].filter(Boolean).join("\n\n"),
        },
      ];
      const result = await chatCompletionWithTools(
        messages,
        model,
        config,
        tools,
        async (name, args) => {
          const delegating = name === "spawn_agents" || name === "researcher_web" || name === "browser_agent";
          this.patch(goal.jid, goal.id, {
            currentPhase: delegating ? "delegating" : "executing",
            currentTool: name,
            currentActivity: delegating
              ? `Investigando/delegando mediante ${name}`
              : `Ejecutando ${name}`,
            lastEventAt: new Date().toISOString(),
          });
          const toolResult = await this.deps.executeTool(goal.jid, goal.id, goal.tasklistId, name, args, signal);
          trace.push({ name, args: structuredClone(args), result: toolResult });
          this.patch(goal.jid, goal.id, {
            currentPhase: "executing",
            currentTool: undefined,
            currentActivity: `Procesando resultado de ${name}`,
            lastToolResult: truncate(toolResult, 1200),
            lastEventAt: new Date().toISOString(),
          });
          return toolResult;
        },
        3,
        undefined,
        { maxRounds: 36, maxTokens: 7000, truncationRecoveryAttempts: 2, signal, usage: { jid: goal.jid, purpose: "goal" } },
      );
      if (signal.aborted) break;
      if (pendingInstructions.length) {
        const latestForInstructions = this.get(goal.jid, goal.id)!;
        const remaining = (latestForInstructions.pendingInstructions ?? []).filter((item) => !pendingInstructions.includes(item));
        goal = this.patch(goal.jid, goal.id, {
          pendingInstructions: remaining,
          instructionHistory: [...(latestForInstructions.instructionHistory ?? []), ...pendingInstructions].slice(-50),
        })!;
      }
      // Refrescar el goal justo antes de verificar. Una instrucción puede llegar
      // mientras la iteración estaba ejecutándose; si no la hemos procesado todavía,
      // debe impedir que el verifier cierre el objetivo viejo por una carrera.
      goal = this.get(goal.jid, goal.id) ?? goal;
      this.patch(goal.jid, goal.id, { currentPhase: "verifying", currentTool: undefined, currentActivity: "Verificando evidencia y requisitos pendientes", lastEventAt: new Date().toISOString() });
      const after = this.deps.tasklists.get(goal.jid, goal.tasklistId)!;
      const deterministicPending = (goal.pendingInstructions?.length ?? 0) > 0
        || this.tasklistStillGeneric(after)
        || after.items.length < 2
        || after.items.some((item) => item.status === "pending" || item.status === "in_progress" || item.status === "blocked");
      let verifier: GoalVerifierResult;
      if (deterministicPending) {
        const pending = after.items.filter((item) => item.status === "pending" || item.status === "in_progress" || item.status === "blocked").map((item) => `${item.id}: ${item.text} [${item.status}]`).slice(0, 12);
        const genericMissing = this.tasklistStillGeneric(after)
          ? ["Reemplaza la tasklist genérica inicial por pasos específicos y verificables para este objetivo."]
          : [];
        verifier = {
          complete: false,
          missing: genericMissing.length ? genericMissing : (pending.length ? pending : ["La tasklist debe contener al menos dos pasos específicos."]),
          reason: genericMissing.length ? "La planificación inicial aún no fue concretada." : "La tasklist todavía tiene trabajo pendiente o bloqueado.",
        };
      } else {
        verifier = await this.verify(goal, after, result.content, trace, signal);
      }
      if (verifier.complete) {
        goal = this.patch(goal.jid, goal.id, {
          status: "completed",
          completedAt: new Date().toISOString(),
          lastSummary: result.content.trim() || "Objetivo completado y verificado.",
          verifierFeedback: verifier.reason,
          error: undefined,
          currentPhase: "idle",
          currentActivity: "Objetivo completado y verificado",
          currentTool: undefined,
          lastEventAt: new Date().toISOString(),
        })!;
        await this.deps.onCompleted?.(goal.jid, goal, [
          `✅ Goal ${goal.id} completado y verificado.`,
          "",
          goal.lastSummary ?? verifier.reason,
        ].join("\n"));
        return;
      }

      const feedback = [verifier.reason, ...verifier.missing.map((item) => `- ${item}`)].filter(Boolean).join("\n");
      if (verifier.missing.length) {
        this.deps.tasklists.addItems(goal.jid, goal.tasklistId, verifier.missing.map((item) => `Resolver verificación: ${item}`));
      }
      const current = this.deps.tasklists.get(goal.jid, goal.tasklistId)!;
      const signature = this.progressSignature(goal.jid, current);
      const noProgressIterations = signature === previousSignature ? goal.noProgressIterations + 1 : 0;
      previousSignature = signature;
      goal = this.patch(goal.jid, goal.id, {
        lastSummary: result.content.trim() || goal.lastSummary,
        verifierFeedback: feedback,
        noProgressIterations,
        currentPhase: "planning",
        currentActivity: "Verifier encontró pendientes; preparando la siguiente iteración",
        currentTool: undefined,
        lastEventAt: new Date().toISOString(),
      })!;
      await this.deps.onProgress?.(goal.jid, `🎯 ${goal.id}: verificación incompleta; continúo automáticamente.\nIteración ${goal.iteration}/${goal.maxIterations} · ${this.deps.tasklists.progress(current).done}/${current.items.length} pasos completados.`);
      if (noProgressIterations >= 3) {
        goal = this.patch(goal.jid, goal.id, { status: "failed", completedAt: new Date().toISOString(), error: `Sin progreso verificable durante ${noProgressIterations} iteraciones. ${feedback}` })!;
        await this.deps.onCompleted?.(goal.jid, goal, `⚠️ Goal ${goal.id} detenido por falta de progreso verificable.\n${feedback}`);
        return;
      }
    }

    if (signal.aborted) {
      this.patch(goal.jid, goal.id, { status: "cancelled", completedAt: new Date().toISOString(), error: "Cancelado por el usuario." });
      return;
    }
    goal = this.patch(goal.jid, goal.id, { status: "failed", completedAt: new Date().toISOString(), error: `Se alcanzó el máximo de ${goal.maxIterations} iteraciones sin completar la verificación.` })!;
    await this.deps.onCompleted?.(goal.jid, goal, `⚠️ Goal ${goal.id} alcanzó su límite de iteraciones sin superar la verificación final.`);
  }
}
