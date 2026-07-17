export const SEARCH_PROVIDER_IDS = [
  'tavily',
  'brave',
  'exa',
  'linkup',
  'firecrawl',
  'serpapi',
  'zenserp',
] as const

export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number]

export interface SearchProviderTestStatus {
  ok: boolean
  message: string
  testedAt: string
}

export interface SearchProviderSettings {
  enabled?: boolean
  lastTest?: SearchProviderTestStatus
}

export interface WebSearchSettings {
  version: 1
  defaultProvider?: SearchProviderId
  fallbackOrder: SearchProviderId[]
  providers: Partial<Record<SearchProviderId, SearchProviderSettings>>
}

export interface WebSearchAuth {
  version: 1
  apiKeys: Partial<Record<SearchProviderId, string>>
}

export interface ResolvedSearchProviderState {
  apiKey?: string
  configured: boolean
  enabled: boolean
  disabledReason?: 'disabled-by-user' | 'missing-credential'
  lastTest?: SearchProviderTestStatus
}

export const SEARCH_PROVIDER_LABELS: Record<SearchProviderId, string> = {
  tavily: 'Tavily',
  brave: 'Brave Search',
  exa: 'Exa',
  linkup: 'Linkup',
  firecrawl: 'Firecrawl',
  serpapi: 'SerpApi',
  zenserp: 'Zenserp',
}

export const DEFAULT_SEARCH_FALLBACK_ORDER: SearchProviderId[] = [
  'tavily',
  'brave',
  'exa',
  'linkup',
  'firecrawl',
  'serpapi',
  'zenserp',
]

export function isSearchProviderId(value: unknown): value is SearchProviderId {
  return (
    typeof value === 'string' &&
    SEARCH_PROVIDER_IDS.includes(value as SearchProviderId)
  )
}

export function normalizeSearchProviderOrder(
  values: readonly unknown[] | undefined,
): SearchProviderId[] {
  const normalized: SearchProviderId[] = []

  for (const value of values ?? []) {
    if (!isSearchProviderId(value) || normalized.includes(value)) continue
    normalized.push(value)
  }

  for (const provider of DEFAULT_SEARCH_FALLBACK_ORDER) {
    if (!normalized.includes(provider)) normalized.push(provider)
  }

  return normalized
}

export function normalizeWebSearchSettings(
  settings: Partial<WebSearchSettings> | undefined,
): WebSearchSettings {
  const providers: Partial<Record<SearchProviderId, SearchProviderSettings>> =
    {}

  for (const provider of SEARCH_PROVIDER_IDS) {
    const raw = settings?.providers?.[provider]
    if (!raw) continue

    const normalized: SearchProviderSettings = {}
    if (typeof raw.enabled === 'boolean') normalized.enabled = raw.enabled
    if (
      raw.lastTest &&
      typeof raw.lastTest.ok === 'boolean' &&
      typeof raw.lastTest.message === 'string' &&
      typeof raw.lastTest.testedAt === 'string'
    ) {
      normalized.lastTest = raw.lastTest
    }

    if (normalized.enabled !== undefined || normalized.lastTest) {
      providers[provider] = normalized
    }
  }

  return {
    version: 1,
    defaultProvider: isSearchProviderId(settings?.defaultProvider)
      ? settings.defaultProvider
      : undefined,
    fallbackOrder: normalizeSearchProviderOrder(settings?.fallbackOrder),
    providers,
  }
}

export function normalizeWebSearchAuth(
  auth: Partial<WebSearchAuth> | undefined,
): WebSearchAuth {
  const apiKeys: Partial<Record<SearchProviderId, string>> = {}

  for (const provider of SEARCH_PROVIDER_IDS) {
    const value = auth?.apiKeys?.[provider]?.trim()
    if (value) apiKeys[provider] = value
  }

  return { version: 1, apiKeys }
}

export function resolveSearchProviderState(
  provider: SearchProviderId,
  settings: WebSearchSettings,
  auth: WebSearchAuth,
): ResolvedSearchProviderState {
  const providerSettings = settings.providers[provider]
  const apiKey = auth.apiKeys[provider]?.trim()
  const configured = Boolean(apiKey)

  if (providerSettings?.enabled === false) {
    return {
      apiKey,
      configured,
      enabled: false,
      disabledReason: 'disabled-by-user',
      lastTest: providerSettings.lastTest,
    }
  }

  if (!apiKey) {
    return {
      configured: false,
      enabled: false,
      disabledReason: 'missing-credential',
      lastTest: providerSettings?.lastTest,
    }
  }

  return {
    apiKey,
    configured: true,
    enabled: true,
    lastTest: providerSettings?.lastTest,
  }
}

export function getSearchProviderOrder(
  settings: WebSearchSettings,
  auth: WebSearchAuth,
): SearchProviderId[] {
  const configuredOrder = normalizeSearchProviderOrder([
    settings.defaultProvider,
    ...settings.fallbackOrder,
  ])

  return configuredOrder.filter(
    (provider) => resolveSearchProviderState(provider, settings, auth).enabled,
  )
}

export function hasAvailableSearchProvider(
  settings: WebSearchSettings,
  auth: WebSearchAuth,
): boolean {
  return getSearchProviderOrder(settings, auth).length > 0
}

export function maskSearchApiKey(apiKey: string | undefined): string {
  const value = apiKey?.trim()
  if (!value) return 'sin configurar'
  if (value.length <= 8) {
    return `${value.slice(0, 2)}••••${value.slice(-2)}`
  }
  return `${value.slice(0, 4)}••••••${value.slice(-4)}`
}
