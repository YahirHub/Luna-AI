# 85 — Identidad explícita en login de browser-agent

# Fecha

2026-07-23

# Problema

Cuando el usuario pedía algo como `abre X e inicia sesión` sin indicar correo/usuario, `browser-web` podía asumir una identidad. Había tres rutas principales:

- si existía un único perfil cifrado para el dominio, el runtime tomaba automáticamente su usuario;
- `browser_auth_login` podía seleccionar el único perfil disponible usando solo la URL;
- una sesión persistida o un formulario prellenado podían hacer que el agente considerara válido un login sin que el usuario hubiera confirmado qué cuenta quería usar.

Esto era incorrecto: conocer o tener guardada una cuenta no equivale a autorización para seleccionarla en una nueva orden de login.

# Regla vigente

Una nueva misión que ordena explícitamente iniciar sesión necesita una **identidad explícita**. La cuenta se considera seleccionada solamente cuando ocurre una de estas condiciones:

1. el mensaje original del usuario contiene el usuario/correo;
2. la tarea recibió una `browser-cred-*` temporal capturada explícitamente para esa petición; una `browser-profile-*` persistente seleccionada por el orquestador no basta;
3. durante la ejecución, `browser_request_user_input(kind=username)` pregunta qué cuenta usar y el usuario responde.

No son autorización:

- que exista una sola cuenta guardada;
- que el dominio coincida con un perfil;
- que una sesión anterior siga autenticada;
- que el formulario tenga un correo prellenado;
- que el modelo vea una cuenta mediante `browser_auth_profiles`;
- que el modelo invente o deduzca un correo.

# Implementación

## Política comprobable

`browserLoginRequiresIdentityConfirmation` centraliza la decisión. Detecta una orden explícita de login y exige confirmación cuando no hay usuario en la petición, identidad confirmada durante la tarea ni una `browser-cred-*` temporal capturada para esa petición. Una `browser-profile-*` persistente nunca elimina por sí sola esta confirmación.

## Bloqueo autoritativo de acciones

Mientras la identidad está pendiente, `BrowserAgentExecution` permite abrir e inspeccionar el sitio, pero bloquea acciones capaces de avanzar un login o reutilizar una cuenta:

- `browser_click`
- `browser_fill`
- `browser_type`
- `browser_press`
- `browser_auth_profiles`
- `browser_auth_login`
- `browser_fill_secret`
- `browser_auth_confirm`

La respuesta recuperable `login_identity_required` obliga al agente a llamar `browser_request_user_input` con `kind=username`.

## Sesión persistida

Una página que ya aparece autenticada tampoco resuelve la identidad. Si la misión actual pidió explícitamente iniciar sesión y no indicó cuenta, el guard de finalización intercepta incluso una respuesta aparentemente exitosa y solicita el usuario/correo antes de permitir terminar la misión.

Esto no impide reutilizar sesiones persistidas para navegación normal ni reautenticar automáticamente una identidad que ya fue confirmada dentro de la tarea.

## Selección de credenciales

`browser_auth_login` ya no selecciona una cuenta usando únicamente una URL. Para resolver un perfil persistente necesita una identidad confirmada. Si una `credential_ref` pertenece a un usuario distinto del confirmado, devuelve `login_identity_mismatch` y no ejecuta el login.

`browser_request_user_input(kind=password)` tampoco obtiene automáticamente el usuario desde un perfil único. Si todavía falta identidad, transforma el flujo en una solicitud `username`.

# Seguridad y comportamiento esperado

Ejemplo:

```text
Usuario: Abre example.com e inicia sesión.
Luna: ¿Qué usuario o correo debo usar para iniciar sesión en example.com?
Usuario: cuenta@example.com
Luna: [continúa la misma tarea; reutiliza la credencial cifrada de esa identidad si existe o solicita su contraseña]
```

No debe ocurrir:

```text
Usuario: Abre example.com e inicia sesión.
Luna: Usaré cuenta@example.com porque es la única cuenta guardada.
```

# Archivos principales

- `src/browser/browser-credentials.ts`
- `src/browser/browser-runtime.ts`
- `src/browser/browser-tools.ts`
- `src/agents/definitions/browser-web.ts`
- `src/agents/spawn-agents-tool.ts`
- `__tests__/browser-credentials.test.ts`
- `__tests__/agentic-integration-source.test.ts`

# Pruebas recomendadas

```bash
bun run typecheck
bun run test
bun run build
```

Pruebas manuales:

1. Con una única cuenta guardada para un dominio, pedir `abre X e inicia sesión` sin correo: debe preguntar identidad.
2. Con varias cuentas guardadas, mismo resultado: debe preguntar identidad.
3. Con una sesión persistida ya autenticada, pedir una nueva orden explícita de login sin correo: debe preguntar qué cuenta usar antes de considerar la misión completada.
4. Especificar `inicia sesión con correo@example.com`: no debe volver a preguntar el usuario y puede buscar la credencial de esa identidad.
5. Responder a la solicitud de usuario con un correo: debe continuar la misma task/agent y después reutilizar o solicitar la contraseña de esa cuenta.
6. Intentar usar una `credential_ref` de otra identidad después de confirmar el correo: debe devolver `login_identity_mismatch`.
