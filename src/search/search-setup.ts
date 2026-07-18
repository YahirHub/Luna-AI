import {
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDER_LABELS,
  maskSearchApiKey,
  normalizeSearchProviderOrder,
  resolveSearchProviderState,
  type SearchProviderId,
} from "./search-config.ts";
import {
  getWebSearchConfigDir,
  loadWebSearchAuth,
  loadWebSearchSettings,
  recordSearchProviderTest,
  removeSearchProviderApiKey,
  saveSearchProviderApiKey,
  setDefaultSearchProvider,
  setSearchFallbackOrder,
  setSearchProviderEnabled,
} from "./search-storage.ts";
import { testSearchProvider } from "./search-runtime.ts";
import { extractSecretTokenFromMessage } from "../utils.ts";

type SearchSetupState =
  | { stage: "main" }
  | { stage: "provider"; provider: SearchProviderId }
  | { stage: "api-key"; provider: SearchProviderId; returnToMenu: boolean }
  | { stage: "fallback-order" };

export interface SearchSetupResult {
  text: string;
  done: boolean;
  secretInput?: boolean;
}

function providerFromNumber(input: string): SearchProviderId | undefined {
  const index = Number.parseInt(input.trim(), 10) - 1;
  return SEARCH_PROVIDER_IDS[index];
}

export class SearchSetupManager {
  private states = new Map<string, SearchSetupState>();

  constructor(private readonly configDir = getWebSearchConfigDir()) {}

  has(jid: string): boolean {
    return this.states.has(jid);
  }

  start(jid: string): string {
    this.states.set(jid, { stage: "main" });
    return this.renderMainMenu();
  }

  /** Inicia directamente el paso seguro de captura de API key para un motor. */
  startApiKey(jid: string, provider: SearchProviderId): string {
    this.states.set(jid, { stage: "api-key", provider, returnToMenu: false });
    return [
      `🔑 API KEY DE ${SEARCH_PROVIDER_LABELS[provider].toUpperCase()}`,
      "",
      "Envía la clave en tu siguiente mensaje. Luna intentará borrar ese mensaje después de guardarla.",
      "Usa /cancelar o di 'cancelar' para salir sin modificarla.",
    ].join("\n");
  }

  cancel(jid: string): void {
    this.states.delete(jid);
  }

  private renderMainMenu(): string {
    const settings = loadWebSearchSettings(this.configDir);
    const auth = loadWebSearchAuth(this.configDir);
    const rows = SEARCH_PROVIDER_IDS.map((provider, index) => {
      const state = resolveSearchProviderState(provider, settings, auth);
      const status = state.enabled
        ? "ACTIVO"
        : state.configured
          ? "DESACTIVADO"
          : "SIN CLAVE";
      const defaultMark = settings.defaultProvider === provider ? " · PREDETERMINADO" : "";
      return `${index + 1}. ${SEARCH_PROVIDER_LABELS[provider]} — ${status}${defaultMark}`;
    });

    const fallback = settings.fallbackOrder
      .map((provider) => SEARCH_PROVIDER_LABELS[provider])
      .join(" → ");

    return [
      "🔎 CONFIGURAR BÚSQUEDA WEB",
      "",
      ...rows,
      "",
      `8. Orden de respaldo: ${fallback}`,
      "9. Probar todos los motores activos",
      "0. Guardar y salir",
      "",
      "Envía el número de una opción. Usa /cancelar para cerrar el flujo.",
    ].join("\n");
  }

  private renderProviderMenu(provider: SearchProviderId): string {
    const settings = loadWebSearchSettings(this.configDir);
    const auth = loadWebSearchAuth(this.configDir);
    const state = resolveSearchProviderState(provider, settings, auth);
    return [
      `🔍 ${SEARCH_PROVIDER_LABELS[provider]}`,
      "",
      `Estado: ${state.enabled ? "ACTIVO" : state.configured ? "DESACTIVADO" : "SIN CLAVE"}`,
      `API key: ${maskSearchApiKey(state.apiKey)}`,
      `Predeterminado: ${settings.defaultProvider === provider ? "sí" : "no"}`,
      state.lastTest
        ? `Última prueba: ${state.lastTest.ok ? "correcta" : "fallida"} · ${state.lastTest.message}`
        : "Última prueba: sin ejecutar",
      "",
      "1. Configurar o reemplazar API key",
      `2. ${state.enabled ? "Desactivar" : "Activar"}`,
      "3. Usar como predeterminado",
      "4. Probar conexión",
      "5. Eliminar API key",
      "0. Volver",
    ].join("\n");
  }

  private async testOne(provider: SearchProviderId): Promise<string> {
    const result = await testSearchProvider(provider, {
      settings: loadWebSearchSettings(this.configDir),
      auth: loadWebSearchAuth(this.configDir),
    });
    recordSearchProviderTest(provider, result, this.configDir);
    return `${result.ok ? "✅" : "❌"} ${SEARCH_PROVIDER_LABELS[provider]}: ${result.message}`;
  }

