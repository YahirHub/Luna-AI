# Skills globales de Luna

Coloca aquí skills compatibles con Claude/Agent Skills durante el desarrollo.
Cada skill debe vivir en su propia carpeta y contener `SKILL.md`.

Al iniciar Luna, las skills incluidas con el release se copian de forma aditiva a
`persistent/skills/`. Los archivos ya existentes en `persistent/skills/` no se
sobrescriben, de modo que las skills instaladas o personalizadas persisten entre
actualizaciones y reinicios.

Ejemplo:

```text
assets/skills/
└── mi-skill/
    ├── SKILL.md
    ├── reference.md
    └── scripts/
        └── helper.py
```
