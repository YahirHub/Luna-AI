# 72 — Modelo LLM global

# Fecha

2026-07-20

# Problema

La configuración del proveedor guardaba un `defaultModel` global, pero cada conversación también persistía su propio campo `model` dentro de `persistent/contexts/<jid>/context.json`. Al reemplazar el provider, un chat existente podía seguir enviando el modelo del proveedor anterior. Esto provocaba errores como usar `deepseek-v4-flash-free` contra un catálogo nuevo que solo ofrecía `deepseek-v4-flash`.

# Solución

- El modelo activo pasa a ser una única selección global para toda la instancia de Luna.
- `ContextManager.getModel()` devuelve siempre el modelo global actual y ya no restaura selecciones por JID.
- Los campos `model` heredados se eliminan de la representación de un contexto al cargarlo y dejan de influir en solicitudes nuevas.
- Al completar `/setup-provider`, el modelo elegido se aplica inmediatamente a chats existentes y nuevos.
- `!modelos` y la herramienta natural `model_set` cambian el modelo global, no solo el del usuario que ejecutó la acción.
- Alarmas, recordatorios y subagentes que consultan `ContextManager.getModel()` reciben automáticamente la misma selección global.

# Persistencia

Se añade `persistent/llm.model.json` junto a `llm.config.json`.

La selección contiene:

- `modelsUrl`: identifica el catálogo/provider al que pertenece la selección.
- `model`: modelo global activo.

Al iniciar Luna, la selección solo se restaura cuando el `modelsUrl` coincide con el proveedor activo. Una selección de un provider anterior nunca se reutiliza sobre otro catálogo.

Para providers personalizados, cambiar el modelo actualiza también `defaultModel` dentro de `llm.config.json`.

# Compatibilidad

No se requiere migrar manualmente los `context.json` existentes. Un campo `model` antiguo puede permanecer en disco hasta que ese contexto vuelva a guardarse, pero ya no participa en la selección del modelo.

# Pruebas requeridas

1. Configurar un provider nuevo cuyo catálogo no contenga el modelo usado anteriormente.
2. Elegir un modelo durante `/setup-provider`.
3. Enviar un mensaje desde un chat existente sin ejecutar `!modelos`; debe usar el modelo nuevo.
4. Ejecutar `!modelos`, elegir otro modelo y comprobar desde un segundo chat que también usa la nueva selección.
5. Reiniciar Luna y verificar que conserva el modelo global cuando corresponde al mismo provider.
6. Cambiar a otro provider y verificar que no reutiliza la selección global del catálogo anterior.
