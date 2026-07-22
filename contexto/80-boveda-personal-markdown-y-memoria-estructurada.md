# 80 — Bóveda personal Markdown y memoria estructurada

# Fecha

2026-07-21

# Objetivo

Extender la memoria persistente de Luna para almacenar conjuntos de datos duraderos y crecientes —fechas de cumpleaños, personas, proyectos, decisiones, referencias y preferencias técnicas— sin convertir `memory.md` en un archivo monolítico ni cargar toda la información en cada conversación.

# Investigación aplicada

El diseño adopta principios documentados por Obsidian:

- las propiedades estructuradas se almacenan como YAML al inicio de cada nota;
- las notas pueden relacionarse con enlaces internos `[[...]]`;
- la búsqueda puede combinar texto, rutas, etiquetas y propiedades;
- Markdown sigue siendo la fuente de verdad legible por personas y otras herramientas.

Luna no depende de Obsidian para funcionar. La carpeta puede abrirse como vault de Obsidian, pero toda la lectura, indexación y edición ocurre localmente dentro del proyecto.

# Arquitectura

Cada usuario mantiene dos niveles separados:

```text
persistent/contexts/<jid>/
├── memory.md
└── vault/
    ├── fechas-de-cumpleanos.md
    ├── proyectos.md
    ├── personas/
    ├── .luna/
    └── .trash/
```

- `memory.md`: perfil compacto siempre disponible, limitado a nombre, forma de trato y preferencias estables.
- `vault/`: notas temáticas independientes que pueden crecer y relacionarse.
- `.luna/`: reservado para metadatos internos futuros.
- `.trash/`: papelera recuperable; eliminar una nota no la destruye inmediatamente.

# Formato de notas

Las notas contienen propiedades YAML compatibles con Obsidian:

```yaml
---
id: "mem-uuid"
title: "Fechas de cumpleaños"
type: "dates"
tags:
  - "cumpleaños"
aliases:
  - "cumples"
created: "2026-07-21T10:00:00.000Z"
updated: "2026-07-21T10:00:00.000Z"
source: "user"
---
```

El cuerpo conserva Markdown normal y wikilinks como `[[Ana Pérez]]`.

# Herramientas

- `memory_vault_list`: lista notas con filtros por carpeta, tipo o etiqueta.
- `memory_vault_search`: busca en título, alias, tags, propiedades, ruta y cuerpo.
- `memory_vault_read`: lee una nota por título, alias, slug, ruta o ID.
- `memory_vault_upsert`: crea o actualiza una nota temática sin duplicar títulos inequívocos.
- `memory_vault_edit`: reemplazo exacto con protección frente a coincidencias ambiguas.
- `memory_vault_rename`: renombra/mueve y actualiza wikilinks entrantes.
- `memory_vault_backlinks`: enumera notas que enlazan a otra.
- `memory_vault_delete`: mueve a papelera con confirmación.
- `memory_vault_restore`: lista o restaura elementos de la papelera.

# Recuperación contextual

Antes de llamar al LLM, Luna busca hasta cuatro notas relacionadas con el mensaje actual y agrega únicamente fragmentos relevantes al contexto dinámico. Esta recuperación no reemplaza las herramientas: cuando el usuario pregunta qué datos están guardados, Luna debe llamar `memory_vault_list`, `memory_vault_search` o `memory_vault_read` para verificar la fuente real.

# Búsqueda e índice

- puntuación superior para título exacto y alias;
- ponderación adicional para etiquetas, ruta, propiedades, resumen y contenido;
- normalización de mayúsculas y acentos;
- filtros por tipo, etiquetas, carpeta y propiedad;
- snippets cercanos a los términos encontrados;
- catálogo en memoria reutilizado mientras rutas, tamaños y fechas de modificación no cambien.

# Seguridad

- aislamiento por JID;
- escritura atómica y permisos restrictivos heredados del almacenamiento;
- límites de notas, tamaño individual y tamaño total;
- protección contra `../` y symlinks que salgan del vault;
- rechazo de contraseñas, tokens, API keys, OTP y propiedades con nombres de secretos;
- eliminación recuperable en lugar de borrado definitivo inmediato.

# Compatibilidad

La memoria anterior sigue funcionando sin migración obligatoria. Los datos existentes en `memory.md` se conservan. Las nuevas notas aparecen solo cuando Luna usa una herramienta `memory_vault_*`.

# Pruebas

- creación y serialización YAML;
- búsqueda de fechas por lenguaje natural;
- aislamiento entre usuarios;
- backlinks y actualización de links al renombrar;
- edición exacta;
- papelera y restauración;
- bloqueo de symlinks externos;
- rechazo de secretos;
- recuperación contextual selectiva;
- ejecución completa mediante function tools.
