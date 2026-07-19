# 65 — Agente de navegador con agent-browser

# Fecha

2026-07-18

# Base del cambio

El usuario confirmó que los cambios anteriores ya fueron comprometidos y pidió agregar navegación web interactiva basada en `vercel-labs/agent-browser`.

# Objetivo

Permitir que Luna delegue tareas como iniciar sesión en un sitio, navegar por paneles, extraer métricas, tomar capturas y descargar archivos a un subagente aislado, manteniendo el patrón del runtime genérico ya usado por `researcher-web`.

La navegación debe funcionar con modelos sin visión, conservar archivos físicos en el workdir y mantener las contraseñas fuera del contexto LLM.

# Implementación

## Nuevo subagente browser-web

Se agregó `src/agents/definitions/browser-web.ts` y se registró `browser-web` como tipo permitido en `spawn_agents`.

El agente:

- no hereda el historial principal;
- trabaja sin visión;
- usa snapshots de accesibilidad y texto renderizado;
- tiene herramientas restringidas de navegación;
- no puede acceder a memoria, alarmas, recordatorios, WhatsApp ni generación de PDF;
- puede crear capturas y descargas dentro de su carpeta física de tarea;
- devuelve una síntesis final al agente principal, que conserva el control para crear informes o enviar artefactos.

## Herramientas del navegador

Se agregaron herramientas aisladas para:

- abrir URLs;
- obtener snapshots de accesibilidad;
- leer texto renderizado;
- hacer clic;
- rellenar y escribir campos no secretos;
- presionar teclas;
- esperar por carga, texto, URL o selector;
- obtener texto y URL actual;
- tomar capturas;
- descargar archivos;
- iniciar sesión mediante una referencia segura;
- cerrar la sesión del navegador.

No se expone `eval` ni shell arbitraria al subagente.

## agent-browser

Se agregó la dependencia `agent-browser` 0.27.0.

El runtime resuelve el binario en este orden:

- `runtime/agent-browser/` junto al ejecutable compilado;
- `dist/runtime/agent-browser/`;
- binario nativo incluido por el paquete npm dentro de `node_modules/agent-browser/bin/`;
- instalación global disponible en PATH.

`scripts/package-runtime.ts` copia el binario nativo de la plataforma actual a `dist/runtime/agent-browser/` durante el build.

El runtime usa sesiones aisladas, restauración persistente por JID, content boundaries y un límite de salida. El estado persistente de cookies/localStorage se cifra mediante `AGENT_BROWSER_ENCRYPTION_KEY`, generada localmente en `persistent/browser/encryption.key`.

## Credenciales fuera del LLM

Se agregó `src/browser/browser-credentials.ts`.

Cuando una instrucción natural ya contiene URL, usuario y contraseña para iniciar sesión:

1. El preprocesamiento local actúa únicamente como una frontera de seguridad y extrae la contraseña antes de llamar al LLM.
2. La contraseña se almacena temporalmente en memoria con una referencia opaca `browser-cred-*`.
3. El mensaje enviado al modelo contiene únicamente la referencia segura.
4. Luna intenta borrar el mensaje original de WhatsApp.
5. La presencia de la URL o de la `credential_ref` NO ejecuta `browser_agent` ni decide ninguna herramienta.
6. El agente principal/orquestador analiza la intención completa y decide si necesita `browser_agent`, `researcher_web`, `spawn_agents` o ninguna herramienta.
7. Si decide usar el navegador, `browser_auth_login` resuelve la referencia fuera del LLM.
8. La contraseña se entrega a `agent-browser auth save` mediante stdin, no como argumento de proceso.
9. Después del intento de login se elimina el perfil temporal de credenciales.
10. La referencia en memoria se elimina al completar correctamente el login.

Si la instrucción solicita una operación que podría requerir login pero no incluye contraseña, el preprocesador local no abre un flujo automáticamente. El mensaje llega al agente principal y este decide primero si la tarea requiere realmente navegación. Solo si el orquestador decide usar el navegador y necesita la contraseña llama `browser_request_credential`. Esa herramienta envía:

`🔐 MENSAJE DEL SISTEMA`

El texto aclara que, por seguridad, el agente no debe conocer la contraseña. El siguiente mensaje se captura fuera del LLM, se intenta borrar y la tarea original se reanuda con una referencia segura.

## Archivos físicos por tarea

Un `browser-web` conserva:

- `request.json`;
- `events.jsonl`;
- `result.json`;
- `result.md`;
- `browser/snapshots/*.json`;
- `browser/extracted/*.txt`;
- `browser/screenshots/*.png`;
- `browser/downloads/*`.

Capturas y descargas se registran como artefactos del workdir. El agente principal puede usar las rutas devueltas para enviarlas por WhatsApp o incorporarlas a flujos posteriores.

## Orquestación

Se agregó la herramienta directa `browser_agent`.

`spawn_agents` admite ahora:

- `researcher-web` para investigación pública;
- `browser-web` para navegación interactiva.

