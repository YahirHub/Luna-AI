import type { ToolDefinition } from "../ai.ts";
import { chatCompletionWithTools, type ChatMessage } from "../ai.ts";
import type { AgentConfig, SearchDepth } from "../agent-config.ts";
import type { LlmConfig } from "../llm-config.ts";
import {
  pricingDataHasVerifiedPrices,
  runResearchSubagentDetailed,
  type PricingResearchData,
  type ResearchSubagentDetailedResult,
} from "../research-agent.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { createPdfFromMarkdown } from "../artifacts/pdf.ts";
import type { TaskRuntime } from "./task-runtime.ts";
import { debugError, debugInfo, debugLog } from "../debug.ts";

export interface ResearchTopic {
  name: string;
  query: string;
}

export type WorkerResearchStatus = "complete" | "partial" | "failed";

export type ParallelResearchProgress =
  | { type: "task_started"; taskId: string; total: number }
  | { type: "worker_started"; name: string; index: number; total: number }
  | { type: "worker_completed"; name: string; status: WorkerResearchStatus; completed: number; total: number }
  | { type: "synthesizing"; successful: number; partial: number; failed: number }
  | { type: "artifact_created"; path: string }
  | { type: "completed"; taskId: string; status: "completed" | "partial" | "failed" };

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
  researchRunner?: typeof runResearchSubagentDetailed;
}

interface WorkerResult {
  name: string;
  query: string;
  status: WorkerResearchStatus;
  markdownPath: string;
  resultPath: string;
  evidencePath: string;
  content: string;
  verifiedSources: string[];
  pricing?: PricingResearchData;
  issues: string[];
  discoveryMode?: ResearchSubagentDetailedResult["discoveryMode"];
  error?: string;
}

export const PARALLEL_RESEARCH_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "parallel_research_report",
      description: "ÚSALA UNA SOLA VEZ cuando el usuario pida comparar dos o más temas independientes. Divide la investigación entre subagentes web aislados, abre y extrae fuentes oficiales, guarda un Markdown por tema, continúa aunque alguno falle, sintetiza una tabla final, crea el PDF y lo entrega por WhatsApp por defecto. En comparativas de precios, si el usuario solo nombra un proveedor, investiga sus modelos API activos actuales; no elijas familias antiguas por tu cuenta. Solo limita la búsqueda a modelos concretos cuando el usuario los haya nombrado. Esta herramienta completa toda la tarea: no llames después research_web, create_pdf_from_markdown ni whatsapp_send para el mismo informe.",
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
              properties: {
                name: { type: "string", description: "Proveedor, producto o tema aislado." },
                query: { type: "string", description: "Consulta dirigida a fuentes oficiales. Para precios genéricos de un proveedor, pide modelos API activos actuales y no presupongas modelos heredados." },
              },
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

function isPricingReport(title: string, topics: ResearchTopic[]): boolean {
  return /\b(precios?|pricing|costos?|tarifas?)\b/i.test([title, ...topics.map((topic) => topic.query)].join(" "));
}

function evidenceJsonl(topic: ResearchTopic, result: ResearchSubagentDetailedResult): string {
  const rows: Array<Record<string, unknown>> = [{
    type: "worker_result",
    at: new Date().toISOString(),
    topic: topic.name,
    query: topic.query,
    status: result.status,
    issues: result.issues,
  }];
  for (const source of result.verifiedSources) {
    rows.push({
      type: source.content ? "verified_source" : "source_error",
      url: source.url,
      title: source.title,
      snippet: source.snippet,
      error: source.error,
      contentChars: source.content?.length ?? 0,
    });
  }
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
    `Fuentes abiertas: ${result.verifiedSources.join(", ") || "ninguna"}`,
    result.content,
    ...(result.issues.length > 0 ? [`Advertencias: ${result.issues.join(" ")}`] : []),
    ...(result.error ? [`Error: ${result.error}`] : []),
  ].join("\n")).join("\n\n---\n\n");
  return [
    {
      role: "system",
      content: [
        "Eres el sintetizador final de una investigación paralela de Luna AI.",
        "Usa exclusivamente los resultados entregados por los trabajadores y sus fuentes abiertas.",
        "Crea un informe Markdown autocontenido en español.",
        "Incluye un título, resumen ejecutivo, una tabla comparativa cuando los temas sean comparables, detalles por tema, advertencias por resultados fallidos o parciales y fuentes completas.",
        "La tabla debe ser Markdown válido: encabezado, línea separadora y todas las filas con exactamente el mismo número de columnas.",
        "No uses más de seis columnas ni introduzcas saltos de línea o caracteres | dentro de una celda.",
        "No ocultes fallos. Si falta un dato, escribe No verificado.",
        "No menciones prompts ni herramientas internas.",
      ].join("\n"),
    },
    { role: "user", content: `Título solicitado: ${title}\n\nResultados de subagentes:\n\n${evidence}` },
  ];
}

