import { join } from "node:path";
import { getAppDir } from "../utils.ts";
import { readJsonFile, writeJsonFileAtomically } from "../storage.ts";
import {
  DEFAULT_SEARCH_FALLBACK_ORDER,
  SEARCH_PROVIDER_IDS,
  isSearchProviderId,
  normalizeSearchProviderOrder,
  normalizeWebSearchAuth,
  normalizeWebSearchSettings,
  resolveSearchProviderState,
} from "./search-config.ts"

import type {
  SearchProviderId,
  SearchProviderTestStatus,
  WebSearchAuth,
  WebSearchSettings,
} from "./search-config.ts"

export const SEARCH_SETTINGS_FILE_NAME = 'search.json'
export const SEARCH_AUTH_FILE_NAME = 'search-auth.json'

export function getWebSearchConfigDir(): string {
  return join(getAppDir(), "persistent");
}

export function getWebSearchSettingsPath(
  configDir = getWebSearchConfigDir(),
): string {
  return join(configDir, SEARCH_SETTINGS_FILE_NAME)
}

export function getWebSearchAuthPath(configDir = getWebSearchConfigDir()): string {
  return join(configDir, SEARCH_AUTH_FILE_NAME)
}

export function loadWebSearchSettings(
  configDir = getWebSearchConfigDir(),
): WebSearchSettings {
  try {
    const raw = readJsonFile(getWebSearchSettingsPath(configDir)) as
      Partial<WebSearchSettings> | undefined
    return normalizeWebSearchSettings(raw)
  } catch {
    return normalizeWebSearchSettings({
      version: 1,
      fallbackOrder: DEFAULT_SEARCH_FALLBACK_ORDER,
      providers: {},
    })
  }
}

export function loadWebSearchAuth(
  configDir = getWebSearchConfigDir(),
): WebSearchAuth {
  try {
    const raw = readJsonFile(getWebSearchAuthPath(configDir)) as
      Partial<WebSearchAuth> | undefined
    return normalizeWebSearchAuth(raw)
  } catch {
    return normalizeWebSearchAuth({ version: 1, apiKeys: {} })
  }
}

export function saveWebSearchSettings(
  settings: WebSearchSettings,
  configDir = getWebSearchConfigDir(),
): WebSearchSettings {
  const normalized = normalizeWebSearchSettings(settings)
  writeJsonFileAtomically(getWebSearchSettingsPath(configDir), normalized)
  return normalized
}

export function saveWebSearchAuth(
  auth: WebSearchAuth,
  configDir = getWebSearchConfigDir(),
): WebSearchAuth {
  const normalized = normalizeWebSearchAuth(auth)
  writeJsonFileAtomically(getWebSearchAuthPath(configDir), normalized)
  return normalized
}

function firstAvailableProvider(
  settings: WebSearchSettings,
  auth: WebSearchAuth,
  preferredOrder: readonly SearchProviderId[] = settings.fallbackOrder,
): SearchProviderId | undefined {
  return normalizeSearchProviderOrder(preferredOrder).find(
    (provider) => resolveSearchProviderState(provider, settings, auth).enabled,
  )
}

export function saveSearchProviderApiKey(
  provider: SearchProviderId,
  apiKey: string,
  configDir = getWebSearchConfigDir(),
): void {
  const value = apiKey.trim()
  if (!value) throw new Error('La API key no puede estar vacía.')

  const auth = loadWebSearchAuth(configDir)
  const settings = loadWebSearchSettings(configDir)
  const hadAvailableProvider = SEARCH_PROVIDER_IDS.some((candidate) => {
    const configured = Boolean(auth.apiKeys[candidate])
    const enabled = settings.providers[candidate]?.enabled !== false
    return configured && enabled
  })
  saveWebSearchAuth(
    {
      ...auth,
      apiKeys: { ...auth.apiKeys, [provider]: value },
    },
    configDir,
  )

  const nextProviderSettings = {
    ...settings.providers[provider],
    enabled: true,
  }
  const nextSettings: WebSearchSettings = {
    ...settings,
    providers: {
      ...settings.providers,
      [provider]: nextProviderSettings,
    },
  }

  if (!settings.defaultProvider || !hadAvailableProvider) {
    nextSettings.defaultProvider = provider
    nextSettings.fallbackOrder = normalizeSearchProviderOrder([
      provider,
      ...settings.fallbackOrder,
    ])
  }

  saveWebSearchSettings(nextSettings, configDir)
}

