import { ModuleRegistry } from "./registry.ts";
import { CORE_MODULE } from "./core/module.ts";
import { CONTEXT_MODULE } from "./context/module.ts";
import { MEMORY_MODULE } from "./memory/module.ts";
import { AUTOMATION_MODULE } from "./automation/module.ts";
import { WORKSPACE_MODULE } from "./workspace/module.ts";
import { ARTIFACTS_MODULE } from "./artifacts/module.ts";
import { PROVIDER_MODULE } from "./provider/module.ts";
import { SEARCH_MODULE } from "./search/module.ts";
import { BROWSER_MODULE } from "./browser/module.ts";
import { AGENTS_MODULE } from "./agents/module.ts";
import { WHISPER_MODULE } from "./whisper/module.ts";
import { ADMIN_MODULE } from "./admin/module.ts";
import { GOALS_MODULE } from "./goals/module.ts";
import { PROCESSES_MODULE } from "./processes/module.ts";
import { SKILLS_MODULE } from "./skills/module.ts";
import { TTS_MODULE } from "./tts/module.ts";

export const moduleRegistry = new ModuleRegistry();
for (const module of [
  CORE_MODULE, CONTEXT_MODULE, MEMORY_MODULE, AUTOMATION_MODULE, WORKSPACE_MODULE, ARTIFACTS_MODULE,
  PROVIDER_MODULE, SEARCH_MODULE, BROWSER_MODULE, AGENTS_MODULE, GOALS_MODULE, PROCESSES_MODULE, SKILLS_MODULE, TTS_MODULE, WHISPER_MODULE, ADMIN_MODULE,
]) moduleRegistry.register(module);
