# 68 — Auditoría, saneamiento y seguridad

# Fecha

2026-07-19

# Objetivo

Auditar el proyecto completo antes de continuar con nuevas funciones, limpiar documentación contradictoria o duplicada y aplicar correcciones conservadoras de seguridad y persistencia sin alterar la arquitectura funcional existente.

# Hallazgos

1. `contexto/` tenía dos archivos maestros completos y el maestro automático apuntaba a `069-actualizar-nul.md`, un registro sin valor técnico.
2. Existían registros de contexto exactamente duplicados y una segunda secuencia automática `064–069` con títulos genéricos, números repetidos y referencias como `nul` o `nodejs.zip`.
3. `informe.md` describía arreglos ARM64 temporales —Trixie y `chown /data`— que contradicen el estado final vigente: Bookworm, libgomp portable y HOME/XDG bajo `persistent/`.
4. Los contextos 47–52 tenían el título malformado como `# NN — Fecha` y el registro 63 no seguía el formato reciente.
5. `WorkspaceManager.resolvePath()` comprobaba symlinks solo cuando el destino final ya existía. Una escritura a un archivo nuevo bajo un directorio simbólico externo podía atravesar ese padre y salir del workdir.
6. El archivo de perfiles cifrados del navegador se escribía directamente y podía quedar truncado ante una interrupción durante la escritura.
7. La clave de cifrado del navegador se administraba con lógica duplicada. Si el archivo de clave existía pero era inválido, una parte del sistema podía regenerarlo silenciosamente, dejando indescifrables perfiles creados con la clave anterior.
8. README contenía referencias a scripts de limpieza inexistentes y numeración duplicada en las pruebas manuales.

# Cambios implementados

## Aislamiento del workdir

- `resolvePath()` ahora obtiene el ancestro existente más cercano del destino y valida su `realpath` contra el `realpath` del workdir.
- Se bloquea la creación de archivos nuevos cuando cualquier padre resoluble conduce fuera del workdir mediante symlink/junction.
- La validación existente para destinos ya creados se conserva.
- Se agregó una prueba de regresión que intenta escribir `escape-dir/nuevo.txt` a través de un symlink/junction externo y verifica que el archivo no se cree.

## Cifrado y credenciales del navegador

- Se creó `src/browser/browser-encryption.ts` como única implementación para leer o crear `persistent/browser/encryption.key`.
- La clave debe ser exactamente AES-256 en hexadecimal de 64 caracteres.
- Una clave existente corrupta produce un error explícito y nunca se reemplaza automáticamente.
- La creación usa `flag: wx` para evitar sobrescrituras accidentales ante carreras entre procesos.
- `browser-runtime.ts` y `BrowserCredentialStore` usan la misma rutina.
- `credential-profiles.json` ahora usa escritura atómica mediante `writeJsonFileAtomically()`.
- Se agregó una prueba que comprueba que una clave corrupta permanece intacta y no se sustituye silenciosamente.

## Saneamiento de contexto y documentación

- `000-contexto-maestro.md` se convirtió en el maestro canónico real con arquitectura, invariantes y estado vigente.
- `01-contexto-maestro.md` quedó como puntero de compatibilidad para no romper referencias históricas.
- Se corrigieron títulos de los registros 47–52 y el formato del registro 63.
- Se eliminaron duplicados exactos o sustanciales: 19, 20, 25 y 26.
- Se eliminaron los registros automáticos espurios 064–069.
- Se eliminó `informe.md` por estar obsoleto y contradecir el arreglo final documentado en el registro 66.
- Se agregó `scripts/remove-context-noise.py` para reproducir esas eliminaciones de forma segura en Windows, Linux o macOS, con modo `--dry-run`.
- README fue alineado con los scripts que realmente existen y con las protecciones nuevas.

# Archivos principales modificados

- `src/workspace/workspace-manager.ts`
- `src/browser/browser-encryption.ts`
- `src/browser/browser-credentials.ts`
- `src/browser/browser-runtime.ts`
- `__tests__/workspace-agentic.test.ts`
- `__tests__/browser-credentials.test.ts`
- `README.md`
- `contexto/000-contexto-maestro.md`
- `contexto/01-contexto-maestro.md`
- `contexto/47-procesamiento-multimedia-local.md`
- `contexto/48-configuracion-global-whisper.md`
- `contexto/49-corregir-bibliotecas-whisper-linux.md`
- `contexto/50-corregir-tipos-streams-y-tests-ci.md`
- `contexto/51-incluir-libgomp-runtime-linux.md`
- `contexto/52-descargar-libgomp-portable-debian.md`
- `contexto/63-captura-inline-de-credenciales-y-cambio-de-password.md`
- `scripts/remove-context-noise.py`

# Archivos eliminados

- `contexto/19-actualizar-logica-del-bot.md`
- `contexto/20-personalidad-luna-y-memoria-persistente.md`
- `contexto/25-implementar-el-cambio-necesario-para-actualizar-impl.md`
- `contexto/26-recordatorios-listar-editar-eliminar-y-feedback-whatsapp.md`
- `contexto/064-actualizar-nul.md`
- `contexto/065-actualizar-dockerfile.md`
- `contexto/066-actualizar-implementacion-del-proyecto.md`
- `contexto/066-implementar-el-cambio-necesario-para-actualizar-impl.md`
- `contexto/067-implementar-el-cambio-necesario-para-actualizar-impl.md`
- `contexto/068-actualizar-informe-md.md`
- `contexto/069-actualizar-nul.md`
- `informe.md`

# Validación realizada

- Se descomprimió y revisó la estructura completa del proyecto.
- Se comprobó el grafo de imports relativos de `src/`; no se detectaron módulos `.ts` huérfanos aparte de declaraciones `.d.ts` esperadas.
- Se analizaron sintácticamente todos los TypeScript de `src/`, `scripts/` y `__tests__` con el parser de TypeScript: sin errores de sintaxis.
- Se verificó que todas las dependencias declaradas tengan uso directo o durante preparación de assets.
- `scripts/remove-context-noise.py --dry-run` se ejecutó correctamente antes de aplicar la limpieza.

No fue posible ejecutar `bun test`, `bun run typecheck` ni `bun run build` en este entorno porque el ZIP no incluye `node_modules` y Bun 1.3.14 no está instalado. El intento de obtener Bun mediante `npx` no completó dentro del límite disponible. Estas tres validaciones siguen siendo obligatorias antes de considerar el cambio listo para producción.

# Pruebas recomendadas

1. `bun install --frozen-lockfile`
2. `bun run typecheck`
3. `bun test`
4. `bun run build`
5. Probar escritura normal dentro de `workdir/exports`.
6. Probar `gitzip` y creación de PDF para confirmar que las nuevas validaciones de rutas no bloquean rutas legítimas.
7. Reiniciar Luna con credenciales web existentes y confirmar que se descifran con la misma `encryption.key`.
8. Corromper una copia de prueba de `encryption.key` y confirmar que Luna informa el error sin reemplazarla.
