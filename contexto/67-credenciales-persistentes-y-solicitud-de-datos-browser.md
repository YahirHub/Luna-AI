# 67 — Credenciales persistentes y solicitud de datos del navegador

# Fecha

2026-07-18

# Objetivo

Permitir que `browser-web` pueda reutilizar credenciales de sitios cuando una sesión caduque, soportar varias cuentas por dominio y pedir datos adicionales al usuario mediante el sistema sin exponer contraseñas u OTP al LLM.

# Decisiones

- El agente principal sigue siendo el orquestador. Detectar una URL, correo o credencial no ejecuta `browser_agent` automáticamente.
- Las contraseñas nunca se entregan al LLM.
- Las credenciales persistentes pertenecen al JID autenticado y se aíslan entre usuarios de Luna.
- Un dominio puede tener varias cuentas; la identidad se resuelve por origen + correo/usuario.
- La contraseña persistente se guarda cifrada con AES-256-GCM en el almacenamiento local de Luna.
- La clave de cifrado se conserva en `persistent/browser/encryption.key`.
- Los perfiles cifrados se guardan en `persistent/browser/credential-profiles.json` y no contienen contraseñas en texto plano.
- Cuando se utiliza una credencial, la contraseña se descifra únicamente dentro del runtime del navegador y se pasa temporalmente a `agent-browser` mediante `stdin` para `auth save`/`auth login`.
- El perfil temporal del vault interno de `agent-browser` se elimina al terminar el login; la copia persistente sigue cifrada en Luna.
- Si un login con una credencial temporal funciona, Luna guarda o reemplaza automáticamente el perfil cifrado de la misma URL + usuario para futuras reautenticaciones.

# Herramientas del agente principal

Se agregan:

- `browser_credentials_list`
- `browser_credentials_save`
- `browser_credentials_delete`

Permiten administrar perfiles mediante lenguaje natural sin mostrar secretos.

`browser_request_credential` se conserva como vía del agente principal para solicitar una contraseña cuando conoce URL y usuario pero todavía no dispone de una referencia segura.

# Herramientas de browser-web

Se agregan:

- `browser_auth_profiles`: lista referencias seguras de cuentas guardadas, filtrables por URL y usuario.
- `browser_request_user_input`: solicita al sistema un dato humano faltante (`username`, `password`, `otp` o `text`).
- `browser_fill_secret`: consume una `secret_ref` temporal para rellenar OTP u otro secreto de un solo uso sin entregarlo al LLM.

`browser_auth_login` ahora acepta:

- una `browser-cred-*` temporal;
- una `browser-profile-*` persistente;
- o `url + username`, resolviendo automáticamente una cuenta persistente cuando existe exactamente una coincidencia.

# Flujo de reautenticación

1. `browser-web` detecta que la sesión ya no está autenticada.
2. Consulta `browser_auth_profiles` para la URL/usuario.
3. Si encuentra una cuenta, usa `browser_auth_login` sin pedir contraseña al usuario.
4. La contraseña se descifra solo dentro del sistema y se inyecta por `stdin`.
5. Si la contraseña dejó de ser válida, el agente llama `browser_request_user_input` con `kind=password`.
6. El sistema envía un `MENSAJE DEL SISTEMA` por WhatsApp indicando que el agente no debe conocer la contraseña.
7. La respuesta se captura fuera del LLM, se intenta borrar de WhatsApp y se convierte en una referencia temporal.
8. La solicitud original se reanuda.
9. Tras un login correcto, la contraseña cifrada de la misma URL + usuario se reemplaza automáticamente.

# Solicitud genérica de datos

Cuando `browser-web` necesita información adicional:

- `username` o `text`: el sistema pregunta al usuario y reanuda la misión con el dato como contexto de sistema.
- `password`: el sistema exige URL + usuario, captura el valor fuera del LLM y devuelve una `credential_ref`.
- `otp`: el sistema captura el código fuera del LLM y devuelve una `secret_ref` consumible una sola vez mediante `browser_fill_secret`.

Cuando `browser_agent` devuelve `waiting_for_user_input`, el agente principal no debe volver a pedir el dato ni continuar la tarea en ese turno. El sistema ya envió la solicitud y reanudará automáticamente el mensaje original cuando llegue la respuesta.

# Archivos principales

- `src/browser/browser-credentials.ts`
- `src/browser/browser-tools.ts`
- `src/browser/browser-runtime.ts`
- `src/agents/definitions/browser-web.ts`
- `src/agents/spawn-agents-tool.ts`
- `src/bot.ts`
- `src/context.ts`
- `README.md`
- `__tests__/browser-credentials.test.ts`
- `__tests__/agentic-integration-source.test.ts`

# Compatibilidad y regresiones

- Se mantienen las referencias temporales `browser-cred-*` existentes.
- `browser_request_credential` sigue funcionando.
- Alarmas y recordatorios no cambian.
- No se modifican los gestores de persistencia de alarmas, recordatorios, memoria o WhatsApp.
- No se eliminan `node_modules`, `assets`, `persistent` ni `dist` como parte de esta implementación.

# Validación

- `npx tsc --noEmit --pretty false`: correcto.
- `npx --yes bun test`: 387 pruebas aprobadas, 0 fallos, 1140 verificaciones, 47 archivos.
