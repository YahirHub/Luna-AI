# 86 — Lazy Capabilities y optimización de contexto/tokens

# Fecha

2026-07-23

# Objetivo

Reducir de forma estructural los tokens enviados al LLM sin retirar capacidades de Luna. La optimización se aplica a schemas de tools, prompts modulares, memoria persistente, skills, resultados grandes de herramientas y compactación.

# Principio

Luna ya no envía todas las tools autorizadas en cada request. `ModuleRegistry` selecciona capacidades por intención y el agente conserva una única vía de escape pequeña: `capability_load`.

Si durante una ronda el modelo descubre que necesita una capacidad que no fue detectada inicialmente, ejecuta:

```text
capability_load({ capability: "workspace" })
```

`chatCompletionWithTools` vuelve a resolver el toolset en la ronda siguiente mediante `resolveTools`, por lo que las nuevas tools aparecen dentro del mismo turno, sin reiniciar la conversación ni perder resultados previos.

Para favorecer prompt caching, el loop conserva el orden de las tools que ya estaban presentes y anexa al final las definiciones que aparecen al cargar una capacidad. Una tool que deja de estar autorizada sí se retira; el orden estable nunca conserva permisos obsoletos.

# Dos niveles de exposición

Una tool declarada por un módulo puede marcarse `defer: true`. El prompt del módulo también se divide entre `instructions` (mínimas/eager) y `loadInstructions` (entregadas al cargar la capacidad completa), para no explicar herramientas que todavía no están presentes.

- La activación automática por intención expone solo la superficie frecuente/segura del módulo.
- `capability_load` expone la superficie completa para ese turno, incluidas las tools diferidas.
- Los módulos fijados por estado, por ejemplo un goal o agente activo, permanecen visibles pero no desbloquean por sí solos herramientas diferidas.

Ejemplos:

- `workspace`: lectura, glob, búsqueda, stat y lectura múltiple son eager; escritura, borrado, patch y ejecución son diferidos.
- `goals`: iniciar/consultar/controlar un goal es eager; `tasklist_*` se reserva al GoalRuntime o a una carga explícita.
- `skills`: `skill_search`, `skill_load` y lectura son eager; catálogo completo, copia y ejecución de scripts son diferidos.
- `tts`: hablar/estado/modo son eager; administración de voces/modelos es diferida.
- `browser`: el subagente es eager; la administración directa del almacén de credenciales es diferida.

# Goals

GoalRuntime usa el mismo mecanismo dinámico. Arranca con `goals + workspace` completamente cargados porque necesita tasklist, edición y ejecución para poder completar trabajo real. `skills` permanece inicialmente en su superficie pequeña (`skill_search`, `skill_load`, `skill_read_resource`); catálogo, copia y scripts solo aparecen después de `capability_load("skills")`. Procesos, navegador, búsqueda, artefactos, TTS u otras capacidades también se amplían únicamente cuando el objetivo las requiere.

El goal no depende de un toolset congelado: `resolveTools` recalcula las definiciones entre rondas.

# Subagentes

El progressive disclosure también aplica dentro de `AgentRuntime`. Los subagentes pueden declarar `initialToolNames` y grupos `toolGroups`; `agent_capability_load` incorpora un grupo durante la misma ejecución mediante `resolveTools`.

`browser-web` empieza con navegación/interacción esencial y carga bajo demanda `inspect`, `assets`, `auth`, `workspace` o `skills`. `browser_request_user_input` permanece en la superficie inicial para conservar el guard autónomo de credenciales/datos humanos.

`researcher-web` empieza con `web_search` y `read_url`; workspace y skills se incorporan solo cuando la investigación realmente necesita guardar un handoff o consultar una skill. Los grupos nunca pueden ampliar el allowlist total declarado por el agente.

# Skills

El catálogo completo de skills deja de inyectarse en cada turno.

`skill_search` realiza descubrimiento local y devuelve solo las skills con mayor coincidencia. `skill_load` carga el `SKILL.md` únicamente cuando una skill concreta es relevante.

El cuerpo completo devuelto por `skill_load` ya no se guarda como un mensaje permanente en el historial de conversación. Permanece disponible durante la ejecución actual mediante el resultado de tool, evitando pagar ese mismo contenido en todos los turnos futuros.

Los subagentes de investigación reciben únicamente `skill_search`, `skill_load` y `skill_read_resource`; no reciben ejecución arbitraria de scripts.

# Memoria

`memory.md` conserva compatibilidad de almacenamiento hasta 64.000 caracteres, pero solo un perfil compacto de hasta 4.000 caracteres se inyecta automáticamente.

El selector prioriza nombre, forma de trato, idioma, preferencias, formato, zona horaria y datos estables similares. El contenido completo sigue accesible mediante `memory_read`.

La plantilla inicial de `memory.md` ya no contiene un manual de comportamiento: esas instrucciones pertenecen al código/prompt y no a la memoria del usuario.

La bóveda temática continúa siendo el mecanismo para información extensa y se recupera por relevancia.

# Resultados grandes de tools

`chatCompletionWithTools` virtualiza resultados no terminales que superan el umbral configurado (20.000 caracteres por defecto).

El LLM recibe una vista previa y un `result_ref`. La tool interna efímera `tool_result_read` permite solicitar fragmentos concretos de hasta 12.000 caracteres. El contenido completo existe solo en memoria durante esa ejecución y expira al finalizar el loop.

Las tools terminales conservan su comportamiento: su resultado es el cierre autoritativo y no provoca una nueva llamada innecesaria al LLM principal.

# Contexto negativo y compactación

- Los resúmenes de agentes/goals vacíos dejan de inyectar frases del tipo “no hay tareas”.
- Los resultados revisados de tareas de fondo no se mantienen como contexto supervisor global después de haber sido incorporados al historial.
- El resumen compactado que se reinyecta tiene un límite duro de 8.000 caracteres y límites por categoría.
- La planificación de auto-compactación calcula el presupuesto con las tools realmente relevantes al mensaje actual, no con todo el catálogo autorizado.

# Prompt modular

`buildCapabilityPrompt` dejó de enumerar todos los módulos disponibles en cada turno. Solo describe capacidades activas. `capability_load` contiene el índice compacto necesario para descubrir capacidades adicionales.

`goals`, `skills` y `tts` dejan de usar `always: true`; se activan por intención/estado.

# Compatibilidad y seguridad

- No cambia el formato persistente de usuarios, goals, memoria, bóveda, credenciales o tareas.
- Una tool no declarada en `ModuleRegistry` continúa rechazada por defecto.
- `availableWhen`, autenticación y rol siguen siendo autoritativos aunque se invoque `capability_load`.
- La carga lazy no amplía permisos; solo hace visible una tool que la sesión ya estaba autorizada a utilizar.
- Las protecciones de credenciales/OTP/secretos del browser-agent permanecen sin cambios.

# Pruebas relevantes

Se amplía cobertura para:

- filtrado de tools por intención;
- tools diferidas frente a una capacidad explícitamente cargada;
- expansión de tools dentro del mismo loop de function calling;
- búsqueda local de skills;
- ausencia del catálogo completo de skills en el contexto base;
- memoria compacta;
- límite duro del resumen compactado;
- virtualización y lectura por chunks de resultados grandes;
- TTS, goals y skills ya no permanentes.

# Validación requerida en entorno con Bun

```bash
bun install
bun run typecheck
bun run test
bun run build
```