function safeCell(value: string | null | undefined): string {
  return (value?.trim() || "No verificado").replace(/\|/g, "/").replace(/\s+/g, " ");
}

function buildPricingReport(title: string, results: WorkerResult[]): string {
  const tableRows: string[] = [];
  for (const result of results) {
    const items = result.pricing?.items ?? [];
    if (items.length === 0) {
      tableRows.push(`| ${safeCell(result.name)} | No verificado | No verificado | No verificado | No verificado | ${safeCell(result.issues[0] ?? result.error ?? "Sin precios verificables")} |`);
      continue;
    }
    for (const item of items) {
      const note = [item.contextWindow, item.conditions].filter(Boolean).join("; ");
      tableRows.push([
        "|",
        safeCell(result.name),
        "|",
        safeCell(item.model),
        "|",
        safeCell(item.inputUsdPerMillion),
        "|",
        safeCell(item.outputUsdPerMillion),
        "|",
        safeCell(item.cachedInputUsdPerMillion),
        "|",
        safeCell(note),
        "|",
      ].join(" "));
    }
  }

  const partialResults = results.filter((result) => result.status !== "complete");
  const observations = results.flatMap((result) => [
    ...(result.pricing?.notes ?? []).map((note) => `${result.name}: ${note}`),
    ...result.issues.map((issue) => `${result.name}: ${issue}`),
  ]);
  const sources = [...new Set(results.flatMap((result) => [
    ...result.verifiedSources,
    ...(result.pricing?.sources ?? []),
  ]))];

  return [
    `# ${title}`,
    "",
    "> Importes expresados como USD por 1 millón de tokens cuando la fuente permitió normalizarlos. Los campos ausentes se marcan como No verificado.",
    "",
    "## Tabla comparativa",
    "",
    "| Proveedor | Modelo | Entrada USD / 1M | Salida USD / 1M | Caché USD / 1M | Contexto y condiciones |",
    "|---|---|---:|---:|---:|---|",
    ...tableRows,
    "",
    "## Estado de la investigación",
    "",
    ...results.map((result) => {
      const state = result.status === "complete" ? "verificado" : result.status === "partial" ? "parcial" : "fallido";
      const mode = result.discoveryMode === "direct_official"
        ? "lectura directa de fuente oficial, sin buscador"
        : result.discoveryMode === "search_and_fetch"
          ? "búsqueda y lectura de fuentes"
          : result.discoveryMode === "search_only"
            ? "solo búsqueda"
            : "sin modo de descubrimiento confirmado";
      return `- ${result.name}: ${state} (${result.verifiedSources.length} fuente(s) abierta(s); ${mode}).`;
    }),
    ...(partialResults.length > 0 ? ["", `Se conservaron ${partialResults.length} resultado(s) parcial(es) o fallido(s) sin inventar datos.`] : []),
    ...(observations.length > 0 ? ["", "## Observaciones", "", ...observations.map((note) => `- ${note}`)] : []),
    "",
    "## Fuentes abiertas y verificadas",
    "",
    ...(sources.length > 0 ? sources.map((url) => `- ${url}`) : ["- No se pudo abrir ninguna fuente verificable."]),
  ].join("\n");
}

