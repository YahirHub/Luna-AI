import type { LunaModule } from "../types.ts";
export const PROVIDER_MODULE: LunaModule = {
  id: "provider", name: "Modelos y proveedor", description: "Modelo global y proveedor LLM", category: "llm",
  access: "authenticated", scope: "global",
  commands: [
    { name: "modelos", description: "Lista modelos y permite seleccionar uno" },
    { name: "setup-provider", description: "Configura o reemplaza el proveedor LLM", access: "admin" },
  ],
  tools: [
    { name: "model_status" }, { name: "model_list" }, { name: "model_set" },
    { name: "llm_provider_status", access: "admin" }, { name: "llm_provider_use_opencode_free", access: "admin" }, { name: "llm_provider_start_setup", access: "admin" },
  ],
  prompt: { summary: "Consulta/cambia el modelo global y, para admins, configura el provider OpenAI-compatible.", keywords: ["modelo", "provider", "proveedor", "openai compatible"], instructions: [
    "Para cambiar de modelo usa model_list cuando sea necesario y model_set para persistir la selección global.",
    "Las API keys de providers se capturan en flujos seguros; nunca las solicites como argumento de una tool.",
  ] },
};
