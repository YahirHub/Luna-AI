# 78 — api-search en segundo plano y cancelación prioritaria

# Problema

researcher_web forzaba background=false. La investigación quedaba dentro del lock del chat y mensajes como !cancelar no se procesaban hasta terminar la búsqueda.

# Solución

- researcher_web y spawn_agents usan background=true por defecto.
- Las tools expuestas al modelo ya no ofrecen el parámetro background; las investigaciones conversacionales quedan siempre en segundo plano. Solo llamadas internas explícitas pueden pasar background=false.
- !cancelar y equivalentes naturales se atienden antes de flujos pendientes, LLM y lock de conversación.
- El AbortSignal del supervisor llega a cola, reintentos, proveedor de búsqueda y read_url.
- api-search mantiene taskId/agentId/nombre/backend en logs.

# Regresión

Una prueba inicia un api-search lento, confirma que la llamada devuelve queued inmediatamente, cancela la tarea y comprueba estado cancelled sin esperar a la operación simulada.

# Compatibilidad acumulativa

- Se conserva el adaptador Baileys durante reconexiones para no perder su cola de salida.
- El SDK de Baileys permanece aislado bajo `src/transports/baileys/`; multimedia se representa mediante `TransportIncomingMessage`.
- Los releases verifican Whisper, FFmpeg y agent-browser antes de empaquetar.
