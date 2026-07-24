# 87 — Continuación de intención, concurrencia y política TTS autoritativa

# Fecha

2026-07-24

# Problema corregido

Las tareas background podían completar correctamente una investigación pero la revisión automática contestaba como si el resultado del subagente fuera toda la solicitud. Esto perdía obligaciones del mensaje original como comparar, decidir, recomendar, cruzar datos o continuar una segunda parte.

También existían dos carreras relacionadas:

- `spawn_agents`, `researcher_web` y `browser_agent` eran terminales para el loop principal, por lo que registrar trabajo background impedía continuar en el mismo turno las partes independientes de la solicitud;
- dos tareas background que terminaban casi al mismo tiempo podían iniciar revisiones solapadas y competir por el contexto.

TTS tenía una inconsistencia adicional: `tts_speak` podía enviar audio desde la propia tool antes de que la política final de salida comprobara una petición explícita de texto.

# Continuación autoritativa de la solicitud original

Cada `AgentTaskRecord` puede persistir:

- `originPrompt`: mensaje que originó la tarea;
- `originContext`: snapshot de conversación hasta ese mensaje.

El snapshot original conserva información previa necesaria para operaciones posteriores. Ejemplo: si primero se obtuvo el clima de Jalpa y luego se delega investigar Villahermosa para comparar ambos, la continuación recibe tanto el resultado nuevo como los datos previos de Jalpa.

La revisión background ya no usa un prompt genérico de “resume el agente”. Se trata como continuación de la solicitud original. Si la petición exigía comparación, decisión, recomendación, síntesis o conclusión, esa obligación sigue pendiente hasta producirse explícitamente.

# Contexto post-delegación

Antes de sintetizar una tarea terminada, el revisor espera brevemente el lock del turno foreground ya en curso, toma un snapshot y vuelve a liberarlo antes de llamar al LLM.

`buildTaskPostDelegationContext` recoge solamente mensajes posteriores a la petición original cuando esa petición sigue presente en la conversación activa. Esto permite conocer:

- trabajo independiente que el turno principal ya terminó mientras el agente estaba activo;
- continuaciones background anteriores ya integradas por la cola;
- respuestas confirmadas que no deben repetirse.

El contexto posterior complementa, no reemplaza, el snapshot original. Mensajes posteriores no relacionados no cambian retroactivamente la misión original.

# Subagentes no terminales

`spawn_agents`, `researcher_web` y `browser_agent` dejan de ser tools terminales del chat principal.

Después de registrar una tarea background, el modelo puede continuar en rondas posteriores del mismo turno con trabajo que no dependa del resultado del agente. No debe inventar la parte dependiente ni relanzar la misma misión.

La deduplicación de subagentes se conserva durante todo el turno; ya no se reinicia entre rondas de function calling.

`goal_start`, `goal_instruction` y `tts_speak` mantienen su semántica terminal donde corresponde.

# Orden FIFO de resultados background

`CompletionQueue` serializa revisiones por JID en el orden en que sus finalizaciones se notifican.

Una conversación sigue la secuencia:

1. termina una tarea;
2. espera a cualquier foreground que ya posea el lock;
3. captura el contexto confirmado posterior a la delegación;
4. sintetiza la continuación fuera del lock;
5. persiste y entrega el resultado;
6. procesa la siguiente finalización pendiente.

Conversaciones de JID distintos siguen siendo independientes y pueden procesarse en paralelo.

# Política TTS autoritativa

Se distinguen dos clases de intención:

- preferencia de turno: `Ahora dame el resultado por voz` afecta solo esa respuesta;
- preferencia persistente: `No quiero audios`, `Hablemos solo en texto`, `A partir de ahora respóndeme por voz` cambia el modo almacenado.

Una orden de seleccionar una voz, por ejemplo Cortana, no cambia por sí sola el modo de respuesta.

El runtime aplica cambios persistentes directamente desde el mensaje antes del LLM. `tts_speak` queda bloqueada si la política autoritativa exige texto, por lo que la tool no puede saltarse la preferencia enviando el audio antes del cierre del turno.

`tts_set_mode` y `tts_set_enabled` solo pueden cambiar el modo persistente cuando el mensaje del usuario contiene una petición persistente compatible. Una preferencia puntual no autoriza convertirla silenciosamente en configuración permanente.

Para resultados diferidos, el modo actual tiene prioridad protectora: si una tarea antigua se originó cuando se aceptaba voz pero el usuario cambió después a solo texto, su continuación no enviará un audio tardío.

# Pruebas relevantes

Se añade o actualiza cobertura para:

- contexto original de comparaciones;
- contexto post-delegación con trabajo foreground y continuaciones FIFO;
- `CompletionQueue` por conversación y paralelismo entre JIDs;
- persistencia de `originPrompt`/`originContext` en tareas;
- subagentes background no terminales;
- deduplicación durante todo el turno;
- segunda ronda del LLM después de registrar un agente;
- detección de `No quiero audios`, `soloen texto`, `dame ... por voz` y cambio persistente;
- guards runtime para `tts_speak` y cambios persistentes de modo;
- resultados background que respetan el modo TTS actual.

# Validación requerida

En un entorno con Bun y dependencias instaladas:

```bash
bun install
bun run typecheck
bun run test
bun run build
```