Esto permite combinar en paralelo información privada de un panel con investigación pública y dejar que el agente principal sintetice el resultado final.

## Seguridad

- El contenido web se considera no confiable.
- Se activan content boundaries de agent-browser.
- No se entrega la contraseña al modelo.
- No se pasa la contraseña en argumentos del proceso.
- Las credenciales temporales expiran y están aisladas por JID.
- Las sesiones persistentes están separadas por usuario y cifradas en reposo.
- El prompt de browser-web prohíbe compras, pagos, borrados, publicaciones y cambios de seguridad sin confirmación explícita.
- No se añadieron capacidades de ejecución arbitraria de JavaScript o shell.

# Validación

- TypeScript validado con `tsc --noEmit`.
- Se agregaron pruebas para extracción/sanitización de credenciales, aislamiento por JID, exposición del browser agent y empaquetado del binario nativo.
- Las pruebas existentes de alarmas, recordatorios, búsqueda, agentes, PDF, WhatsApp y control natural permanecen como regresión obligatoria.

# Archivos principales

- `src/browser/browser-credentials.ts`
- `src/browser/browser-runtime.ts`
- `src/browser/browser-tools.ts`
- `src/agents/definitions/browser-web.ts`
- `src/agents/agent-registry.ts`
- `src/agents/agent-runtime.ts`
- `src/agents/spawn-agents-tool.ts`
- `src/bot.ts`
- `src/context.ts`
- `scripts/package-runtime.ts`
- `package.json`
- `bun.lock`
- `README.md`
- pruebas del runtime agéntico y credenciales de navegador

# Validación final

- `npx tsc --noEmit --pretty false`: correcto.
- Suite completa: 373 pruebas aprobadas, 0 fallos, 1054 verificaciones en 45 archivos.
- Se verificó el binario nativo Linux x64 incluido por `agent-browser` 0.27.0 mediante `--version`.
- `agent-browser doctor` detectó Chromium y completó correctamente la prueba de lanzamiento headless del navegador en el entorno de validación.
- La lectura textual del navegador usa `get text body --json`, ya que el CLI 0.27.0 no expone un comando raíz `read`.
- El timeout de `browser-web` usa su propia definición de agente y no hereda accidentalmente el timeout configurable de `researcher-web`.
- La eliminación del perfil temporal del Auth Vault usa una señal de limpieza independiente para intentar borrar las credenciales incluso si la tarea principal fue cancelada.

# Corrección posterior — localhost y colisión con controles de cuenta

Se corrigió una inconsistencia detectada al pedir navegación autenticada hacia `localhost` usando un correo electrónico como usuario.

Problemas encontrados:

- el extractor de destino no reconocía `localhost` sin esquema;
- al no reconocerlo, podía tomar por error el dominio incluido dentro del correo del usuario, por ejemplo `gmail.com`;
- `normalizeBrowserUrl` forzaba HTTPS para destinos locales;
- un modelo débil podía confundir una contraseña de un sitio web con la herramienta para cambiar la contraseña de la cuenta de Luna;
- de forma similar, podía invocar `conversation_clear` sin una petición explícita de reiniciar la conversación.

Correcciones:

- `localhost`, `localhost:puerto`, loopback y redes privadas se detectan antes que dominios públicos;
- los dominios contenidos dentro de direcciones de correo se ignoran como destino del navegador;
- destinos locales y privados sin esquema usan `http://` por defecto;
- cuando una tarea contiene una `credential_ref` segura de navegador, `conversation_clear` y `account_password_change_start` no se exponen al modelo en esa ronda;
- ambas herramientas también tienen una validación determinista en el ejecutor y se rechazan si la intención explícita del usuario no corresponde;
- el cambio natural de contraseña de Luna dejó de activarse por simples menciones de contraseñas externas;
- el texto sanitizado aclara que la credencial pertenece exclusivamente al sitio web y no corresponde a la contraseña de Luna.

Se agregó una regresión con la frase real de `localhost`, correo y contraseña, validando que el destino resultante sea `http://localhost`, el usuario sea el correo completo y la contraseña quede fuera del LLM.

# Corrección posterior — orquestación decidida por el agente principal

Se eliminó cualquier comportamiento que pudiera convertir una heurística de URL/login en un router de herramientas.

Reglas definitivas:

- una URL, `localhost`, una IP, un dominio o un correo no ejecutan `browser_agent`;
- una petición de login sin contraseña no inicia automáticamente la captura segura;
- `browser_request_credential` solo se ejecuta si el agente principal la elige como herramienta;
- una contraseña incluida inline sí se retira localmente antes del LLM por seguridad, pero la referencia resultante es solo un dato disponible para el orquestador;
- todas las herramientas permitidas por rol permanecen visibles al agente principal; no se ocultan herramientas por detectar una supuesta tarea de navegador;
- las acciones sensibles como limpiar conversación o cambiar la contraseña de Luna conservan validaciones deterministas en sus ejecutores, sin usarse como mecanismo de enrutamiento;
- el prompt del sistema deja explícito que el agente principal es el orquestador y debe elegir entre navegación interactiva, investigación pública, subagentes paralelos o ninguna herramienta según el objetivo completo.

