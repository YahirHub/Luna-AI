import type { ToolDefinition } from "../ai.ts";
import { chatCompletionWithTools, type ChatMessage } from "../ai.ts";
import type { AgentConfig, SearchDepth } from "../agent-config.ts";
import type { LlmConfig } from "../llm-config.ts";
import { runResearchSubagent } from "../research-agent.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { createPdfFromMarkdown } from "../artifacts/pdf.ts";
import type { TaskRuntime } from "./task-runtime.ts";

export interface ResearchTopic {
  name: string;
  query: string;
}

export type ParallelResearchProgress =
  | { type: "task_started"; taskId: string; total: number }
  | { type: "worker_started"; name: string; index: number; total: number }
  | { type: "worker_completed"; name: string; status: "complete" | "failed"; completed: number; total: number }
  | { type: "synthesizing"; successful: number; failed: number }
  | { type: "artifact_created"; path: string }
  | { type: "completed"; taskId: string; status: "completed" | "partial" };

export type ParallelResearchProgressHandler = (event: ParallelResearchProgress) => void | Promise<void>;

export interface ParallelResearchOptions {
  jid: string;
  title: string;
  topics: ResearchTopic[];
  depth: SearchDepth;
  model: string;
  llmConfig: LlmConfig;
  agentConfig: AgentConfig;
  workspace: WorkspaceManager;
  tasks: TaskRuntime;
  onProgress?: ParallelResearchProgressHandler;
  deliver?: (path: string, caption: string) => Promise<void>;
  deliverResult: boolean;
}

interface WorkerResult {
  name: string;
  query: string;
  status: "complete" | "failed";
  markdownPath: string;
  resultPath: string;
  evidencePath: string;
  content: string;
  error?: string;
}

export const PARALLEL_RESEARCH_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "parallel_research_report",
      description: "ÚSALA UNA SOLA VEZ cuando el usuario pida comparar dos o más temas independientes. Divide la investigación entre subagentes web aislados, guarda un Markdown por tema, continúa aunque alguno falle, sintetiza una tabla final, crea el PDF y lo entrega por WhatsApp por defecto. No hace falta llamar después create_pdf_from_markdown ni whatsapp_send.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Título del informe final." },
          topics: {
            type: "array",
            minItems: 2,
            maxItems: 8,
            items: {
              type: "object",
              properties: { name: { type: "string" }, query: { type: "string" } },
              required: ["name", "query"],
              additionalProperties: false,
            },
          },
          depth: { type: "string", enum: ["standard", "deep"] },
          deliver: { type: "boolean", description: "Entrega el PDF al mismo usuario al terminar. Predeterminado: true." },
        },
        required: ["title", "topics"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_list",
      description: "Lista las tareas de subagentes recientes del usuario.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "task_status",
      description: "Consulta el estado y artefactos de una tarea de subagentes.",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "task_cancel",
      description: "Cancela una tarea activa de subagentes.",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false },
    },
  },
];

function slug(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "tema";
}

function sourceUrls(content: string): string[] {
  const urls = content.match(/https?:\/\/[^\s)\]}>"']+/gi) ?? [];
  return [...new Set(urls.map((url) => url.replace(/[.,;:!?]+$/, "")))].slice(0, 100);
}

