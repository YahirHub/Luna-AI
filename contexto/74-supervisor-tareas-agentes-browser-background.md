# 74 — Supervisor de tareas y agentes en segundo plano

Cada tarea/agente tiene ID, nombre, estado de ejecución y revisión pending/reviewed. browser-agent corre en background, permite conversar, listar, revisar y cancelar agentes/tareas sin abortar la conversación. Los procesos agent-browser están aislados por ejecución y se cierran al terminar/cancelar.