export function removeSearchProviderApiKey(
  provider: SearchProviderId,
  configDir = getWebSearchConfigDir(),
): void {
  const auth = loadWebSearchAuth(configDir)
  const apiKeys = { ...auth.apiKeys }
  delete apiKeys[provider]
  saveWebSearchAuth({ ...auth, apiKeys }, configDir)

  const settings = loadWebSearchSettings(configDir)
  const nextSettings: WebSearchSettings = {
    ...settings,
    providers: {
      ...settings.providers,
      [provider]: {
        ...settings.providers[provider],
        enabled: false,
      },
    },
  }
  if (settings.defaultProvider === provider) {
    nextSettings.defaultProvider = firstAvailableProvider(nextSettings, {
      ...auth,
      apiKeys,
    })
  }
  saveWebSearchSettings(nextSettings, configDir)
}

export function setSearchProviderEnabled(
  provider: SearchProviderId,
  enabled: boolean,
  configDir = getWebSearchConfigDir(),
): void {
  if (enabled && !loadWebSearchAuth(configDir).apiKeys[provider]) {
    throw new Error(
      `No puedes habilitar ${provider} sin configurar una API key.`,
    )
  }

  const settings = loadWebSearchSettings(configDir)
  const auth = loadWebSearchAuth(configDir)
  const nextSettings: WebSearchSettings = {
    ...settings,
    providers: {
      ...settings.providers,
      [provider]: {
        ...settings.providers[provider],
        enabled,
      },
    },
  }
  if (enabled && !settings.defaultProvider) {
    nextSettings.defaultProvider = provider
  } else if (!enabled && settings.defaultProvider === provider) {
    nextSettings.defaultProvider = firstAvailableProvider(nextSettings, auth)
  }
  saveWebSearchSettings(nextSettings, configDir)
}

export function setDefaultSearchProvider(
  provider: SearchProviderId,
  configDir = getWebSearchConfigDir(),
): void {
  const settings = loadWebSearchSettings(configDir)
  const auth = loadWebSearchAuth(configDir)
  if (
    !auth.apiKeys[provider] ||
    settings.providers[provider]?.enabled === false
  ) {
    throw new Error('El motor predeterminado debe estar configurado y activo.')
  }

  saveWebSearchSettings(
    {
      ...settings,
      defaultProvider: provider,
      fallbackOrder: normalizeSearchProviderOrder([
        provider,
        ...settings.fallbackOrder,
      ]),
    },
    configDir,
  )
}

export function setSearchFallbackOrder(
  order: SearchProviderId[],
  configDir = getWebSearchConfigDir(),
): void {
  const settings = loadWebSearchSettings(configDir)
  const auth = loadWebSearchAuth(configDir)
  const normalized = normalizeSearchProviderOrder(order)
  const defaultProvider = firstAvailableProvider(settings, auth, normalized)

  saveWebSearchSettings(
    {
      ...settings,
      defaultProvider,
      fallbackOrder: normalized,
    },
    configDir,
  )
}

export function recordSearchProviderTest(
  provider: SearchProviderId,
  result: Omit<SearchProviderTestStatus, 'testedAt'> & { testedAt?: string },
  configDir = getWebSearchConfigDir(),
): void {
  const settings = loadWebSearchSettings(configDir)
  saveWebSearchSettings(
    {
      ...settings,
      providers: {
        ...settings.providers,
        [provider]: {
          ...settings.providers[provider],
          lastTest: {
            ok: result.ok,
            message: result.message,
            testedAt: result.testedAt ?? new Date().toISOString(),
          },
        },
      },
    },
    configDir,
  )
}

export function setWebSearchSettingsFromUnknown(
  value: unknown,
  configDir = getWebSearchConfigDir(),
): WebSearchSettings {
  const candidate = value as Partial<WebSearchSettings> | undefined
  if (
    candidate?.defaultProvider !== undefined &&
    !isSearchProviderId(candidate.defaultProvider)
  ) {
    throw new Error('El motor predeterminado no es válido.')
  }
  return saveWebSearchSettings(normalizeWebSearchSettings(candidate), configDir)
}
