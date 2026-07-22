# 81 — Arquitectura modular de capacidades

# Fecha

2026-07-22

# Objetivo

Hacer escalable la administración de comandos, tools, agentes, prompts y contexto de Luna mediante módulos funcionales declarativos.

# Regla de autenticación

La autenticación es una frontera previa al registro modular. Antes del login no se exponen módulos, comandos normales, tools, agentes ni contexto modular. `!setup` y `!login` son únicamente operaciones de bootstrap necesarias para crear/autenticar una cuenta y no forman parte de la superficie normal del agente.

Después del login existen dos niveles:

- `authenticated`: disponible para usuarios y administradores.
- `admin`: disponible únicamente para administradores.

# Registro modular

`src/modules/registry.ts` centraliza:

- módulos disponibles por sesión;
- comandos y ayuda;
- aliases y permisos;
- filtrado de tools;
- resumen de capacidades;
- selección de prompts por mensaje;
- contexto dinámico de módulos activos.

Una tool no declarada explícitamente por un módulo se rechaza por defecto.

# Módulos iniciales

- core
- context
- memory
- automation
- workspace
- artifacts
- provider
- search
- browser
- agents
- whisper
- admin

# Prompt

El system prompt estático queda limitado a personalidad, seguridad, veracidad, transcripciones, orquestación y formato. Los detalles específicos de memoria, search, browser, agentes, Whisper, administración, etc. se inyectan desde su módulo únicamente cuando son relevantes.

Todos los módulos autorizados aportan un resumen corto para descubrimiento de capacidades. Solo los módulos activados por la petición añaden instrucciones detalladas y, cuando existe, contexto dinámico seguro.

# Ayuda

`!ayuda` se genera desde el registro modular y respeta el rol. `!ayuda <modulo>` muestra una capacidad concreta. Los módulos sin comandos directos se muestran como utilizables mediante lenguaje natural.

# Compatibilidad

Los ejecutores existentes permanecen como fuente de verdad operacional. Esta migración desacopla la superficie declarativa y de permisos sin cambiar formatos persistentes ni rutas de datos del usuario.
