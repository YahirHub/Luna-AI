# 63. Captura inline de credenciales y cambio de contraseña

## Objetivo

Corregir la inconsistencia por la que una API key incluida en la misma frase natural que solicita configurarla obligaba al usuario a enviarla de nuevo en un mensaje separado.

## Cambios

- Las API keys de motores de búsqueda incluidas junto con la instrucción se detectan localmente antes de enviar el mensaje al LLM.
- Se reconoce el proveedor mencionado, incluyendo alias como `fireclaw` para `firecrawl`, se extrae la clave, se guarda y activa el motor inmediatamente.
- Si existía un flujo interactivo de búsqueda pendiente, se cierra para evitar estados fantasma.
- El mensaje que contiene la credencial se intenta borrar de WhatsApp después de procesarlo.
- Se mantiene el flujo seguro de mensaje posterior cuando el usuario pide configurar una clave pero todavía no la proporciona.
- Todos los usuarios autenticados pueden cambiar su propia contraseña mediante lenguaje natural o `!cambiar-password`.
- Si la contraseña viene incluida en la misma frase natural, se cambia inmediatamente y se intenta borrar el mensaje. Si no viene incluida, se inicia una captura segura en el siguiente mensaje.
- El cambio de contraseña conserva la sesión activa y no altera roles, memoria, alarmas, recordatorios ni workdir.