# Corrección posterior — preparación automática de agent-browser

Se corrigió el empaquetado detectado en Windows cuando `bun install` dejaba disponible el paquete `agent-browser` pero `scripts/package-runtime.ts` no encontraba `node_modules/agent-browser/bin/agent-browser-win32-x64.exe`.

La preparación ahora es idempotente y automática:

- `agent-browser` está declarado en `trustedDependencies` para permitir su lifecycle oficial bajo Bun;
- `bun install` ejecuta el `postinstall` raíz `bun run prepare:browser`;
- `bun run start`, `bun run dev` y `bun run build` ejecutan también `prepare:browser` antes de iniciar o compilar;
- `scripts/prepare-agent-browser.ts` intenta reutilizar el binario nativo de `node_modules`;
- si falta, ejecuta el `postinstall` oficial de `agent-browser`;
- si continúa faltando, descarga directamente el binario de la release exacta configurada y lo conserva en `assets/runtime/agent-browser/`;
- `scripts/package-runtime.ts` empaqueta prioritariamente ese runtime preparado y falla el build con un error claro si realmente no existe, en vez de generar silenciosamente un `dist` sin navegador;
- el modo desarrollo también resuelve el binario desde `assets/runtime/agent-browser/`.

La preparación detecta Chrome, Brave, Edge y Chromium instalados en Windows, Linux y macOS. Si existe uno, se reutiliza y el runtime establece `AGENT_BROWSER_EXECUTABLE_PATH`. Si no existe navegador compatible ni Chrome for Testing administrado por `agent-browser`, `prepare:browser` ejecuta automáticamente `agent-browser install`. En Linux, cuando el proceso corre como root, usa `install --with-deps`; como usuario normal instala el navegador sin intentar elevar privilegios.

Con este cambio el flujo esperado vuelve a ser únicamente:

```text
bun install
bun run test
bun run build
```

O para desarrollo:

```text
bun install
bun run dev
```

No se requiere ejecutar manualmente `bunx agent-browser install`.

# Corrección posterior — bloqueo de `browser_open` y preferencia de Chrome administrado

Se corrigió un bloqueo observado en Windows donde `browser-web` quedaba indefinidamente en `browser_open` sin emitir `tool_completed`. El wrapper anterior dependía únicamente del timeout global de 20 minutos del subagente, por lo que un proceso CLI de `agent-browser` que no devolviera control podía congelar toda la tarea durante demasiado tiempo.

Cambios:

- cada comando de `agent-browser` tiene ahora un watchdog propio;
- `browser_open` dispone de 45 segundos por intento;
- snapshots, lecturas y consultas usan límites más cortos;
- capturas, descargas y autenticación usan límites específicos apropiados;
- cuando `browser_open` agota el watchdog se intenta consultar la URL actual por si la navegación sí terminó pero el CLI no devolvió control;
- si la sesión quedó trabada, se rota a una sesión limpia y se reintenta la apertura una sola vez;
- ningún comando individual puede volver a bloquear silenciosamente los 20 minutos completos del subagente;
- los logs `browser.runtime.command_started`, `command_completed`, `command_timeout`, `open_retry` y `session_rotated` permiten diagnosticar exactamente dónde se detuvo la navegación.

También se cambió la selección de navegador. El runtime ahora prioriza:

1. `AGENT_BROWSER_EXECUTABLE_PATH` cuando el operador la define explícitamente;
2. Chrome for Testing instalado y administrado por `agent-browser`;
3. Chrome, Brave, Edge o Chromium del sistema como fallback.

`prepare:browser` instala por defecto Chrome for Testing cuando todavía no existe, incluso si hay un Chrome del sistema. Esto hace que `bun install`, `bun run dev` y `bun run build` utilicen un navegador reproducible y probado con la versión fijada de `agent-browser`. El uso preferente del navegador del sistema queda disponible mediante `LUNA_AGENT_BROWSER_USE_SYSTEM_BROWSER=1`.


## Corrección de bloqueo de pipes en Windows

Se corrigió un bloqueo específico del wrapper de procesos de `agent-browser`. El CLI usa un daemon persistente y en Windows el daemon puede conservar abiertos los handles heredados de `stdout`/`stderr` incluso después de que el proceso CLI termine. El wrapper anterior esperaba EOF mediante `Response(stream).text()`, por lo que podía quedarse bloqueado indefinidamente después de `browser.runtime.command_started` sin llegar a `command_completed` ni activar el watchdog, ya que `child.exited` ya se había resuelto.

El runtime ahora consume la salida concurrentemente mientras el CLI está vivo, aplica un drenado breve al terminar y cancela explícitamente los lectores sin depender de EOF. También fija `AGENT_BROWSER_DEFAULT_TIMEOUT=20000` por defecto, por debajo del timeout IPC de 30 segundos documentado por agent-browser, conservando la posibilidad de sobrescribirlo mediante variable de entorno.
