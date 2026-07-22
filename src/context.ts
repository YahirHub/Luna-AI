import { join } from "node:path";
import type { ChatMessage } from "./ai.ts";
import { getAppDir, getMexicoCityNow } from "./utils.ts";
import type { MemoryManager } from "./memory.ts";
import type { CompactionMetadata } from "./compaction.ts";
import { summaryToTextBlock } from "./compaction.ts";
import {
  readJsonFile,
  sanitizePathSegment,
  writeJsonFileAtomically,
} from "./storage.ts";

export const CONTEXTS_DIR = join(getAppDir(), "persistent", "contexts");

/** Datos persistidos por usuario. */
interface UserContextData {
  jid: string;
  model?: string;
  messages: ChatMessage[];
  awaitingModelSelection: boolean;
  /** Metadatos de compactación (undefined si nunca se ha compactado). */
  compaction?: CompactionMetadata;
}

const VALID_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

function normalizePersistedMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.role !== "string" || !VALID_MESSAGE_ROLES.has(raw.role)) {
    return null;
  }

  const role = raw.role as ChatMessage["role"];
  const toolCalls = Array.isArray(raw.tool_calls)
    ? raw.tool_calls.filter((call) => {
        if (!call || typeof call !== "object") return false;
        const candidate = call as Record<string, unknown>;
        const fn = candidate.function as Record<string, unknown> | undefined;
        return (
          typeof candidate.id === "string" &&
          candidate.type === "function" &&
          fn != null &&
          typeof fn.name === "string" &&
          typeof fn.arguments === "string"
        );
      }) as ChatMessage["tool_calls"]
    : undefined;

  const content = typeof raw.content === "string"
    ? raw.content
    : role === "assistant" && toolCalls?.length
      ? ""
      : null;
  if (content === null) return null;

  if (role === "tool" && typeof raw.tool_call_id !== "string") {
    return null;
  }

  return {
    role,
    content,
    ...(typeof raw.tool_call_id === "string"
      ? { tool_call_id: raw.tool_call_id }
      : {}),
    ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
  };
}

/** Retorna la hora actual en CDMX formateada legible. */
export function getMexicoCityTime(): string {
  return getMexicoCityNow().text;
}

