# 59 — Cola de búsquedas, recuperación oficial y depuración completa

# Fecha

2026-07-17

# Objetivo

Corregir la regresión por la que los cuatro trabajadores de una investigación paralela de precios podían fallar inmediatamente al iniciar sus búsquedas y habilitar trazabilidad completa en consola.

# Causa encontrada

El pipeline especializado de precios iniciaba la primera búsqueda de los cuatro trabajadores al mismo tiempo. Aunque el runtime ya serializaba cada proveedor, Tavily no tenía un intervalo mínimo configurado. En planes con límites estrictos de ráfaga, las solicitudes consecutivas podían recibir HTTP 429.

Además, la búsqueda inicial de precios se trataba como requisito fatal. Si el motor lanzaba una excepción, el trabajador terminaba antes de intentar las URLs oficiales conocidas de OpenAI, Anthropic, DeepSeek o MiniMax.

El progreso final también era inconsistente: una tarea con cero precios se persistía como `failed`, pero WhatsApp mostraba `completada parcialmente`.

# Soluciones implementadas

## Cola global de búsquedas

Se agregó `src/search/search-coordinator.ts`.

- Una sola búsqueda activa de forma predeterminada.
- Intervalo mínimo predeterminado de 1250 ms entre inicios.
- Reintentos con backoff exponencial.
- Cancelación mientras una petición espera en la cola.
- Configuración mediante variables de entorno.
- Los trabajadores continúan en paralelo; únicamente se regula el acceso al recurso limitado.

El runtime también aplica 1250 ms como intervalo mínimo específico de Tavily, además de conservar su cola por proveedor y recuperación de HTTP 429.

## Recuperación sin buscador

Las búsquedas de precios dejaron de ser fatales.

Si una búsqueda falla:

1. el error se registra como advertencia;
2. el trabajador continúa con las URLs oficiales candidatas del proveedor;
3. ejecuta `read_url` directamente;
4. extrae precios desde la evidencia obtenida;
5. solo realiza una segunda búsqueda si todavía no existen importes.

Esto permite completar una investigación cuando Tavily está temporalmente limitado, siempre que la documentación oficial sea accesible.

## Depuración completa

Se agregó `src/debug.ts` con logs JSON estructurados activos por defecto.

Se registran:

- tarea, JID, modelo, profundidad y temas;
- inicio y final de cada trabajador;
- espera, inicio y liberación de la cola;
- motor de búsqueda, resultados, intentos y errores;
- HTTP 429 y tiempos de reintento;
- URLs leídas, tiempo, cantidad de contenido y errores;
- filas y fuentes de precios extraídas;
- creación y entrega de artefactos;
- excepción completa con stack y causa.

Los secretos se redactan automáticamente. `LUNA_DEBUG=false` desactiva los logs y `LUNA_DEBUG_VERBOSE=true` evita truncar cadenas largas.

## Diagnósticos persistidos

Cuando un trabajador lanza una excepción, `result.json` conserva `errorDetails` con nombre, mensaje, stack y causa, además del error resumido y `evidence.jsonl`.

## Estado correcto de la tarea

El evento final admite `failed`. WhatsApp muestra `❌ Tarea ... fallida` cuando no existe ningún precio verificable, en lugar de presentarla como completada parcialmente.

# Variables nuevas

```text
LUNA_DEBUG
LUNA_DEBUG_VERBOSE
LUNA_SEARCH_CONCURRENCY
LUNA_SEARCH_MIN_INTERVAL_MS
LUNA_SEARCH_RETRY_ATTEMPTS
LUNA_SEARCH_RETRY_BASE_MS
```

# Archivos modificados

```text
src/debug.ts
src/search/search-coordinator.ts
src/search/search-runtime.ts
src/search/read-url.ts
src/research-agent.ts
src/research/pricing-extractor.ts
src/orchestration/parallel-research.ts
src/bot.ts
README.md
__tests__/research-agent.test.ts
__tests__/search-coordinator.test.ts
contexto/01-contexto-maestro.md
contexto/59-cola-busquedas-recuperacion-oficial-y-debug.md
```

# Validación

- Typecheck completo aprobado.
- 357 pruebas aprobadas.
- 0 fallos.
- 949 verificaciones.
- Regresiones de alarmas y recordatorios aprobadas.
- Prueba de cola con cuatro solicitudes simultáneas aprobada.
- Prueba de recuperación directa desde documentación oficial después de un HTTP 429 aprobada.

# Prueba manual recomendada

Repetir:

```text
Investiga los precios actuales de las APIs de DeepSeek, MiniMax, OpenAI y Anthropic. Compara sus modelos activos en una tabla y entrégame el resultado en PDF.
```

En consola deben aparecer registros `[LUNA DEBUG]`, `[LUNA INFO]`, `[LUNA WARN]` o `[LUNA ERROR]` con la tarea y cada fase. Si Tavily limita una solicitud, debe aparecer `rate_limited` o `will_retry`; el trabajador debe continuar después con `research.fetch` sobre la documentación oficial.
