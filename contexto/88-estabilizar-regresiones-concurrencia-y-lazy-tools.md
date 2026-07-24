# 88 — Estabilizar regresiones de concurrencia y lazy tools

# Fecha

2026-07-24

# Motivo

La suite posterior a la continuación de tareas background reportó seis fallos. Dos señalaban comportamiento que debía estabilizarse y cuatro correspondían a pruebas que seguían buscando detalles anteriores de implementación.

# Cambios

- `CompletionQueue` inicia inmediatamente el primer trabajo de cada conversación y mantiene FIFO estricto para los siguientes, incluso si uno falla.
- La prueba de lazy tools de `AgentRuntime` ya no ejecuta asserts dentro del mock de `fetch`; un assert lanzado desde allí era interpretado por la política de reintentos del LLM como un fallo transitorio y terminaba oculto tras backoff hasta el timeout del test.
- La prueba de revisión background distingue el lock breve que captura contexto post-delegación antes del LLM del lock posterior que persiste la continuación después de obtener la síntesis.
- Las pruebas de `/compact` usan la firma vigente que incluye el mensaje actual para calcular el toolset lazy y su presupuesto real.
- La prueba modular valida el enrutamiento por turno (`filterToolsForTurn`) en vez del catálogo global de permisos; Dogpile continúa verificándose en las pruebas de `spawn_agents`, donde realmente se aplica el fallback.
- La validación de `contexto/` tolera documentos históricos superpuestos con un prefijo numérico repetido. `000-contexto-maestro.md` sigue siendo la fuente canónica y debe apuntar al registro existente con el número más reciente.

# Compatibilidad

No cambia el formato de datos persistentes, las credenciales, las tareas ni la API de tools. Los cambios funcionales se limitan a hacer determinista el inicio de la primera integración FIFO; el resto son correcciones de pruebas para representar la arquitectura vigente.
