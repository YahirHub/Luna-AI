# 037 — Agente de búsqueda y alarmas dentro del contexto

# Fecha

2026-07-16

# Objetivo

Agregar las alarmas realmente entregadas al contexto persistente del usuario e incorporar búsqueda web multiproveedor, lectura segura de fuentes, configuración desde WhatsApp y un subagente investigador aislado.

# Decisiones tomadas

- Una alarma solo se agrega al contexto después de que WhatsApp confirma el envío.
- El contexto conserva tanto el evento automático como el texto exacto entregado por Luna.
- Un fallo posterior al guardar el contexto no debe provocar el reenvío de la alarma.
- La búsqueda web se implementa como herramienta opcional y no reemplaza OpenCode Free ni el proveedor LLM activo.
- Se admiten Tavily, Brave Search, Exa, Linkup, Firecrawl, SerpApi y Zenserp.
- Las preferencias de búsqueda y las API keys se guardan en archivos separados.
- `/setup-search` solo está disponible para administradores y se usa únicamente para configurar motores.
- `/config` controla las herramientas internas de búsqueda, el subagente, la profundidad y el timeout.
- No existe un comando público para buscar; Luna decide automáticamente cuándo usar búsqueda, lectura de fuentes o un subagente.
- El subagente hereda el proveedor y modelo del usuario, pero recibe un contexto aislado.
- El investigador solo dispone de `web_search` y `read_url`; no puede modificar memoria, alarmas, recordatorios ni usuarios.
- `read_url` bloquea esquemas no HTTP, hosts locales, redes privadas, credenciales embebidas y redirecciones inseguras.
- No se agregaron dependencias para búsqueda, lectura HTML o persistencia.

# Arquitectura actual

- `src/scheduled-context.ts`: registra entregas confirmadas de alarmas dentro del contexto.
- `src/agent-config.ts`: configuración persistente y flujo interactivo `/config`.
- `src/search/search-config.ts`: catálogo de proveedores, normalización y resolución de estado.
- `src/search/search-storage.ts`: archivos separados para preferencias y credenciales.
- `src/search/search-runtime.ts`: adaptadores HTTP, normalización y fallback entre motores.
- `src/search/search-setup.ts`: menú administrativo `/setup-search`.
- `src/search/search-tools.ts`: definición y ejecución de `web_search`.
- `src/search/read-url.ts`: definición y ejecución de `read_url` con protecciones SSRF.
- `src/research-agent.ts`: subagente investigador aislado y fallback para gateways sin function calling.
- `src/bot.ts`: expone solo los comandos de configuración y habilita tools internas según `/config`.
- `src/context.ts`: instruye al modelo sobre cuándo buscar, leer fuentes o delegar investigación.
- `src/ai.ts`: permite cancelar solicitudes y limitar las rondas de herramientas.

# Librerías usadas

- APIs nativas de Node/Bun: `fetch`, `AbortController`, `URL`, DNS, filesystem y temporizadores.
- Baileys ya existente para los mensajes de WhatsApp.
- No se agregaron dependencias.

# Archivos importantes modificados

- `src/ai.ts`
- `src/bot.ts`
- `src/context.ts`
- `src/scheduled-messages.ts`
- `src/scheduled-context.ts`
- `src/agent-config.ts`
- `src/research-agent.ts`
- `src/search/search-config.ts`
- `src/search/search-storage.ts`
- `src/search/search-runtime.ts`
- `src/search/search-setup.ts`
- `src/search/search-tools.ts`
- `src/search/read-url.ts`
- `README.md`
- `__tests__/agent-config.test.ts`
- `__tests__/search-storage.test.ts`
- `__tests__/search-runtime.test.ts`
- `__tests__/search-setup.test.ts`
- `__tests__/read-url.test.ts`
- `__tests__/scheduled-context.test.ts`
- `__tests__/research-agent.test.ts`
- `__tests__/commands.test.ts`

# Problemas encontrados

- Las alarmas entregadas no formaban parte del historial que recibe el asistente.
- El proyecto no tenía acceso a información actualizada ni forma de verificar fuentes.
- No existía separación entre preferencias de motores y credenciales.
- Un investigador con acceso a todas las herramientas del bot habría tenido privilegios innecesarios.
- La lectura directa de URLs podía introducir SSRF, descargas grandes o redirecciones hacia redes internas.
- La cancelación del subagente debía propagarse hasta las solicitudes HTTP y el proveedor LLM.

# Soluciones implementadas

- Registro atómico del evento de alarma y de la respuesta enviada.
- Runtime multiproveedor con resultados normalizados y fallback ordenado.
- Menú de configuración numérico desde WhatsApp.
- Archivos `persistent/search.json` y `persistent/search-auth.json`.
- Configuración global en `persistent/agent-config.json`.
- Tool de lectura con validación de cada URL y cada redirección.
- Subagente con contexto mínimo, máximo de rondas y timeout configurable.
- Fallback de búsqueda directa cuando un gateway no ejecuta function calling.
- Persistencia natural de la consulta y la respuesta final dentro de la conversación, sin un comando especial.
- Pruebas para configuración, almacenamiento, fallback, lectura segura, subagente y alarmas.

# Pendientes

- Ejecutar pruebas reales con API keys válidas de cada motor.
- Validar el comportamiento de function calling con todos los modelos gratuitos activos.
- Medir consumo de tokens del subagente con investigaciones profundas.
- Considerar límites diarios por usuario si el bot se expone a muchas cuentas.
- La validación DNS previa reduce SSRF, pero un entorno de alto riesgo puede requerir un resolvedor o proxy de salida que fije la IP para evitar DNS rebinding.

# Próximos pasos

- Ejecutar `bun install`, generar y versionar `bun.lock`.
- Ejecutar `bun run typecheck`, `bun test` y `bun run build` con dependencias reales.
- Configurar dos motores desde `/setup-search` y probar el fallback.
- Crear una alarma próxima y verificar su registro dentro de `context.json`.
- Enviar una pregunta actual en lenguaje natural y verificar que Luna decida buscar sin comandos.
- Reiniciar Docker conservando el volumen y validar la persistencia de todas las configuraciones.