export async function runParallelResearch(options: ParallelResearchOptions): Promise<string> {
  const topics = options.topics
    .map((topic) => ({ name: topic.name.trim(), query: topic.query.trim() }))
    .filter((topic) => topic.name && topic.query)
    .slice(0, 8);
  if (topics.length < 2) return "Error: se requieren al menos dos temas válidos para una investigación paralela.";
  const pricingReport = isPricingReport(options.title, topics);
  const task = options.tasks.create(options.jid, options.title, topics.length);
  const researchRunner = options.researchRunner ?? runResearchSubagentDetailed;
  const taskBase = task.record.taskPath;
  debugInfo("orchestrator.task", "started", {
    taskId: task.record.id,
    jid: options.jid,
    title: options.title,
    pricingReport,
    depth: options.depth,
    model: options.model,
    topics,
  });
  await emit(options.onProgress, { type: "task_started", taskId: task.record.id, total: topics.length });
  let completed = 0;

  try {
    const settled = await runWithConcurrency(topics, 4, async (topic, index): Promise<WorkerResult> => {
      if (task.signal.aborted) throw task.signal.reason;
      await emit(options.onProgress, { type: "worker_started", name: topic.name, index, total: topics.length });
      debugInfo("orchestrator.worker", "started", {
        taskId: task.record.id,
        workerIndex: index,
        totalWorkers: topics.length,
        name: topic.name,
        query: topic.query,
        pricingReport,
      });
      const workerDir = `${taskBase}/agents/${slug(topic.name)}`;
      options.workspace.writeText(options.jid, `${workerDir}/request.json`, `${JSON.stringify({ ...topic, kind: pricingReport ? "pricing" : "general" }, null, 2)}\n`);
      try {
        const research = await researchRunner({
          query: topic.query,
          model: options.model,
          llmConfig: options.llmConfig,
          agentConfig: options.agentConfig,
          depth: options.depth,
          signal: task.signal,
          requirements: {
            kind: pricingReport ? "pricing" : "general",
            subject: topic.name,
            minimumVerifiedSources: 1,
          },
        });
        const markdownPath = `${workerDir}/${pricingReport ? "precios" : "resultado"}-${slug(topic.name)}.md`;
        const resultPath = `${workerDir}/result.json`;
        const evidencePath = `${workerDir}/evidence.jsonl`;
        const markdown = research.content || `# ${topic.name}\n\nEstado: ${research.status}\n\n${research.issues.join(" ")}`;
        options.workspace.writeText(options.jid, markdownPath, `${markdown}\n`);
        options.workspace.writeText(options.jid, evidencePath, evidenceJsonl(topic, research));
        options.workspace.writeText(options.jid, resultPath, `${JSON.stringify({
          status: research.status,
          name: topic.name,
          query: topic.query,
          markdownPath,
          evidencePath,
          verifiedSources: research.verifiedSources.map((source) => ({
            url: source.url,
            title: source.title,
            error: source.error,
            contentChars: source.content?.length ?? 0,
          })),
          pricing: research.pricing,
          issues: research.issues,
          toolsCalled: research.toolsCalled,
          discoveryMode: research.discoveryMode,
        }, null, 2)}\n`);
        completed += 1;
        options.tasks.update(options.jid, task.record.id, { completedWorkers: completed });
        debugInfo("orchestrator.worker", "completed", {
          taskId: task.record.id,
          name: topic.name,
          status: research.status,
          completedWorkers: completed,
          totalWorkers: topics.length,
          toolsCalled: research.toolsCalled,
          searchResults: research.searchResults.length,
          verifiedSources: research.verifiedSources.length,
          readableSources: research.verifiedSources.filter((source) => Boolean(source.content)).length,
          pricingItems: research.pricing?.items.length ?? 0,
          pricingSources: research.pricing?.sources.length ?? 0,
          issues: research.issues,
          discoveryMode: research.discoveryMode,
          paths: { markdownPath, resultPath, evidencePath },
        });
        await emit(options.onProgress, { type: "worker_completed", name: topic.name, status: research.status, completed, total: topics.length });
        return {
          name: topic.name,
          query: topic.query,
          status: research.status,
          markdownPath,
          resultPath,
          evidencePath,
          content: markdown,
          verifiedSources: research.verifiedSources.filter((source) => Boolean(source.content)).map((source) => source.url),
          pricing: research.pricing,
          issues: research.issues,
          discoveryMode: research.discoveryMode,
          error: research.status === "failed" ? research.issues.join(" ") : undefined,
        };
      } catch (error) {
        completed += 1;
        const reason = error instanceof Error ? error.message : String(error);
        debugError("orchestrator.worker", "crashed", error, {
          taskId: task.record.id,
          name: topic.name,
          query: topic.query,
          completedWorkers: completed,
          totalWorkers: topics.length,
        });
        const markdownPath = `${workerDir}/${pricingReport ? "precios" : "resultado"}-${slug(topic.name)}.md`;
        const resultPath = `${workerDir}/result.json`;
        const evidencePath = `${workerDir}/evidence.jsonl`;
        options.workspace.writeText(options.jid, markdownPath, `# ${topic.name}\n\nEstado: fallido\n\nError: ${reason}\n`);
        options.workspace.writeText(options.jid, evidencePath, `${JSON.stringify({ type: "worker_result", at: new Date().toISOString(), topic: topic.name, query: topic.query, status: "failed", error: reason })}\n`);
        options.workspace.writeText(options.jid, resultPath, `${JSON.stringify({ status: "failed", name: topic.name, query: topic.query, markdownPath, evidencePath, error: reason }, null, 2)}\n`);
        options.tasks.update(options.jid, task.record.id, { completedWorkers: completed });
        await emit(options.onProgress, { type: "worker_completed", name: topic.name, status: "failed", completed, total: topics.length });
        return { name: topic.name, query: topic.query, status: "failed", markdownPath, resultPath, evidencePath, content: "", verifiedSources: [], issues: [reason], error: reason };
      }
    });

    if (task.signal.aborted) throw task.signal.reason;
    const results: WorkerResult[] = settled.map((item, index) => {
      if (item.status === "fulfilled") return item.value;
      const topic = topics[index] ?? { name: `Tema ${index + 1}`, query: "" };
      const reason = item.reason instanceof Error ? item.reason.message : String(item.reason);
      return { name: topic.name, query: topic.query, status: "failed", markdownPath: "", resultPath: "", evidencePath: "", content: "", verifiedSources: [], issues: [reason], error: reason };
    });
    const successful = results.filter((item) => item.status === "complete").length;
    const partial = results.filter((item) => item.status === "partial").length;
    const failed = results.filter((item) => item.status === "failed").length;
    debugInfo("orchestrator.task", "workers_settled", {
      taskId: task.record.id,
      successful,
      partial,
      failed,
      results: results.map((result) => ({
        name: result.name,
        status: result.status,
        pricingItems: result.pricing?.items.length ?? 0,
        pricingSources: result.pricing?.sources.length ?? 0,
        verifiedSources: result.verifiedSources.length,
        discoveryMode: result.discoveryMode,
        issues: result.issues,
        error: result.error,
      })),
    });
    options.tasks.update(options.jid, task.record.id, { status: "synthesizing" });
    await emit(options.onProgress, { type: "synthesizing", successful, partial, failed });

    const providersWithPrices = pricingReport
      ? results.filter((result) => result.pricing && pricingDataHasVerifiedPrices(result.pricing)).length
      : 0;
    const verifiedPriceRows = pricingReport
      ? results.reduce((total, result) => total + (result.pricing?.items.filter((item) =>
          item.inputUsdPerMillion !== null && item.outputUsdPerMillion !== null
        ).length ?? 0), 0)
      : 0;
    if (pricingReport && verifiedPriceRows === 0) {
      const reportSlug = slug(options.title);
      const report = buildPricingReport(options.title, results);
      const synthesisMarkdownPath = `${taskBase}/synthesis/${reportSlug}.md`;
      const synthesisResultPath = `${taskBase}/synthesis/result.json`;
      const mdPath = `${taskBase}/artifacts/${reportSlug}.md`;
      const reason = "Ningún investigador obtuvo importes verificables; se bloqueó la creación y el envío de un PDF vacío.";
      options.workspace.writeText(options.jid, synthesisMarkdownPath, `${report}\n`);
      options.workspace.writeText(options.jid, mdPath, `${report}\n`);
      options.workspace.writeText(options.jid, synthesisResultPath, `${JSON.stringify({
        title: options.title,
        kind: "pricing",
        status: "failed",
        successfulWorkers: successful,
        partialWorkers: partial,
        failedWorkers: failed,
        verifiedPriceRows: 0,
        error: reason,
        markdownPath: mdPath,
        pdfPath: null,
      }, null, 2)}\n`);
      options.workspace.registerArtifact(options.jid, mdPath, "parallel_research_report", { taskId: task.record.id });
      options.tasks.update(options.jid, task.record.id, { status: "failed", error: reason, artifacts: [mdPath] });
      debugError("orchestrator.task", "no_verified_prices", new Error(reason), {
        taskId: task.record.id,
        successfulWorkers: successful,
        partialWorkers: partial,
        failedWorkers: failed,
        verifiedPriceRows,
        markdownPath: mdPath,
      });
      await emit(options.onProgress, { type: "completed", taskId: task.record.id, status: "failed" });
      return [
        "⚠️ La investigación terminó sin precios verificables.",
        "No generé ni envié un PDF vacío.",
        `Tarea: ${task.record.id}`,
        `Diagnóstico Markdown: ${mdPath}`,
        "Las evidencias y errores de cada investigador quedaron guardados para revisión.",
      ].join("\n");
    }

    let report: string;
    if (pricingReport) {
      report = buildPricingReport(options.title, results);
    } else {
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
      } catch {
        report = [
          `# ${options.title}`,
          "",
          "La síntesis automática falló; se conservan los resultados individuales.",
          "",
          ...results.flatMap((item) => [`## ${item.name}`, "", item.content || `No verificado: ${item.error ?? "fallo desconocido"}`, ""]),
        ].join("\n");
      }
    }
    if (!report) report = `# ${options.title}\n\nNo fue posible generar una síntesis útil.`;

    const reportSlug = slug(options.title);
    const synthesisMarkdownPath = `${taskBase}/synthesis/${reportSlug}.md`;
    const synthesisResultPath = `${taskBase}/synthesis/result.json`;
    const mdPath = `${taskBase}/artifacts/${reportSlug}.md`;
    const pdfPath = `${taskBase}/artifacts/${reportSlug}.pdf`;
    const status = partial > 0 || failed > 0 ? "partial" : "completed";
    options.workspace.writeText(options.jid, synthesisMarkdownPath, `${report}\n`);
    options.workspace.writeText(options.jid, synthesisResultPath, `${JSON.stringify({
      title: options.title,
      kind: pricingReport ? "pricing" : "general",
      status,
      successfulWorkers: successful,
      partialWorkers: partial,
      failedWorkers: failed,
      sources: [...new Set(results.flatMap((result) => [
        ...result.verifiedSources,
        ...(result.pricing?.sources ?? []),
        ...(result.verifiedSources.length === 0 && (result.pricing?.sources.length ?? 0) === 0 ? sourceUrls(result.content) : []),
      ]))],
      workerResults: results.map(({ content: _content, pricing: _pricing, ...result }) => result),
      markdownPath: mdPath,
      pdfPath,
    }, null, 2)}\n`);
    options.workspace.writeText(options.jid, mdPath, `${report}\n`);
    debugLog("orchestrator.artifact", "rendering_pdf", {
      taskId: task.record.id,
      markdownChars: report.length,
      markdownPath: mdPath,
      pdfPath,
    });
    options.workspace.writeBuffer(options.jid, pdfPath, createPdfFromMarkdown(report));
    options.workspace.registerArtifact(options.jid, mdPath, "parallel_research_report", { taskId: task.record.id });
    options.workspace.registerArtifact(options.jid, pdfPath, "parallel_research_report", { taskId: task.record.id, sourcePath: mdPath });
    await emit(options.onProgress, { type: "artifact_created", path: pdfPath });

    options.tasks.update(options.jid, task.record.id, { status, artifacts: [mdPath, pdfPath] });
    if (options.deliverResult && options.deliver) {
      debugInfo("orchestrator.delivery", "started", { taskId: task.record.id, pdfPath, status });
      await options.deliver(pdfPath, status === "partial"
        ? `Informe ${options.title}. Proveedores con precios: ${providersWithPrices}; parciales: ${partial}; fallidos: ${failed}.`
        : `Informe completado y verificado: ${options.title}`);
      debugInfo("orchestrator.delivery", "completed", { taskId: task.record.id, pdfPath, status });
    }
    debugInfo("orchestrator.task", "completed", {
      taskId: task.record.id,
      status,
      successful,
      partial,
      failed,
      providersWithPrices,
      verifiedPriceRows,
      markdownPath: mdPath,
      pdfPath,
    });
    await emit(options.onProgress, { type: "completed", taskId: task.record.id, status });
    const directOnly = results.filter((result) => result.discoveryMode === "direct_official").length;
    return [
      `✅ Informe ${status === "partial" ? "generado con resultados parciales" : "generado y verificado"}.`,
      `Proveedores con precios extraídos: ${providersWithPrices}/${results.length}.`,
      directOnly > 0 ? `Modo directo oficial: ${directOnly}/${results.length} proveedor(es); no se usaron buscadores para esos casos.` : "",
      partial > 0 ? `Resultados parciales: ${partial}.` : "",
      failed > 0 ? `Investigaciones fallidas: ${failed}.` : "",
      options.deliverResult ? "El PDF ya fue enviado por WhatsApp." : `PDF disponible en: ${pdfPath}`,
      `Tarea: ${task.record.id}`,
    ].filter(Boolean).join("\n");
  } catch (error) {
    const cancelled = task.signal.aborted;
    const reason = error instanceof Error ? error.message : String(error);
    debugError("orchestrator.task", cancelled ? "cancelled" : "failed", error, {
      taskId: task.record.id,
      title: options.title,
      completedWorkers: completed,
      totalWorkers: topics.length,
    });
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
