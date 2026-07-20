# 69 — Ignorar grupos y proteger sesiones de WhatsApp

# Fecha

2026-07-19

# Problema

Luna identificaba las sesiones únicamente por `message.key.remoteJid`. En un chat privado ese JID representa al usuario, pero en un grupo representa al grupo completo (`@g.us`).

Esto permitía iniciar el flujo de autenticación dentro de un grupo. Como `AuthManager` mantiene una sola sesión activa por nombre de usuario, autenticar la misma cuenta desde el JID del grupo eliminaba la sesión privada previa y la reemplazaba por la sesión compartida del grupo. Además de provocar que el chat privado volviera a pedir login, una sesión de grupo persistida era un riesgo para operaciones que resuelven el JID activo de un usuario.

# Decisión temporal de seguridad

Luna no procesa mensajes procedentes de grupos de WhatsApp. Los grupos se ignoran silenciosamente hasta que exista un modelo explícito de identidad y permisos para conversaciones multiusuario.

# Implementación

- Se agregó `src/whatsapp-message-guard.ts` con detección centralizada de JIDs `@g.us`.
- `src/connection.ts` descarta mensajes de grupo directamente en `messages.upsert`, antes de llamar a `handleMessage`.
- `src/bot.ts` mantiene una segunda barrera al inicio de `handleMessage`, antes de marcar como leído o ejecutar autenticación, comandos, multimedia, LLM o cualquier mutación de estado.
- `src/auth.ts` rechaza cualquier intento de login cuyo JID sea de grupo.
- Al cargar `persistent/users.json`, `AuthManager` descarta sesiones históricas asociadas a JIDs de grupo. Esto impide que una sesión creada antes del arreglo siga activa en memoria o sea devuelta por `getJid`.

# Comportamiento esperado

- Un mensaje enviado en un grupo no recibe respuesta de Luna.
- El mensaje de grupo no inicia `!login`, `!setup`, comandos, herramientas ni tareas del agente.
- El grupo no puede crear ni reemplazar una sesión autenticada.
- Una sesión privada existente permanece intacta cuando el mismo usuario escribe en un grupo.
- Las sesiones de grupo antiguas dejan de restaurarse al reiniciar Luna.

# Pruebas añadidas

`__tests__/whatsapp-group-isolation.test.ts` valida:

- detección correcta de JIDs de grupo;
- rechazo de login desde grupos;
- descarte de sesiones de grupo persistidas previamente;
- filtro temprano en la conexión;
- barrera secundaria antes de marcar mensajes como leídos.

# Riesgos y futuro

Si en el futuro se habilitan grupos, no debe reutilizarse el JID del grupo como identidad de usuario. La autenticación tendrá que vincularse al participante real (`message.key.participant` o equivalente validado por Baileys) y definir permisos, privacidad de contexto, memoria, herramientas, artefactos y entregas programadas específicamente para entornos multiusuario.
