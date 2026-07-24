# 84 — Browser-agent con entrada humana autónoma y recuperación de credenciales

# Fecha

2026-07-23

# Problema

`browser-web` ya disponía de `browser_request_user_input`, pero su uso dependía de que el modelo siguiera correctamente el prompt. Si durante una misión encontraba un login, OTP, API key/token, CAPTCHA textual, respuesta de seguridad u otro dato humano no anticipado por el orquestador, podía responder que necesitaba credenciales y terminar. Al finalizar `runAgent`, la sesión de `agent-browser` se cerraba y la misión quedaba incompleta.

También existían dos fricciones adicionales:

- `browser_request_user_input(kind=password)` devolvía error si el modelo omitía `url` o `username`, aunque esos datos pudieran inferirse desde la misión, la página actual o perfiles guardados.
- `browser_auth_login` con varias cuentas guardadas podía dejar al modelo decidir qué perfil usar sin una orden autoritativa de consultar al usuario.

# Solución

## Guard autoritativo del runtime

Se agregó un guard de entrada humana en `AgentRuntime` exclusivo de `browser-web`.

Después de una respuesta final del subagente:

1. Se analiza si está intentando cerrar la misión por falta de credenciales, usuario/correo, contraseña, OTP/2FA, API key/token, CAPTCHA textual, respuesta de seguridad u otro dato humano.
2. Si la misión prohíbe autenticarse o limita el trabajo a contenido público, el guard no pide credenciales.
3. Si existe un bloqueo real, el runtime construye una solicitud segura usando el estado de la misma `BrowserAgentExecution`.
4. Ejecuta `browser_request_user_input` como una tool real, por lo que se mantienen logs, eventos, estado `waiting_user`, captura y asociación con task/agent/requestId.
5. La sesión de `agent-browser` permanece viva mientras espera.
6. Cuando llega la respuesta, el runtime vuelve a consultar al mismo subagente con la misión original, el bloqueo anterior y el resultado seguro de la tool.
7. Si vuelve a faltar otro dato, el ciclo puede repetirse. El guard tiene un techo de seguridad para evitar loops de un modelo defectuoso y nunca marca como completada una tarea que siga cerrando con un dato humano pendiente.
8. Mientras el agente está en `waiting_user`, el presupuesto de timeout de trabajo queda pausado. Al responder continúa consumiendo el tiempo restante; cancelar la tarea sigue abortando inmediatamente.

Esto hace que la capacidad ya no dependa de que el orquestador incluya de antemano instrucciones como "si pide login solicita las credenciales".

## Inferencia segura para solicitudes de contraseña

`browser_request_user_input` ahora intenta completar automáticamente los metadatos que necesita una contraseña:

- URL indicada por el subagente.
- URL presente en la misión original.
- URL actual de la sesión del navegador.
- Usuario/correo presente en la misión.
- Usuario/correo indicado explícitamente en la misión o confirmado por el usuario durante la ejecución.

Si todavía falta identidad, la tool cambia la solicitud a `username` en vez de fallar. Si falta el sitio, solicita primero la URL como texto. La contraseña continúa capturándose fuera del LLM.

## Varias cuentas y referencias inválidas

`browser_auth_login` ahora devuelve bloqueos recuperables estructurados:

- `ambiguous_account`: hay varias cuentas; el agente no debe adivinar y debe solicitar usuario/correo.
- `missing_credentials`: no existe perfil para esa cuenta; debe solicitar el dato faltante y continuar.
- `credential_reference_unavailable`: la referencia expiró, se eliminó o pertenece a otro usuario; debe consultar perfiles o solicitar de nuevo el dato.

# Seguridad

- Contraseñas, OTP, API keys, tokens y respuestas de seguridad siguen fuera del LLM.
- `browser_request_user_input` normaliza defensivamente el tipo solicitado: aunque el modelo marque como `text` un campo que por su metadata es contraseña, OTP o secreto, el runtime lo eleva a un tipo seguro y solo devuelve una referencia opaca.
- El guard solo clasifica el mensaje final del subagente; no intenta extraer secretos.
- Las contraseñas siguen asociadas a URL + usuario antes de almacenarse.
- No se piden credenciales cuando la misión indica explícitamente trabajar sin login o solo con contenido público.
- Las cuentas guardadas nunca determinan por sí solas la identidad de una nueva orden explícita de login. Desde `contexto/85`, incluso un único perfil requiere que el usuario haya indicado o confirmado qué cuenta usar.
- Compras, pagos, publicaciones, borrados, cambios de contraseña y cambios de seguridad siguen requiriendo confirmación explícita y reciente.

# Archivos principales

- `src/browser/browser-human-input.ts`
- `src/browser/browser-runtime.ts`
- `src/browser/browser-tools.ts`
- `src/browser/browser-credentials.ts`
- `src/bot.ts`
- `src/agents/spawn-agents-tool.ts`
- `src/agents/agent-runtime.ts`
- `src/agents/definitions/browser-web.ts`
- `__tests__/browser-human-input-guard.test.ts`
- `__tests__/agentic-integration-source.test.ts`

# Validación prevista

En una instalación con dependencias:

```bash
bun install
bun run typecheck
bun run test
bun run build
```

Pruebas manuales recomendadas:

1. Pedir al navegador entrar a una web sin proporcionar credenciales; debe solicitar usuario/correo o contraseña sin terminar la tarea.
2. Responder al mensaje del sistema; debe continuar la misma task/agent y la misma página.
3. Provocar OTP/2FA; debe solicitar el código y continuar.
4. Provocar una API key/token o respuesta de seguridad; debe capturarse como `secret_ref`, nunca como texto visible para el modelo.
5. Tener varias cuentas guardadas para el mismo dominio; no debe escoger una al azar.
6. Pedir explícitamente revisar solo contenido público sin iniciar sesión; no debe solicitar credenciales.

# Mejoras candidatas posteriores (no implementadas aquí)

1. **Ampliar las acciones nativas expuestas por Luna.** El wrapper actual no publica todavía `select`, `check/uncheck`, `hover/focus`, `scroll`, `drag`, `upload`, tabs/ventanas ni captura HAR aunque `agent-browser` moderno dispone de ellas. Deben añadirse con validación de rutas para uploads y aislamiento por workdir.
2. **Actualizar `agent-browser` de forma controlada.** El proyecto permanece fijado en `0.27.0`; una actualización debe hacerse en un cambio independiente con pruebas Linux amd64/arm64, Windows x64, persistencia de perfiles, empaquetado y compatibilidad del CLI.
3. **Checkpoint durable de esperas humanas.** La espera viva actual conserva perfectamente la misma sesión mientras el proceso Luna sigue activo, pero una caída/reinicio durante `waiting_user` no puede reconstruir una Promise en memoria. Conviene persistir un checkpoint no secreto de misión, URL, agent/task/requestId y campo esperado para reanudar de forma segura tras reinicio.
4. **Takeover humano visual opcional.** Para CAPTCHA visual, WebAuthn o flujos que exigen interacción humana directa, conviene estudiar una vista temporal de la sesión en vez de intentar convertir todo a texto. Debe ser explícita, autenticada, limitada a la tarea y cerrarse al terminar.
5. **Política de navegación por alcance.** Además de tratar el contenido web como no confiable y usar content boundaries, se puede derivar una allowlist temporal desde dominios autorizados por la misión para impedir que una página maliciosa redirija al agente a destinos fuera de alcance, con excepción explícita para flujos OAuth/SSO legítimos.
