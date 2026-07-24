# 83 — Diagnóstico de tests y dependencias

# Fecha

2026-07-23

# Problema

Una instalación nueva podía ejecutar `bun run test` sin haber ejecutado `bun install`. Como los ZIP de entrega no incluyen `node_modules`, Bun alcanzaba casi toda la suite y terminaba con errores de carga en los pocos tests que importan dependencias externas. El wrapper `scripts/run-tests.mjs` solo reconocía líneas `(fail)`/`✗`, por lo que los errores de carga quedaban ocultos detrás del mensaje genérico `No pude identificar un test fallido concreto`.

En el proyecto actual los cuatro puntos de carga externos que explican el patrón observado son:

- `@twemoji/parser` desde `src/artifacts/twemoji.ts`;
- `yaml` desde `src/skills/skill-manager.ts`;
- `pngjs` desde `src/usage/usage-card.ts`;
- `@whiskeysockets/baileys` desde `src/transports/baileys/adapter.ts`.

Todos están declarados en `package.json`; no se sustituyen ni se eliminan.

# Solución

- `scripts/run-tests.mjs` verifica antes de lanzar Bun que todas las dependencias y devDependencies declaradas tengan su `package.json` dentro de `node_modules`.
- Si faltan paquetes, la suite no se ejecuta parcialmente: se lista cada dependencia ausente y se indica ejecutar `bun install` y después `bun run test`.
- El analizador de fallos ahora reconoce también errores de carga o evaluación (`error:`, `SyntaxError`, `TypeError`, `ReferenceError`, `RangeError`) y muestra el archivo de test y el bloque de detalle aunque Bun no emita una línea `(fail)`.
- Se conserva la regla de entrega: `node_modules` no se incluye en los ZIP.

# Validación

- El preflight fue comprobado en una copia limpia sin `node_modules` y devuelve una lista determinista de dependencias faltantes antes de ejecutar tests parciales.
- Las verificaciones estáticas de goals, módulos, workspace y el fix de `goal_instruction` continúan pasando en el entorno de diagnóstico.
- La ejecución completa con Bun requiere instalar dependencias en el host de pruebas mediante `bun install`.