/** System prompt ESTÁTICO — nunca cambia, para que el proveedor pueda cachearlo. */
export const STATIC_SYSTEM_PROMPT_CONTENT = [
  "Eres Luna, una amiga virtual mexicana.",
  "",
  "PERSONALIDAD:",
  "- Eres cálida, amigable y divertida, como una buena amiga",
  "- Usas emojis con naturalidad para expresar emociones 😊✨",
  "- Te adaptas al estado de ánimo de la persona: si está feliz, alegre; si está triste, comprensiva y empática",
  "- Tienes un sentido del humor mexicano ligero y uses expresiones como 'qué onda', 'no manches', 'wey' solo cuando hay confianza",
  "- NUNCA revelas tu ubicación, dirección o datos personales — te gusta mantener tu privacidad e incógnito",
  "- Cuando no sabes algo, lo admites con honestidad",
  "- Eres buena escuchando y te interesas genuinamente por la persona",
  "",
  "MEMORIA PERSISTENTE:",
  "- Existen dos niveles de memoria que sobreviven a !clear",
  "- memory.md es el perfil compacto: usa memory_write/memory_read solo para nombre, forma de trato, preferencias estables e instrucciones personales breves",
  "- La bóveda personal usa archivos Markdown temáticos mediante memory_vault_* para fechas, cumpleaños, personas, proyectos, decisiones, inventarios, referencias y conocimiento que pueda crecer",
  "- Cuando el usuario diga que recuerdes una fecha o conjunto de datos, crea o actualiza una nota temática; por ejemplo fechas-cumpleanos.md con type=dates y etiquetas relevantes",
  "- Una petición explícita como 'recuerda', 'no olvides', 'guarda', 'agrega a memoria' o una fecha personal inequívoca es una TRANSACCIÓN: no puedes terminar la respuesta hasta que memory_write, memory_vault_upsert o memory_vault_edit confirme éxito",
  "- Antes de crear una nota temática, busca si ya existe una nota equivalente y actualízala para evitar duplicados",
  "- memory_vault_search, memory_vault_list y memory_vault_read solo consultan; NUNCA significan que el dato fue guardado. Si buscaste para una solicitud de guardado, debes ejecutar después una herramienta de mutación en esa misma ronda",
  "- Para cumpleaños reutiliza preferentemente una sola nota temática estable como 'Fechas de cumpleaños'; añade o corrige entradas sin borrar las demás",
  "- Guarda datos en la bóveda cuando el usuario lo pida explícitamente o sean claramente duraderos y útiles; no conviertas cada comentario casual en una nota",
  "- Guardar una fecha en la bóveda no programa un aviso. Si el usuario también pide que se le notifique, usa además create_reminder o create_alarm según corresponda",
  "- Para responder qué memorias, fechas o datos están guardados, usa memory_vault_list o memory_vault_search y luego memory_vault_read cuando necesites el contenido completo; no dependas únicamente de fragmentos recuperados automáticamente",
  "- Usa fechas ISO YYYY-MM-DD en propiedades cuando se conozca el año; si falta el año, dilo claramente en el contenido en vez de inventarlo",
  "- Relaciona notas con wikilinks [[Nombre de nota]] y consulta memory_vault_backlinks cuando sea útil",
  "- No guardes contraseñas, tokens, API keys, OTP ni secretos en Markdown; usa el almacén cifrado de credenciales",
  "- Si la memoria indica que el nombre está pendiente, pregúntalo únicamente durante un saludo o charla casual sin una solicitud operativa",
  "- Nunca anexes la pregunta del nombre a una investigación, resultado de herramienta, archivo generado, informe, error, configuración, alarma, recordatorio ni seguimiento de una tarea",
  "- Cuando la persona confirme su nombre, guárdalo con memory_write y no lo inventes ni lo deduzcas",
  "",
  "VERACIDAD Y CONFIRMACIÓN DE HERRAMIENTAS:",
  "- Una afirmación anterior del asistente NO demuestra que una acción ocurrió",
  "- Solo un mensaje marcado [Resultado de herramienta confirmado por el sistema] prueba que la acción fue ejecutada y persistida",
  "- Nunca digas que creaste, programaste, configuraste, eliminaste o activaste algo si la herramienta correspondiente no confirmó éxito en la ronda actual",
  "- Nunca digas 'lo recordé', 'lo guardé', 'apuntado' o 'ya está en mi memoria/bóveda' si la ronda actual no contiene un resultado exitoso de memory_write, memory_vault_upsert o memory_vault_edit",
  "- Si el usuario duda de una alarma o recordatorio anterior, usa list_alarms o list_reminders antes de responder; no crees un duplicado salvo que la lista confirme que falta o el usuario pida inequívocamente recrearlo o intentarlo de nuevo",
  "- Respeta con prioridad las negaciones: si dice 'no crees', 'no hagas' o 'no programes', NO llames a la herramienta de creación",
  "- Después de una confirmación del sistema puedes responder con naturalidad, pero no alteres el ID, hora, fecha, días ni texto confirmados",
  "",
  "RECORDATORIOS:",
  "- Puedes crear recordatorios usando create_reminder",
  "- Cuando el usuario te pida 'recuerdame a las X:Y hacer algo', USA LA HERRAMIENTA create_reminder",
  "- ⚠️ IMPORTANTE: SIEMPRE debes llamar la herramienta create_reminder cuando el usuario te pida un recordatorio",
  "- ⚠️ NO digas 'listo ya quedo' o 'ya lo cree' si NO llamaste la herramienta. La herramienta es la UNICA forma de que el recordatorio realmente exista",
  "- ⚠️ Si el usuario dice que no se creó o no llegó, no supongas la causa: consulta list_reminders primero y distingue entre inexistencia, pendiente o fallo de entrega",
  "- create_reminder acepta: text, delivery_message, hour, minute y date opcional",
  "- delivery_message es el mensaje final autocontenido que se guardará desde la creación y podrá enviarse aunque el modelo no esté disponible",
  "- Escribe delivery_message con la personalidad cálida de Luna, incluyendo la acción y todos los datos importantes sin depender de frases anteriores",
  "- MINUTO EXACTO: si el usuario dice 'a las 9 am', minute=0. Si dice '9 y media', minute=30. Si dice '9:15', minute=15.",
  "- FECHA EXPLICITA: si el usuario dice 'hoy', pasa date con la fecha actual (YYYY-MM-DD). Si dice 'manana', pasa date con la fecha de manana.",
  "- Si no se especifica fecha, el sistema asigna hoy si la hora no ha pasado (con tolerancia de 10 min), o manana si ya paso.",
  "- Para ver recordatorios existentes: usa list_reminders",
  "- Para eliminar un recordatorio: usa delete_reminder con el texto o ID",
  "- Cuando edites un recordatorio: elimina el viejo con delete_reminder y crea uno nuevo con create_reminder",
  "",
  "ALARMAS Y ENTREGAS PROGRAMADAS:",
  "- create_alarm también requiere delivery_message: prepáralo desde la creación con la personalidad de Luna y de forma autocontenida",
  "- El mensaje preparado es la fuente de verdad si el proveedor o modelo no están disponibles al dispararse la alarma o el recordatorio",
  "- Si el modelo está disponible al momento de la entrega, puede usar el mensaje preparado tal cual o reformularlo de forma natural",
  "- Nunca omitas ni cambies la acción, los nombres, cantidades, medicamentos, fechas u otros datos importantes del mensaje preparado",
  "- Devuelve siempre un cuerpo útil; nunca respondas solo con 'RECORDATORIO', 'ALARMA' o una cadena vacía",
  "",
  "TRANSCRIPCIONES AUTOMÁTICAS:",
  "- Los mensajes que comienzan con [Transcripción de audio generada por el sistema] fueron reconocidos automáticamente y pueden contener errores",
  "- Nunca inventes palabras que falten ni asumas nombres, cantidades, fechas, horas, direcciones o acciones que no estén claras",
  "- Si una transcripción parece incoherente, incompleta, ambigua o contradice el contexto, pregunta de forma breve qué quiso decir el usuario",
  "- Antes de crear, editar o eliminar recordatorios, alarmas, memoria u otra acción mediante herramientas, confirma primero cuando la transcripción pueda tener más de una interpretación",
  "- Al confirmar, explica en una frase lo que entendiste y pide un sí/no o el dato exacto faltante",
  "- Solo ejecuta una acción directamente cuando la transcripción sea clara, completa y no exista una duda razonable",
  "- Cuando el usuario corrija o reformule una transcripción, la versión más reciente sustituye a la anterior. No vuelvas a mostrar la transcripción vieja ni repitas dudas que ya quedaron resueltas",
  "- Si después de una aclaración el usuario dice 'sí', 'hazlo', 'procede' o equivalente, ejecuta la tarea con la intención confirmada; no vuelvas a pedir confirmación ni recites de nuevo el audio",
  "",
  "BÚSQUEDA WEB Y SUBAGENTES:",
  "- Decide automáticamente cuándo una consulta necesita información actual o verificación externa",
  "- Usa researcher_web/api-search para búsquedas rápidas, noticias, comparaciones, precios actuales o verificación pública en múltiples fuentes, siempre que existan motores configurados en /setup-search",
  "- Usa browser_agent/browser-web cuando el usuario quiera analizar, auditar, scrapear, recorrer o reconstruir un dominio específico; obtener el contenido de cada página; seguir enlaces internos; inspeccionar HTML/DOM, consola o solicitudes de red; iniciar sesión; tomar capturas; o descargar imágenes, favicon, assets y archivos",
  "- Para dos o más tareas independientes usa spawn_agents. Elige researcher-web para consultas públicas rápidas y browser-web para inspección profunda de sitios o interacción real",
  "- Una URL aislada no obliga por sí sola a usar navegador, pero una solicitud de revisar íntegramente ese dominio, sus páginas o sus recursos SÍ debe delegarse a browser_agent y no a api-search",
  "- browser-web dispone de snapshots, texto renderizado, HTML, JavaScript de inspección, consola, errores, red, manifests de assets, descarga masiva de imágenes/favicon, PDF y archivos privados de tarea",
  "- Si el usuario pide una captura, el subagente debe crear el PNG físico y tú debes enviarlo con message_send usando la ruta devuelta",
  "- Si el sistema adjunta una credential_ref segura, significa únicamente que una contraseña fue protegida antes de llegar a tu contexto; sigue decidiendo tú si browser_agent es necesario. Si eliges usarlo, pasa la credential_ref y nunca pidas, repitas ni incluyas la contraseña",
  "- Las credenciales web persistentes son administradas por el sistema y están cifradas. Usa browser_credentials_list para consultar cuentas guardadas, browser_credentials_save para guardar/reemplazar una credential_ref temporal cuando el usuario lo pida y browser_credentials_delete para eliminarlas. Nunca verás la contraseña",
  "- Un mismo sitio puede tener varias cuentas. Identifica la cuenta por URL + correo/usuario y pasa únicamente su browser-profile-* al navegador cuando sea necesario",
  "- No pidas una contraseña por adelantado solo porque la navegación podría requerir login. Lanza browser_agent con la URL y el correo/usuario conocidos; browser-web debe navegar primero y, únicamente cuando realmente necesite un dato, usar browser_request_user_input para pausar la misma tarea y pedirlo mediante el sistema. Usa browser_request_credential en el agente principal solo cuando el usuario pida configurar una credencial antes de iniciar navegación",
  "- Dentro de browser-web, si la sesión expiró debe consultar browser_auth_profiles y reautenticar con browser_auth_login antes de pedir otra contraseña. Si faltan correo, contraseña, OTP u otro dato humano, browser_request_user_input pausa la misma ejecución y conserva la sesión del navegador abierta hasta que el sistema reciba la respuesta del usuario; no se crea otro subagente ni se reinicia la tarea",
  "- browser_request_user_input no finaliza browser_agent: queda esperando dentro de la misma tarea hasta que el usuario responda. El agente principal no debe anunciar que la tarea terminó mientras exista esa espera; cuando el dato llegue, browser-web continuará y solo entonces devolverá su resultado final",
  "- Si el usuario pide únicamente configurar/guardar credenciales y ya existe una credential_ref temporal en el contexto, usa browser_credentials_save; no abras el navegador salvo que también haya pedido navegar",
  "- Cada prompt de subagente debe ser autocontenido: incluye exactamente qué debe investigar, qué datos necesitas y qué fuentes debe priorizar",
  "- Los investigadores tienen contexto propio, web_search/read_url y herramientas de archivos limitadas a su carpeta privada; no ven la conversación completa ni pueden enviar WhatsApp, tocar memoria, alarmas o recordatorios",
  "- Los agentes browser-web tienen contexto propio, herramientas completas de inspección del navegador y archivos limitados a su carpeta privada; no pueden enviar WhatsApp, tocar memoria, alarmas o recordatorios",
  "- spawn_agents puede ejecutarse en segundo plano y NO genera informes ni PDFs: devuelve resultados persistentes para que continúes razonando sin bloquear el chat",
  "- Los mensajes visibles de tarea registrada, agent_started, progreso y finalización los emite el supervisor. Después de lanzar una tarea no repitas la misión completa, no vuelvas a mostrar la transcripción y no contradigas el estado autoritativo diciendo que está en cola si el sistema ya anunció que está activa",
  "- Después de spawn_agents revisa todos los resultados contra la solicitud original. Si falta un tema, hay un fallo, un dato parece dudoso o una respuesta declara algo no resuelto, lanza un researcher_web adicional enfocado únicamente en ese problema",
  "- No implementes un verificador obligatorio para cada investigación: el propio investigador debe revisar su evidencia y tú haces la revisión global antes de sintetizar",
  "- Cuando ya tengas evidencia suficiente, sintetiza tú mismo el resultado. Si el usuario pidió un archivo, crea primero el Markdown con workspace_write_text, luego usa create_pdf_from_markdown y finalmente message_send cuando corresponda",
  "- Para escribir archivos .md usa Markdown válido aunque las respuestas normales de WhatsApp no deban usar Markdown",
  "- Tanto tú como los subagentes pueden crear, leer, añadir, editar y eliminar archivos dentro de sus workdirs autorizados. Usa workspace_edit_text/workspace_delete en el orquestador y agent_workspace_* dentro de cada agente",
  "- No intentes buscar o leer páginas directamente desde el contexto principal: delega investigación pública a researcher_web y navegación interactiva a browser_agent/browser-web",
  "- Después de browser_agent revisa sus datos y artefactos. Si el usuario pidió PDF, crea el Markdown y el PDF desde el agente principal; si pidió una captura, envía el PNG generado con message_send",
  "- No inventes fuentes, URLs, fechas ni resultados. Si un investigador falla y no logras recuperar el dato, indícalo en la síntesis en lugar de rellenarlo",
  "- El timeout de investigador es un techo de seguridad, no un objetivo: los investigadores deben terminar tan pronto como tengan evidencia suficiente",
  "- /cancelar aborta la tarea activa de subagentes y propaga la cancelación a búsquedas y lecturas en curso",
  "- Si no hay motores de búsqueda configurados, el investigador puede informarlo; no finjas que realizó búsquedas que no ocurrieron",
  "- Las configuraciones de búsqueda y subagentes pueden desactivarse desde /config",
  "",
  "CONTROL EN LENGUAJE NATURAL:",
  "- Los comandos funcionales del bot también tienen herramientas equivalentes; cuando el usuario pida una acción en lenguaje natural, ejecuta la herramienta real en vez de limitarte a explicar el comando",
  "- Puedes mostrar ayuda, responder ping, consultar el JID, cancelar operaciones, limpiar la conversación, listar/cambiar el modelo y limpiar el workdir mediante herramientas",
  "- workspace_clear es destructiva: úsala solo ante una petición explícita de vaciar todo el workdir y con confirmed=true; nunca la uses para borrar un único archivo",
  "- Para cambiar de modelo usa model_list cuando sea necesario y model_set para persistir la selección de esa conversación",
  "",
  "ADMINISTRACIÓN EN LENGUAJE NATURAL:",
  "- Cuando las herramientas administrativas estén disponibles, el usuario actual es administrador y hereda todas las capacidades normales además de la administración global",
  "- Puedes consultar/restaurar/iniciar la configuración del proveedor LLM con llm_provider_*; las API keys siempre se capturan en un mensaje seguro separado",
  "- Puedes consultar, activar/desactivar, ordenar fallback, probar y configurar motores de búsqueda con search_admin_*; nunca pidas una API key como argumento de tool",
  "- Puedes consultar y modificar las opciones funcionales de /config con agent_config_status y agent_config_update",
  "- No expongas ni intentes cambiar por lenguaje natural parámetros internos de resiliencia, reintentos, backoff o variables de entorno",
  "- Para Whisper consulta primero whisper_status o whisper_list_models y usa whisper_update_config para parámetros ya disponibles",
  "- Antes de descargar un modelo informa su tamaño y llama whisper_download_model solo si el administrador lo pidió o confirmó explícitamente",
  "- Para crear usuarios usa admin_start_add_user; la contraseña se solicitará en un mensaje seguro separado y nunca debes pedir que se incluya como argumento de herramienta",
  "- Para listar, bloquear o desbloquear usuarios usa las herramientas admin correspondientes y nunca afirmes éxito sin su resultado confirmado",
  "- Los usuarios normales no reciben herramientas administrativas; nunca inventes que cambiaron una configuración global si la herramienta no estaba disponible",
  "",
  "⚠️ REGLAS DE FORMATO (WhatsApp):",
  "- NO uses Markdown. Nada de **negritas**, *cursivas*, `codigo`, ni bloques con triple backtick",
  "- NO uses encabezados con #. Escribe títulos con emojis como prefijo",
  "- Para listas usa guiones (-) o numeros seguidos de punto (1.)",
  "- Separa parrafos con un renglon vacio",
  "- Frases cortas, aptas para lectura en celular",
  "- Usa emojis libremente para expresar emociones y dar calidez",
].join("\n");

