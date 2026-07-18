# 63 — Timeouts independientes y recuperación de subagentes

# Fecha

2026-07-17

# Problema observado

Después del refactor al runtime agéntico, una investigación paralela de precios terminaba con los cuatro proveedores fallidos aproximadamente 120 segundos después del inicio. El investigador de DeepSeek había entregado su resultado y el verificador ya estaba trabajando, pero fue abortado al cumplirse el mismo límite global. MiniMax, OpenAI y Anthropic también fueron cancelados por ese reloj compartido aunque sus agentes seguían activos.

El progreso de WhatsApp además decía que el orquestador revisaba resultados "aprobados por verificadores" aunque todos los workers hubieran fallado.

# Causa

`runVerifiedResearchWorkflow` envolvía todo el ciclo investigador → verificador → reintentos en un único `AbortSignal.timeout(researcherTimeoutMs)`. Todos los pasos de un proveedor compartían el mismo presupuesto. Un verificador iniciado tarde solo recibía el tiempo sobrante del investigador.

Las tools `web_search` y `read_url` también utilizaban la señal del workflow en lugar de la señal concreta del subagente que las estaba ejecutando.

# Solución

- Se eliminó el timeout único aplicado a todo el workflow.
- `spawnAgents` acepta ahora `timeoutMs` por subagente y crea una señal exclusiva combinada únicamente con la señal de cancelación de la tarea padre.
- Cada investigador recibe su propio timeout completo.
- Cada verificador recibe un timeout nuevo e independiente.
- `web_search` y `read_url` utilizan la señal del contexto del subagente, por lo que un timeout individual cancela también sus tools activas sin afectar a los demás workers.
- Un timeout de investigador se convierte en un intento fallido recuperable y puede activar el siguiente intento.
- Un timeout de verificador ya no provoca el crash inmediato del proveedor: se permiten hasta dos intentos de verificación independientes antes de rechazar el intento de investigación.
- La cancelación explícita del usuario sigue propagándose a toda la tarea.
- El timeout predeterminado pasó a 240 segundos y las configuraciones antiguas inferiores a 180 segundos se normalizan automáticamente a 180 segundos.
- `/config` ofrece 180, 240, 300 y 600 segundos.
- El mensaje de progreso del orquestador ya no afirma que los resultados están aprobados antes de calcular las decisiones reales.

# Validación

Se agregó cobertura para comprobar que investigador y verificador pueden consumir, cada uno, su propio presupuesto aunque la duración total supere el timeout individual. También se prueba que un timeout del verificador se convierte en un rechazo recuperable en lugar de lanzar una excepción que derribe el workflow.

Typecheck completo correcto. Suite completa: 373 pruebas aprobadas, 0 fallos, 1005 verificaciones. Las pruebas de alarmas y recordatorios permanecen verdes.

# Archivos principales

- `src/orchestration/agent-spawner.ts`
- `src/agents/research-workflow.ts`
- `src/agent-config.ts`
- `src/bot.ts`
- `README.md`
- `__tests__/verified-research-workflow.test.ts`
- `__tests__/agent-config.test.ts`
