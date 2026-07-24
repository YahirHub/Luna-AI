# 76 — Autonomía, revisión y concurrencia de agentes

El inicio solo se anuncia tras agent_started. El orquestador revisa automáticamente resultados, eventos, carpetas y artefactos; entrega capturas/archivos y reintenta revisiones pendientes. Solicitudes de usuario/contraseña/OTP admiten capturas, reintentos y varias esperas simultáneas identificadas por agente.

## Actualización 2026-07-24 — continuación de intención y FIFO

Las tools background del agente principal (`spawn_agents`, `researcher_web`, `browser_agent`) ya no son terminales: registrar una tarea no impide continuar trabajo independiente del mismo mensaje. La deduplicación de una misión dura todo el turno.

Cada tarea conserva la solicitud original y un snapshot previo. Al finalizar, la revisión automática espera cualquier foreground que ya esté ejecutándose, captura contexto post-delegación confirmado y completa la obligación global pendiente en lugar de devolver solamente el reporte del subagente. Las revisiones se serializan mediante `CompletionQueue` FIFO por JID; otros JIDs permanecen concurrentes.

La política detallada y los tests están documentados en `contexto/87-continuacion-intencion-concurrencia-y-politica-tts.md`.