function evidenceJsonl(topic: ResearchTopic, content: string, status: "complete" | "failed", error?: string): string {
  const rows: Array<Record<string, unknown>> = [{
    type: "worker_result",
    at: new Date().toISOString(),
    topic: topic.name,
    query: topic.query,
    status,
    error,
  }];
  for (const url of sourceUrls(content)) rows.push({ type: "source", url });
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function emit(handler: ParallelResearchProgressHandler | undefined, event: ParallelResearchProgress): Promise<void> {
  try {
    await handler?.(event);
  } catch (error) {
    console.warn("[orchestrator] No se pudo emitir progreso:", error);
  }
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(item, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function synthesisMessages(title: string, results: WorkerResult[]): ChatMessage[] {
  const evidence = results.map((result) => [
    `## ${result.name}`,
    `Estado: ${result.status}`,
    `Consulta: ${result.query}`,
    result.content,
    ...(result.error ? [`Error: ${result.error}`] : []),
  ].join("\n")).join("\n\n---\n\n");
  return [
    {
      role: "system",
      content: [
        "Eres el sintetizador final de una investigación paralela de Luna AI.",
        "Usa exclusivamente los resultados entregados por los trabajadores.",
        "Crea un informe Markdown autocontenido en español.",
        "Incluye un título, resumen ejecutivo, una tabla comparativa cuando los temas sean comparables, detalles por tema, advertencias por resultados fallidos o parciales y fuentes completas.",
        "No ocultes fallos. Si falta un dato, escribe No verificado.",
        "No menciones prompts ni herramientas internas.",
      ].join("\n"),
    },
    { role: "user", content: `Título solicitado: ${title}\n\nResultados de subagentes:\n\n${evidence}` },
  ];
}

export async function runParallelResearch(options: ParallelResearchOptions): Promise<string> {
  const topics = options.topics
    .map((topic) => ({ name: topic.name.trim(), query: topic.query.trim() }))
    .filter((topic) => topic.name && topic.query)
    .slice(0, 8);
  if (topics.length < 2) return "Error: se requieren al menos dos temas válidos para una investigación paralela.";
  const task = options.tasks.create(options.jid, options.title, topics.length);
  const taskBase = task.record.taskPath;
  await emit(options.onProgress, { type: "task_started", taskId: task.record.id, total: topics.length });
  let completed = 0;

  try {
    const settled = await runWithConcurrency(topics, 4, async (topic, index): Promise<WorkerResult> => {
      if (task.signal.aborted) throw task.signal.reason;
      await emit(options.onProgress, { type: "worker_started", name: topic.name, index, total: topics.length });
      const workerDir = `${taskBase}/agents/${slug(topic.name)}`;
      options.workspace.writeText(options.jid, `${workerDir}/request.json`, `${JSON.stringify(topic, null, 2)}\n`);
      try {
        const content = await runResearchSubagent({
          query: topic.query,
          model: options.model,
          llmConfig: options.llmConfig,
          agentConfig: options.agentConfig,
          depth: options.depth,
          signal: task.signal,
        });
        const failed = content.startsWith("Error:");
        const markdownPath = `${workerDir}/precios-${slug(topic.name)}.md`;
        const resultPath = `${workerDir}/result.json`;
        const evidencePath = `${workerDir}/evidence.jsonl`;
        const status = failed ? "failed" : "complete";
        const markdown = [`# ${topic.name}`, "", `Consulta: ${topic.query}`, "", content].join("\n");
        options.workspace.writeText(options.jid, markdownPath, markdown);
        options.workspace.writeText(options.jid, evidencePath, evidenceJsonl(topic, content, status, failed ? content : undefined));
        options.workspace.writeText(options.jid, resultPath, `${JSON.stringify({ status, name: topic.name, query: topic.query, markdownPath, evidencePath, content }, null, 2)}\n`);
        completed += 1;
        options.tasks.update(options.jid, task.record.id, { completedWorkers: completed });
        await emit(options.onProgress, { type: "worker_completed", name: topic.name, status: failed ? "failed" : "complete", completed, total: topics.length });
        return { name: topic.name, query: topic.query, status, markdownPath, resultPath, evidencePath, content, error: failed ? content : undefined };
      } catch (error) {
        completed += 1;
        const reason = error instanceof Error ? error.message : String(error);
        const markdownPath = `${workerDir}/precios-${slug(topic.name)}.md`;
        const resultPath = `${workerDir}/result.json`;
        const evidencePath = `${workerDir}/evidence.jsonl`;
        options.workspace.writeText(options.jid, markdownPath, `# ${topic.name}\n\nEstado: fallido\n\nError: ${reason}\n`);
        options.workspace.writeText(options.jid, evidencePath, evidenceJsonl(topic, "", "failed", reason));
        options.workspace.writeText(options.jid, resultPath, `${JSON.stringify({ status: "failed", name: topic.name, query: topic.query, markdownPath, evidencePath, error: reason }, null, 2)}\n`);
        options.tasks.update(options.jid, task.record.id, { completedWorkers: completed });
        await emit(options.onProgress, { type: "worker_completed", name: topic.name, status: "failed", completed, total: topics.length });
        return { name: topic.name, query: topic.query, status: "failed", markdownPath, resultPath, evidencePath, content: "", error: reason };
      }
    });

    if (task.signal.aborted) throw task.signal.reason;
    const results: WorkerResult[] = settled.map((item, index) => {
      if (item.status === "fulfilled") return item.value;
      const topic = topics[index] ?? { name: `Tema ${index + 1}`, query: "" };
      return { name: topic.name, query: topic.query, status: "failed", markdownPath: "", resultPath: "", evidencePath: "", content: "", error: item.reason instanceof Error ? item.reason.message : String(item.reason) };
    });
    const successful = results.filter((item) => item.status === "complete").length;
    const failed = results.length - successful;
    options.tasks.update(options.jid, task.record.id, { status: "synthesizing" });
    await emit(options.onProgress, { type: "synthesizing", successful, failed });

    let report: string;
    try {
      const synthesized = await chatCompletionWithTools(
        synthesisMessages(options.title, results),
        options.model,
        options.llmConfig,
        [],
        async () => "Error: no hay herramientas durante la síntesis.",
        2,
        undefined,
        { maxRounds: 1, signal: task.signal },
      );
      report = synthesized.content.trim();
    } catch (error) {
      report = [
        `# ${options.title}`,
        "",
        "La síntesis automática falló; se conservan los resultados individuales.",
        "",
        ...results.flatMap((item) => [`## ${item.name}`, "", item.content || `No verificado: ${item.error ?? "fallo desconocido"}`, ""]),
      ].join("\n");
    }
    if (!report) report = `# ${options.title}\n\nNo fue posible generar una síntesis útil.`;

    const reportSlug = slug(options.title);
    const synthesisMarkdownPath = `${taskBase}/synthesis/${reportSlug}.md`;
    const synthesisResultPath = `${taskBase}/synthesis/result.json`;
    const mdPath = `${taskBase}/artifacts/${reportSlug}.md`;
    const pdfPath = `${taskBase}/artifacts/${reportSlug}.pdf`;
    options.workspace.writeText(options.jid, synthesisMarkdownPath, `${report}\n`);
    options.workspace.writeText(options.jid, synthesisResultPath, `${JSON.stringify({
      title: options.title,
      status: failed > 0 ? "partial" : "completed",
      successfulWorkers: successful,
      failedWorkers: failed,
      sources: results.flatMap((result) => sourceUrls(result.content)),
      workerResults: results.map(({ content: _content, ...result }) => result),
      markdownPath: mdPath,
      pdfPath,
    }, null, 2)}\n`);
    options.workspace.writeText(options.jid, mdPath, `${report}\n`);
    options.workspace.writeBuffer(options.jid, pdfPath, createPdfFromMarkdown(report));
    options.workspace.registerArtifact(options.jid, mdPath, "parallel_research_report", { taskId: task.record.id });
    options.workspace.registerArtifact(options.jid, pdfPath, "parallel_research_report", { taskId: task.record.id });
    await emit(options.onProgress, { type: "artifact_created", path: pdfPath });

    const status = failed > 0 ? "partial" : "completed";
    options.tasks.update(options.jid, task.record.id, { status, artifacts: [mdPath, pdfPath] });
    if (options.deliverResult && options.deliver) {
      await options.deliver(pdfPath, failed > 0
        ? `Informe ${options.title}. Se completó con ${successful} de ${results.length} investigaciones verificadas.`
        : `Informe completado: ${options.title}`);
    }
    await emit(options.onProgress, { type: "completed", taskId: task.record.id, status });
    return [
      `✅ Investigación paralela ${status === "partial" ? "completada parcialmente" : "completada"}.`,
      `Tarea: ${task.record.id}`,
      `Subagentes correctos: ${successful}/${results.length}`,
      `Markdown: ${mdPath}`,
      `PDF: ${pdfPath}`,
      ...(failed ? [`Fallos: ${failed}. El informe los marca como no verificados.`] : []),
    ].join("\n");
  } catch (error) {
    const cancelled = task.signal.aborted;
    const reason = error instanceof Error ? error.message : String(error);
    options.tasks.update(options.jid, task.record.id, { status: cancelled ? "cancelled" : "failed", error: reason });
    return cancelled ? `Error: la tarea ${task.record.id} fue cancelada.` : `Error: la tarea ${task.record.id} falló: ${reason}`;
  }
}

export async function executeTaskTool(name: string, args: Record<string, unknown>, options: Omit<ParallelResearchOptions, "title" | "topics" | "depth" | "deliverResult">): Promise<string> {
  if (name === "task_list") {
    const tasks = options.tasks.list(options.jid);
    if (!tasks.length) return "No hay tareas registradas.";
    return tasks.map((task, index) => `${index + 1}. ${task.id} — ${task.status} — ${task.title} — ${task.completedWorkers}/${task.totalWorkers}`).join("\n");
  }
  const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  if (!taskId) return "Error: task_id es obligatorio.";
  if (name === "task_status") {
    const task = options.tasks.get(options.jid, taskId);
    return task ? JSON.stringify(task, null, 2) : `Error: no existe la tarea ${taskId}.`;
  }
  if (name === "task_cancel") return options.tasks.cancel(options.jid, taskId) ? `✅ Tarea ${taskId} cancelada.` : `Error: no se encontró una tarea activa con ID ${taskId}.`;
  return `Error: herramienta de tareas desconocida "${name}".`;
}
