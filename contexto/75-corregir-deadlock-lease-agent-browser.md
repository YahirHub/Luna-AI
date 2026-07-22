# 75 — Corregir deadlock de agent-browser

Se corrigió la cancelación de un agente que esperaba recursos del navegador. La espera es cancelable y no puede retener un lease después de finalizar. Los perfiles/runtime están aislados por ejecución y la persistencia se fusiona bajo un lease breve al guardar.