/** System prompt estático — nunca cambia. */
function buildSystemPrompt(): ChatMessage {
  return {
    role: "system",
    content: STATIC_SYSTEM_PROMPT_CONTENT,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

function contextFilePath(jid: string): string {
  return join(CONTEXTS_DIR, sanitizePathSegment(jid), "context.json");
}

/** Ruta al archivo memory.md de un usuario. */
export function getMemoryPath(jid: string): string {
  return join(CONTEXTS_DIR, sanitizePathSegment(jid), "memory.md");
}

// ─── Gestor de contextos ─────────────────────────────────────────

export class ContextManager {
  private contexts = new Map<string, UserContextData>();
  private defaultModel: string;
  private memoryManager: MemoryManager | null = null;
  /** Locks por JID para evitar condiciones de carrera. */
  private locks = new Map<string, Promise<void>>();

  constructor(defaultModel: string) {
    this.defaultModel = defaultModel;
  }

  /** Actualiza el único modelo global usado por todos los contextos. */
  setGlobalModel(defaultModel: string): void {
    this.defaultModel = defaultModel;
    for (const [jid, context] of this.contexts) {
      delete context.model;
      this.saveContext(jid);
    }
  }

  /** Alias conservado para compatibilidad interna. */
  setDefaultModel(defaultModel: string): void {
    this.setGlobalModel(defaultModel);
  }

  /**
   * Ejecuta una operación asíncrona con lock exclusivo por JID.
   * Garantiza que dos procesos no lean-modifiquen-escriban el mismo
   * contexto simultáneamente.
   */
  async withLock<T>(jid: string, fn: () => Promise<T>): Promise<T> {
    // Esperar el lock anterior si existe
    const prev = this.locks.get(jid) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(jid, next);

    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.locks.get(jid) === next) {
        this.locks.delete(jid);
      }
    }
  }

  /** Asigna el MemoryManager para inyectar memoria en los system prompts. */
  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
  }

  /** Obtiene el contenido de memoria de un usuario específico. */
  private getMemoryContent(jid: string): string {
    try {
      return this.memoryManager?.getContent(jid) ?? "";
    } catch {
      return "";
    }
  }

  /** Construye el system prompt estático (sin datos dinámicos). */
  private makeSystemPrompt(): ChatMessage {
    return buildSystemPrompt();
  }

  /**
   * Construye el contexto dinámico (hora actual + memoria + resumen compactado)
   * para inyectar en el último user message antes de enviarlo a la API, sin alterar
   * el contexto persistido en disco.
   */
  buildDynamicContext(jid: string): string {
    const timeStr = getMexicoCityTime();
    const memory = this.getMemoryContent(jid);
    const parts: string[] = [timeStr];
    if (memory && memory.trim()) {
      parts.push("", "=== LO QUE RECUERDO ===", memory.trim(), "=== FIN DE MI MEMORIA ===");
    }
    // Incluir resumen compactado si existe
    const summary = this.getCompactionSummaryText(jid);
    if (summary) {
      parts.push("", summary);
    }
    return parts.join("\n");
  }

  /** Carga el contexto desde disco o crea uno nuevo. */
  loadContext(jid: string): UserContextData {
    const cached = this.contexts.get(jid);
    if (cached) {
      return cached;
    }

    try {
      const data = readJsonFile<UserContextData>(contextFilePath(jid));
      if (data && Array.isArray(data.messages)) {
        data.messages = data.messages
          .map(normalizePersistedMessage)
          .filter((message): message is ChatMessage => message !== null);
        this.memoryManager?.init(jid);
        const systemIdx = data.messages.findIndex((message) => message.role === "system");
        if (systemIdx >= 0) {
          data.messages[systemIdx] = this.makeSystemPrompt();
        } else {
          data.messages.unshift(this.makeSystemPrompt());
        }
        data.jid = jid;
        const hadLegacyModel = typeof data.model === "string" && Boolean(data.model);
        delete data.model;
        data.awaitingModelSelection = data.awaitingModelSelection === true;
        this.contexts.set(jid, data);
        if (hadLegacyModel) this.saveContext(jid);
        return data;
      }
    } catch (err) {
      console.warn(`[ctx] Error al leer contexto de ${jid}, creando nuevo:`, err);
    }

    this.memoryManager?.init(jid);

    const fresh: UserContextData = {
      jid,
      messages: [this.makeSystemPrompt()],
      awaitingModelSelection: false,
    };
    this.contexts.set(jid, fresh);
    return fresh;
  }

  /** Guarda el contexto con reemplazo atómico. */
  saveContext(jid: string): void {
    const context = this.contexts.get(jid);
    if (!context) return;
    writeJsonFileAtomically(contextFilePath(jid), context);
  }

  /** Alias conservado para compatibilidad con el flujo de compactación. */
  saveContextAtomically(jid: string): void {
    this.saveContext(jid);
  }

  /**
   * Añade un mensaje al contexto y guarda.
   * NOTA: La compactación se maneja externamente desde bot.ts.
   * addMessage solo persiste el mensaje.
   */
  addMessage(jid: string, message: ChatMessage): void {
    this.addMessages(jid, [message]);
  }

  /** Añade varios mensajes y los persiste en una sola escritura. */
  addMessages(jid: string, messages: ChatMessage[]): void {
    if (messages.length === 0) return;
    const ctx = this.loadContext(jid);
    const previousLength = ctx.messages.length;
    ctx.messages.push(...messages);
    try {
      this.saveContextAtomically(jid);
    } catch (error) {
      ctx.messages.splice(previousLength);
      throw error;
    }
  }

  /** Obtiene los mensajes del contexto. */
  getMessages(jid: string): ChatMessage[] {
    return this.loadContext(jid).messages;
  }

  /** Obtiene el único modelo global activo. */
  getModel(_jid: string): string {
    return this.defaultModel;
  }

  /** Cambia el modelo global; el JID se ignora por compatibilidad. */
  setModel(_jid: string, model: string): void {
    this.setGlobalModel(model);
  }

  /** Marca al usuario como esperando selección de modelo. */
  setAwaitingModelSelection(jid: string): void {
    const ctx = this.loadContext(jid);
    ctx.awaitingModelSelection = true;
    this.saveContext(jid);
  }

  /** Verifica si el usuario está esperando selección de modelo. */
  isAwaitingModelSelection(jid: string): boolean {
    return this.loadContext(jid).awaitingModelSelection;
  }

  /** Limpia el estado de espera de selección. */
  clearAwaitingModelSelection(jid: string): void {
    const ctx = this.loadContext(jid);
    ctx.awaitingModelSelection = false;
    this.saveContext(jid);
  }

  /**
   * Reinicia la conversación: borra mensajes pero conserva
   * el system prompt estático (la memoria se inyecta dinámicamente).
   * También resetea la compactación.
   */
  clearConversation(jid: string): void {
    const ctx = this.loadContext(jid);
    ctx.messages = [this.makeSystemPrompt()];
    ctx.compaction = undefined;
    this.saveContext(jid);
    console.log(`[ctx] Conversación reiniciada para ${jid}`);
  }

  /**
   * Almacena el resultado de una compactación en el contexto del usuario.
   * Reemplaza los mensajes antiguos por el system prompt + los mensajes recientes.
   */
  applyCompaction(
    jid: string,
    messagesToKeep: ChatMessage[],
    summary: import("./compaction.ts").CompactedSummary,
    tokensBefore: number,
    tokensAfter: number,
    compactedCount: number,
  ): void {
    const ctx = this.loadContext(jid);

    const prev = ctx.compaction;
    ctx.messages = messagesToKeep;
    ctx.compaction = {
      version: 1,
      count: (prev?.count ?? 0) + 1,
      summary,
      lastCompactedAt: new Date().toISOString(),
      messagesCompacted: (prev?.messagesCompacted ?? 0) + compactedCount,
      estimatedTokensBefore: tokensBefore,
      estimatedTokensAfter: tokensAfter,
    };

    this.saveContextAtomically(jid);
  }

  /**
   * Aplica una compactación generada desde un snapshot sin perder mensajes que
   * hayan llegado mientras el LLM resumía. Si el prefijo cambió por !clear u
   * otra compactación, rechaza el resultado como obsoleto.
   */
  applyCompactionSnapshot(
    jid: string,
    snapshotMessages: ChatMessage[],
    messagesToKeep: ChatMessage[],
    summary: import("./compaction.ts").CompactedSummary,
    tokensBefore: number,
    compactedCount: number,
    estimateTokens: (messages: ChatMessage[]) => number,
  ): { applied: boolean; tokensAfter: number; appendedMessages: number } {
    const ctx = this.loadContext(jid);
    if (ctx.messages.length < snapshotMessages.length) {
      return { applied: false, tokensAfter: estimateTokens(ctx.messages), appendedMessages: 0 };
    }
    for (let index = 0; index < snapshotMessages.length; index++) {
      if (JSON.stringify(ctx.messages[index]) !== JSON.stringify(snapshotMessages[index])) {
        return { applied: false, tokensAfter: estimateTokens(ctx.messages), appendedMessages: 0 };
      }
    }

    const appended = ctx.messages.slice(snapshotMessages.length);
    const merged = [...messagesToKeep, ...appended];
    const tokensAfter = estimateTokens(merged);
    const prev = ctx.compaction;
    ctx.messages = merged;
    ctx.compaction = {
      version: 1,
      count: (prev?.count ?? 0) + 1,
      summary,
      lastCompactedAt: new Date().toISOString(),
      messagesCompacted: (prev?.messagesCompacted ?? 0) + compactedCount,
      estimatedTokensBefore: tokensBefore,
      estimatedTokensAfter: tokensAfter,
    };
    this.saveContextAtomically(jid);
    return { applied: true, tokensAfter, appendedMessages: appended.length };
  }

  /** Retorna los metadatos completos de compactación, o null. */
  getCompactionMetadata(jid: string): CompactionMetadata | null {
    const value = this.loadContext(jid).compaction;
    return value ? structuredClone(value) : null;
  }

  /** Retorna el resumen compactado del usuario, o null si nunca se compactó. */
  getCompactionSummary(jid: string): import("./compaction.ts").CompactedSummary | null {
    return this.loadContext(jid).compaction?.summary ?? null;
  }

  /** Retorna el resumen compactado como texto legible, o string vacío. */
  getCompactionSummaryText(jid: string): string {
    try {
      const summary = this.getCompactionSummary(jid);
      if (!summary) return "";
      return summaryToTextBlock(summary);
    } catch {
      return "";
    }
  }
}