  private async testAll(): Promise<string> {
    const settings = loadWebSearchSettings(this.configDir);
    const auth = loadWebSearchAuth(this.configDir);
    const active = SEARCH_PROVIDER_IDS.filter(
      (provider) => resolveSearchProviderState(provider, settings, auth).enabled,
    );
    if (active.length === 0) {
      return "⚠️ No hay motores activos con API key.";
    }

    const rows: string[] = [];
    for (const provider of active) {
      rows.push(await this.testOne(provider));
    }
    return ["🧪 RESULTADO DE PRUEBAS", "", ...rows].join("\n");
  }

  async submit(jid: string, input: string): Promise<SearchSetupResult> {
    const state = this.states.get(jid);
    if (!state) throw new Error("No existe una configuración de búsqueda activa.");
    const value = input.trim();

    if (state.stage === "api-key") {
      const apiKey = extractSecretTokenFromMessage(value);
      if (!apiKey) {
        return {
          done: false,
          text: "❌ No pude detectar una API key válida. Envíala de nuevo o di 'cancelar'.",
        };
      }
      saveSearchProviderApiKey(state.provider, apiKey, this.configDir);

      // Cuando la captura fue iniciada desde lenguaje natural, es una acción
      // de una sola vez: al guardar la clave se cierra el estado interactivo
      // para que el siguiente mensaje vuelva al agente principal. El menú
      // numérico tradicional conserva su comportamiento y regresa al motor.
      if (!state.returnToMenu) {
        this.cancel(jid);
        return {
          done: true,
          secretInput: true,
          text: `✅ API key guardada y ${SEARCH_PROVIDER_LABELS[state.provider]} activado.`,
        };
      }

      this.states.set(jid, { stage: "provider", provider: state.provider });
      return {
        done: false,
        secretInput: true,
        text: `✅ API key guardada y motor activado.\n\n${this.renderProviderMenu(state.provider)}`,
      };
    }

    if (state.stage === "fallback-order") {
      const selected = value
        .split(/[\s,>;-]+/)
        .map(providerFromNumber)
        .filter((provider): provider is SearchProviderId => Boolean(provider));
      if (selected.length === 0) {
        return {
          done: false,
          text: "❌ Envía números válidos separados por comas. Ejemplo: 2,1,3,4,5,6,7",
        };
      }
      setSearchFallbackOrder(normalizeSearchProviderOrder(selected), this.configDir);
      this.states.set(jid, { stage: "main" });
      return { done: false, text: `✅ Orden actualizado.\n\n${this.renderMainMenu()}` };
    }

    if (state.stage === "main") {
      if (value === "0") {
        this.cancel(jid);
        return { done: true, text: "✅ Configuración de búsqueda guardada." };
      }
      if (value === "8") {
        this.states.set(jid, { stage: "fallback-order" });
        return {
          done: false,
          text: [
            "🔁 ORDEN DE RESPALDO",
            "",
            ...SEARCH_PROVIDER_IDS.map(
              (provider, index) => `${index + 1}. ${SEARCH_PROVIDER_LABELS[provider]}`,
            ),
            "",
            "Envía los números en el orden deseado, separados por comas.",
            "Ejemplo: 2,1,3,4,5,6,7",
          ].join("\n"),
        };
      }
      if (value === "9") {
        return {
          done: false,
          text: `${await this.testAll()}\n\n${this.renderMainMenu()}`,
        };
      }
      const provider = providerFromNumber(value);
      if (!provider) {
        return { done: false, text: `❌ Opción inválida.\n\n${this.renderMainMenu()}` };
      }
      this.states.set(jid, { stage: "provider", provider });
      return { done: false, text: this.renderProviderMenu(provider) };
    }

    if (value === "0") {
      this.states.set(jid, { stage: "main" });
      return { done: false, text: this.renderMainMenu() };
    }

    switch (value) {
      case "1":
        this.states.set(jid, { stage: "api-key", provider: state.provider, returnToMenu: true });
        return {
          done: false,
          text: [
            `🔑 API KEY DE ${SEARCH_PROVIDER_LABELS[state.provider].toUpperCase()}`,
            "",
            "Envía la clave. Luna intentará borrar el mensaje después de guardarla.",
            "Usa /cancelar para salir sin modificarla.",
          ].join("\n"),
        };
      case "2": {
        const settings = loadWebSearchSettings(this.configDir);
        const auth = loadWebSearchAuth(this.configDir);
        const current = resolveSearchProviderState(state.provider, settings, auth);
        setSearchProviderEnabled(state.provider, !current.enabled, this.configDir);
        return {
          done: false,
          text: `✅ Estado actualizado.\n\n${this.renderProviderMenu(state.provider)}`,
        };
      }
      case "3":
        setDefaultSearchProvider(state.provider, this.configDir);
        return {
          done: false,
          text: `✅ Motor predeterminado actualizado.\n\n${this.renderProviderMenu(state.provider)}`,
        };
      case "4":
        return {
          done: false,
          text: `${await this.testOne(state.provider)}\n\n${this.renderProviderMenu(state.provider)}`,
        };
      case "5":
        removeSearchProviderApiKey(state.provider, this.configDir);
        return {
          done: false,
          text: `✅ API key eliminada.\n\n${this.renderProviderMenu(state.provider)}`,
        };
      default:
        return {
          done: false,
          text: `❌ Opción inválida.\n\n${this.renderProviderMenu(state.provider)}`,
        };
    }
  }
}
