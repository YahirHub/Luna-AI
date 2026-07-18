import type { SearchResultItem } from "../search/search-runtime.ts";

export interface PricingEvidenceSource {
  url: string;
  title?: string;
  snippet?: string;
  content?: string;
}

export interface PricingFact {
  model: string;
  inputUsdPerMillion: string | null;
  cachedInputUsdPerMillion: string | null;
  outputUsdPerMillion: string | null;
  contextWindow: string | null;
  conditions: string | null;
  sourceUrls: string[];
}

export interface PricingResearchData {
  provider: string;
  items: PricingFact[];
  notes: string[];
  sources: string[];
}

interface ProviderPricingProfile {
  id: string;
  aliases: RegExp;
  modelPattern: RegExp;
  officialDomains: string[];
  candidateUrls: string[];
  querySuffix: string;
}

const PROVIDER_PROFILES: ProviderPricingProfile[] = [
  {
    id: "OpenAI",
    aliases: /\b(openai|gpt(?:[-\s]?\d|\b))\b/i,
    modelPattern: /\b(?:gpt(?:-[a-z0-9.]+)+(?:\s+(?:sol|terra|luna|pro|mini|nano|instant))?|o\d(?:-[a-z0-9.]+)*|chatgpt-[a-z0-9._-]+)\b/i,
    officialDomains: ["openai.com", "developers.openai.com", "platform.openai.com"],
    candidateUrls: [
      "https://developers.openai.com/api/docs/pricing",
      "https://openai.com/api/pricing/",
    ],
    querySuffix: "site:developers.openai.com OR site:openai.com API pricing input output per 1M tokens",
  },
  {
    id: "Anthropic",
    aliases: /\b(anthropic|claude)\b/i,
    modelPattern: /\bClaude\s+(?:Opus|Sonnet|Haiku|Fable|Mythos)(?:\s+\d+(?:\.\d+)?){0,2}\b/i,
    officialDomains: ["anthropic.com", "claude.com", "platform.claude.com", "docs.anthropic.com"],
    candidateUrls: [
      "https://platform.claude.com/docs/en/about-claude/pricing",
      "https://www.anthropic.com/pricing",
    ],
    querySuffix: "site:platform.claude.com OR site:anthropic.com Claude API pricing input output per 1M tokens",
  },
  {
    id: "DeepSeek",
    aliases: /\bdeepseek\b/i,
    modelPattern: /\bdeepseek(?:-[a-z0-9._]+)+\b/i,
    officialDomains: ["deepseek.com", "api-docs.deepseek.com", "platform.deepseek.com"],
    candidateUrls: [
      "https://api-docs.deepseek.com/quick_start/pricing-details-usd",
      "https://api-docs.deepseek.com/quick_start/pricing",
    ],
    querySuffix: "site:api-docs.deepseek.com models pricing input output cache USD per 1M tokens",
  },
  {
    id: "MiniMax",
    aliases: /\b(minimax|hailuo)\b/i,
    modelPattern: /\bMiniMax(?:-[a-z0-9.]+)+(?:\s*[≤<>]=?\s*\d+k(?:\s+input\s+tokens?)?)?\b/i,
    officialDomains: ["minimax.io", "minimax.com", "minimax.chat", "platform.minimax.io", "api.minimax.chat"],
    candidateUrls: [
      "https://platform.minimax.io/docs/guides/pricing-paygo",
      "https://platform.minimax.io/docs/pricing/overview",
    ],
    querySuffix: "site:platform.minimax.io MiniMax text model API pricing input output tokens pay as you go",
  },
];

const PRICE_KEYWORDS = /\b(price|pricing|cost|input|output|cache|cached|prompt|completion|entrada|salida|precio|costo|tokens?|mtok|million|mill[oó]n)\b/i;
const MONEY_PATTERN = /(?:US\$|USD\s*|\$)\s*(\d+(?:[.,]\d+)?)/i;

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizedKey(value: string): string {
  return stripAccents(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}


function normalizedConditionKey(value: string): string {
  return normalizedKey(value
    .replace(/≤|<=/g, " le ")
    .replace(/≥|>=/g, " ge ")
    .replace(/</g, " lt ")
    .replace(/>/g, " gt ")
    .replace(/=/g, " eq "));
}

function cleanText(value: string): string {
  return value
    .replace(/\\u0024/gi, "$")
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\u002f/gi, "/")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#36;/gi, "$")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hostMatches(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export function getPricingProfile(subject: string): ProviderPricingProfile | undefined {
  return PROVIDER_PROFILES.find((profile) => profile.aliases.test(subject));
}

export function getPricingCandidateUrls(subject: string): string[] {
  return [...(getPricingProfile(subject)?.candidateUrls ?? [])];
}

export function buildPricingRecoveryQuery(subject: string, originalQuery: string): string {
  const profile = getPricingProfile(subject);
  const asksForSpecificModel = profile?.modelPattern.test(subject) ?? false;
  return [
    subject,
    asksForSpecificModel ? "official API pricing for this model" : "current active API models official pricing",
    "input output cache USD per 1M tokens",
    profile?.querySuffix,
    asksForSpecificModel ? originalQuery : undefined,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isOfficialPricingUrl(subject: string, url: string): boolean {
  const profile = getPricingProfile(subject);
  if (profile) return profile.officialDomains.some((domain) => hostMatches(url, domain));
  const tokens = normalizedKey(subject).split(" ").filter((token) => token.length >= 4);
  try {
    const host = new URL(url).hostname.toLowerCase();
    return tokens.some((token) => host.includes(token));
  } catch {
    return false;
  }
}

export function isTrustedPricingSourceUrl(subject: string, url: string): boolean {
  const profile = getPricingProfile(subject);
  if (!profile) return true;
  if (!profile.officialDomains.some((domain) => hostMatches(url, domain))) return false;
  try {
    const normalized = new URL(url);
    const canonical = profile.candidateUrls.some((candidate) => {
      const parsed = new URL(candidate);
      return normalized.hostname.toLowerCase() === parsed.hostname.toLowerCase() &&
        normalized.pathname.replace(/\/$/, "") === parsed.pathname.replace(/\/$/, "");
    });
    if (canonical) return true;
    return /(?:^|\/)(?:pricing|prices|billing|costs?)(?:\/|$|-)/i.test(normalized.pathname);
  } catch {
    return false;
  }
}

function parseNumber(value: string): number | null {
  const normalized = value.replace(/,/g, "").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value: number): string {
  const trimmed = value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  const [integer = "0", decimal = ""] = trimmed.split(".");
  return `${integer}.${decimal.padEnd(2, "0")}`;
}

function unitMultiplier(text: string): number | null {
  const normalized = stripAccents(text).toLowerCase();
  if (/\b(per|por)?\s*(1\s*m|1m|million|millon|mtok|m tokens?|million tokens?)\b/.test(normalized) || /\/\s*1m\b/.test(normalized)) return 1;
  if (/\b(per|por)?\s*(1\s*k|1k|thousand|mil|k tokens?)\b/.test(normalized) || /\/\s*1k\b/.test(normalized)) return 1_000;
  if (/\bper\s+token\b|\bpor\s+token\b/.test(normalized)) return 1_000_000;
  return null;
}

function withoutStruckPrices(value: string): string {
  return value.replace(/~~[\s\S]*?~~/g, " ");
}

function normalizePrice(value: string, context: string, unitHint = ""): string | null {
  const preferredValue = withoutStruckPrices(value);
  const preferredContext = withoutStruckPrices(context);
  const match = MONEY_PATTERN.exec(preferredValue) ?? MONEY_PATTERN.exec(preferredContext) ?? MONEY_PATTERN.exec(value) ?? MONEY_PATTERN.exec(context);
  if (!match?.[1]) return null;
  const number = parseNumber(match[1]);
  if (number === null) return null;
  const multiplier = unitMultiplier(`${value} ${context} ${unitHint}`);
  if (multiplier === null) return null;
  return formatNumber(number * multiplier);
}

function splitMarkdownRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map((cell) => cleanText(cell));
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function headerIndex(headers: string[], patterns: RegExp[]): number {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(normalizedKey(header))));
}

function modelFromCell(value: string): string | null {
  const clean = cleanText(value).replace(/^\*\*|\*\*$/g, "").replace(/^`|`$/g, "").trim();
  if (!clean || /^[-–—]|^(model|modelo|api)$/i.test(clean)) return null;
  return clean.slice(0, 160);
}

function extractMarkdownTables(text: string, sourceUrl: string): PricingFact[] {
  const lines = cleanText(text).split("\n");
  const facts: PricingFact[] = [];
  for (let index = 0; index < lines.length - 2; index += 1) {
    const headerLine = lines[index] ?? "";
    const separatorLine = lines[index + 1] ?? "";
    if (!headerLine.includes("|") || !separatorLine.includes("|")) continue;
    const headers = splitMarkdownRow(headerLine);
    const separators = splitMarkdownRow(separatorLine);
    if (headers.length < 2 || headers.length !== separators.length || !isSeparatorRow(separators)) continue;

    const modelIndex = headerIndex(headers, [/^model$/, /^modelo$/, /model name/, /api model/]);
    const cacheIndex = headerIndex(headers, [/cached input/, /cache hit/, /^cache$/, /cach[eé]/]);
    const inputIndex = headers.findIndex((header) => {
      const normalized = normalizedKey(header);
      return /\b(input|entrada|prompt)\b/.test(normalized) && !/cached|cache hit/.test(normalized);
    });
    const outputIndex = headerIndex(headers, [/\boutput\b/, /salida/, /completion/]);
    const contextIndex = headerIndex(headers, [/context/, /ventana/, /tokens max/, /max tokens/]);
    if (modelIndex < 0 || (inputIndex < 0 && outputIndex < 0 && cacheIndex < 0)) continue;

    let rowIndex = index + 2;
    while (rowIndex < lines.length) {
      const line = lines[rowIndex] ?? "";
      if (!line.includes("|")) break;
      const cells = splitMarkdownRow(line);
      if (cells.length !== headers.length || isSeparatorRow(cells)) {
        rowIndex += 1;
        continue;
      }
      const model = modelFromCell(cells[modelIndex] ?? "");
      if (!model) {
        rowIndex += 1;
        continue;
      }
      const rowContext = `${headers.join(" ")} ${cells.join(" ")}`;
      const input = inputIndex >= 0 ? normalizePrice(cells[inputIndex] ?? "", `${headers[inputIndex] ?? ""} ${rowContext}`) : null;
      const output = outputIndex >= 0 ? normalizePrice(cells[outputIndex] ?? "", `${headers[outputIndex] ?? ""} ${rowContext}`) : null;
      const cache = cacheIndex >= 0 ? normalizePrice(cells[cacheIndex] ?? "", `${headers[cacheIndex] ?? ""} ${rowContext}`) : null;
      if (input || output || cache) {
        facts.push({
          model,
          inputUsdPerMillion: input,
          cachedInputUsdPerMillion: cache,
          outputUsdPerMillion: output,
          contextWindow: contextIndex >= 0 ? cleanText(cells[contextIndex] ?? "") || null : null,
          conditions: null,
          sourceUrls: [sourceUrl],
        });
      }
      rowIndex += 1;
    }
    index = Math.max(index, rowIndex - 1);
  }
  return facts;
}

function extractLooseTableRows(text: string, sourceUrl: string): PricingFact[] {
  const lines = cleanText(text).split("\n").filter(Boolean);
  const facts: PricingFact[] = [];
  let headers: string[] | null = null;
  for (const line of lines) {
    if (!line.includes("|")) {
      headers = null;
      continue;
    }
    const cells = splitMarkdownRow(line);
    if (cells.length < 3) continue;
    if (!headers && cells.some((cell) => /input|entrada|prompt/i.test(cell)) && cells.some((cell) => /output|salida|completion/i.test(cell))) {
      headers = cells;
      continue;
    }
    if (!headers || cells.length !== headers.length || isSeparatorRow(cells)) continue;
    const modelIndex = headerIndex(headers, [/model/, /modelo/]);
    const cacheIndex = headerIndex(headers, [/cached/, /cache hit/, /cache/]);
    const inputIndex = headers.findIndex((header) => {
      const normalized = normalizedKey(header);
      return /\b(input|entrada|prompt)\b/.test(normalized) && !/cached|cache hit/.test(normalized);
    });
    const outputIndex = headerIndex(headers, [/output/, /salida/, /completion/]);
    if (modelIndex < 0) continue;
    const model = modelFromCell(cells[modelIndex] ?? "");
    if (!model) continue;
    const context = `${headers.join(" ")} ${cells.join(" ")}`;
    const input = inputIndex >= 0 ? normalizePrice(cells[inputIndex] ?? "", context) : null;
    const output = outputIndex >= 0 ? normalizePrice(cells[outputIndex] ?? "", context) : null;
    const cache = cacheIndex >= 0 ? normalizePrice(cells[cacheIndex] ?? "", context) : null;
    if (input || output || cache) {
      facts.push({ model, inputUsdPerMillion: input, cachedInputUsdPerMillion: cache, outputUsdPerMillion: output, contextWindow: null, conditions: null, sourceUrls: [sourceUrl] });
    }
  }
  return facts;
}

function documentUnitHint(text: string): string {
  const normalized = stripAccents(text).toLowerCase();
  const million = (normalized.match(/\b(?:1\s*m|1m|million|millon|mtok|million tokens?)\b/g) ?? []).length;
  const thousand = (normalized.match(/\b(?:1\s*k|1k|thousand|mil|k tokens?)\b/g) ?? []).length;
  if (million > 0 && thousand === 0) return "USD per 1M tokens";
  if (thousand > 0 && million === 0) return "USD per 1K tokens";
  return "";
}

function nearestModel(lines: string[], index: number, currentLine: string): string {
  const structuredModel = /(?:^|\||\b)(?:model|modelo|name|id)\s*:\s*([^|]{2,120})/i.exec(currentLine)?.[1]?.trim();
  if (structuredModel) return structuredModel;
  const explicitPricing = /^[-*#\s]*([^$|]{2,100}?)(?:\s+(?:api\s+)?(?:pricing|prices?|costs?|precio|precios|tarifa)|\s*[:–—-]\s*(?:input|entrada|prompt))/i.exec(currentLine)?.[1]?.trim();
  if (explicitPricing && !/^(api|pricing|prices?|costs?|precio|precios)$/i.test(explicitPricing)) return explicitPricing;
  const beforeLabel = currentLine.split(/\b(?:input|entrada|prompt|output|salida|completion|cached?|cache)\b/i)[0]?.trim() ?? "";
  const inline = beforeLabel.replace(/^[-*#\s]+/, "").replace(/[:–—-]+$/, "").trim();
  if (inline.length >= 2 && inline.length <= 120 && !PRICE_KEYWORDS.test(inline) && !MONEY_PATTERN.test(inline)) return inline;
  for (let offset = 1; offset <= 3; offset += 1) {
    const candidate = (lines[index - offset] ?? "").replace(/^[-*#\s]+/, "").trim();
    if (!candidate || candidate.length > 120 || MONEY_PATTERN.test(candidate)) continue;
    if (/^(pricing|prices|precios?|model|modelo|api|text models?)$/i.test(candidate)) continue;
    return candidate;
  }
  return "Modelo no identificado";
}

function labeledPrice(line: string, labels: RegExp, unitHint = ""): string | null {
  const moneyMatches = [...line.matchAll(/(?:US\$|USD\s*|\$)\s*(\d+(?:[.,]\d+)?)/gi)];
  const labelRegex = new RegExp(labels.source, "gi");
  for (const label of line.matchAll(labelRegex)) {
    const labelStart = label.index ?? 0;
    const labelEnd = labelStart + label[0].length;
    const before = moneyMatches
      .filter((money) => (money.index ?? 0) + money[0].length <= labelStart && labelStart - ((money.index ?? 0) + money[0].length) <= 90)
      .at(-1);
    const after = moneyMatches.find((money) => (money.index ?? 0) >= labelEnd && (money.index ?? 0) - labelEnd <= 90);

    const beforeGap = before
      ? line.slice((before.index ?? 0) + before[0].length, labelStart)
      : "";
    const afterGap = after
      ? line.slice(labelEnd, after.index ?? labelEnd)
      : "";

    let selected: RegExpMatchArray | undefined;
    if (after && /^(?:\s|:|=|-){0,20}(?:per\s+)?$/i.test(afterGap)) {
      selected = after;
    } else if (before && /(?:per|por|\/)?\s*(?:1\s*m|1m|million|mill[oó]n|mtok|tokens?)/i.test(beforeGap)) {
      selected = before;
    } else if (before && after) {
      const beforeDistance = labelStart - ((before.index ?? 0) + before[0].length);
      const afterDistance = (after.index ?? 0) - labelEnd;
      selected = beforeDistance <= afterDistance ? before : after;
    } else {
      selected = before ?? after;
    }

    if (selected?.[1]) {
      const start = Math.max(0, (selected.index ?? 0) - 30);
      const end = Math.min(line.length, labelEnd + 100);
      return normalizePrice(`$${selected[1]}`, line.slice(start, end), unitHint);
    }
  }

  if (/\b(?:usd|dollars?|1\s*m|1m|million|mill[oó]n|mtok|1\s*k|1k|thousand|mil)\b/i.test(`${line} ${unitHint}`)) {
    const labelRegexNumeric = new RegExp(labels.source, "i");
    const label = labelRegexNumeric.exec(line);
    if (label?.index !== undefined) {
      const tail = line.slice(label.index + label[0].length);
      const numeric = /^[^0-9]{0,30}(\d+(?:[.,]\d+)?)/.exec(tail)?.[1];
      if (numeric) return normalizePrice(`$${numeric}`, line, unitHint);
    }
  }
  return null;
}

function extractLabeledPrices(text: string, sourceUrl: string): PricingFact[] {
  const lines = cleanText(text)
    .split("\n")
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/))
    .map((line) => line.trim())
    .filter(Boolean);
  const facts: PricingFact[] = [];
  const unitHint = documentUnitHint(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // Las filas con precios anteriores tachados se interpretan en el parser
    // compacto, que puede distinguir el importe vigente. El parser etiquetado
    // confundiría el límite "input tokens" con la columna de entrada.
    if (/~~[\s\S]*?~~/.test(line)) continue;
    if (!PRICE_KEYWORDS.test(line)) continue;
    if (!MONEY_PATTERN.test(line) && (!unitHint || !/\d+(?:[.,]\d+)?/.test(line))) continue;
    const extended = line;
    const input = labeledPrice(extended, /(?:input|entrada|prompt|cache\s*miss)/i, unitHint);
    const output = labeledPrice(extended, /(?:output|salida|completion)/i, unitHint);
    const cache = labeledPrice(extended, /(?:cached\s*input|cache\s*hit|cach[eé])/i, unitHint);
    if (!input && !output && !cache) continue;
    const model = nearestModel(lines, index, line);
    if (/^(?:model|modelo|api|pricing|prices?|precios?)$/i.test(model)) continue;
    facts.push({
      model,
      inputUsdPerMillion: input,
      cachedInputUsdPerMillion: cache,
      outputUsdPerMillion: output,
      contextWindow: /\b\d+(?:[.,]\d+)?\s*(?:k|m)\s*(?:context|tokens?)\b/i.exec(extended)?.[0] ?? null,
      conditions: null,
      sourceUrls: [sourceUrl],
    });
  }
  return facts;
}



function sliceSection(text: string, startPatterns: RegExp[], endPatterns: RegExp[]): string {
  const clean = cleanText(text);
  let start = 0;
  for (const pattern of startPatterns) {
    const match = pattern.exec(clean);
    if (match?.index !== undefined) {
      start = match.index;
      break;
    }
  }
  let end = clean.length;
  const tail = clean.slice(start);
  for (const pattern of endPatterns) {
    const match = pattern.exec(tail);
    if (match?.index !== undefined && match.index > 0) {
      end = Math.min(end, start + match.index);
    }
  }
  return clean.slice(start, end);
}

function providerPricingScope(subject: string, text: string): string {
  const provider = getPricingProfile(subject)?.id;
  if (provider === "OpenAI") {
    return sliceSection(text, [/\bFlagship models\b/i, /\bOur latest models\b/i], [/\bRegional processing\b/i, /\bAll models\b/i, /\bMultimodal models\b/i]);
  }
  if (provider === "Anthropic") {
    return sliceSection(text, [/\bModel pricing\b/i], [/\bIntroductory pricing\b/i, /\bMTok\s*=\s*Million tokens\b/i, /\bCloud platform pricing\b/i]);
  }
  if (provider === "DeepSeek") {
    return sliceSection(text, [/\bModel Details\b/i], [/\bDeduction Rules\b/i]);
  }
  if (provider === "MiniMax") {
    const llm = sliceSection(text, [/(?:^|\n)\s*(?:#+\s*)?LLM\s*(?:\n|$)/i], [/(?:^|\n)\s*(?:#+\s*)?Audio\s*(?:\n|$)/i]);
    return sliceSection(llm, [], [/(?:^|\n)\s*Legacy Models\s*(?:\n|$)/i]);
  }
  return cleanText(text);
}

function priceCells(text: string, unitHint = "USD per 1M tokens"): Array<string | null> {
  const cells: Array<string | null> = [];
  const normalized = withoutStruckPrices(text);
  for (const match of normalized.matchAll(/(?:US\$|USD\s*|\$)\s*(\d+(?:[.,]\d+)?)|-/gi)) {
    if (match[1]) {
      cells.push(normalizePrice(`$${match[1]}`, normalized, unitHint));
    } else {
      cells.push(null);
    }
  }
  return cells;
}

function firstRowText(segment: string): string {
  const line = segment.split("\n").find((value) => MONEY_PATTERN.test(value));
  return line ?? segment;
}

function extractDeepSeekOfficial(text: string, sourceUrl: string): PricingFact[] {
  const scope = providerPricingScope("DeepSeek", text);
  if (!/\b1M INPUT TOKENS\s*\(CACHE HIT\)/i.test(scope)) return [];
  const modelArea = /\bMODEL\s+([\s\S]{0,240}?)(?=\bBASE URL\b|\bMODEL VERSION\b)/i.exec(scope)?.[1] ?? "";
  const models = [...modelArea.matchAll(/\bdeepseek-[a-z0-9._-]+(?:\(\d+\))?/gi)]
    .map((match) => match[0].replace(/\(\d+\)$/i, ""));
  if (models.length === 0) return [];
  const valuesBetween = (start: RegExp, end: RegExp): string[] => {
    const startMatch = start.exec(scope);
    if (!startMatch?.index && startMatch?.index !== 0) return [];
    const from = startMatch.index + startMatch[0].length;
    const tail = scope.slice(from);
    const endMatch = end.exec(tail);
    const body = endMatch?.index !== undefined ? tail.slice(0, endMatch.index) : tail.slice(0, 180);
    return extractNormalizedMoneyValues(body, "USD per 1M tokens");
  };
  const cache = valuesBetween(/1M INPUT TOKENS\s*\(CACHE HIT\)/i, /1M INPUT TOKENS\s*\(CACHE MISS\)/i);
  const input = valuesBetween(/1M INPUT TOKENS\s*\(CACHE MISS\)/i, /1M OUTPUT TOKENS/i);
  const output = valuesBetween(/1M OUTPUT TOKENS/i, /Concurrency Limit|Deduction Rules/i);
  const context = /CONTEXT LENGTH\s+([^\n]{1,40})/i.exec(scope)?.[1]?.trim() ?? null;
  return models.map((model, index) => ({
    model,
    inputUsdPerMillion: input[index] ?? null,
    cachedInputUsdPerMillion: cache[index] ?? null,
    outputUsdPerMillion: output[index] ?? null,
    contextWindow: context,
    conditions: null,
    sourceUrls: [sourceUrl],
  }));
}

function extractOpenAiOfficial(text: string, sourceUrl: string): PricingFact[] {
  const scope = providerPricingScope("OpenAI", text);
  if (!/\bFlagship models\b|\bOur latest models\b/i.test(scope)) return [];
  const pattern = /\bgpt-[a-z0-9.]+(?:-[a-z0-9.]+)*\b/gi;
  const matches = [...scope.matchAll(pattern)];
  const facts: PricingFact[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) continue;
    const start = match.index ?? 0;
    const next = matches[index + 1]?.index ?? scope.length;
    const segment = scope.slice(start + match[0].length, next);
    const row = firstRowText(segment).slice(0, 260);
    const cells = priceCells(row);
    if (cells.length < 4) continue;
    facts.push({
      model: match[0],
      inputUsdPerMillion: cells[0] ?? null,
      cachedInputUsdPerMillion: cells[1] ?? null,
      outputUsdPerMillion: cells[3] ?? null,
      contextWindow: "Short context",
      conditions: "Standard",
      sourceUrls: [sourceUrl],
    });
  }
  return facts;
}

function extractAnthropicOfficial(text: string, sourceUrl: string): PricingFact[] {
  const scope = providerPricingScope("Anthropic", text);
  if (!/\bModel pricing\b/i.test(scope)) return [];
  const profile = getPricingProfile("Anthropic");
  if (!profile) return [];
  const matches = [...scope.matchAll(new RegExp(profile.modelPattern.source, "gi"))];
  const raw: PricingFact[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) continue;
    const start = match.index ?? 0;
    const next = matches[index + 1]?.index ?? scope.length;
    const segment = scope.slice(start, next).slice(0, 500);
    if (/\b(?:deprecated|retired)\b/i.test(segment)) continue;
    const cells = extractNormalizedMoneyValues(segment, "USD per 1M tokens");
    if (cells.length < 5) continue;
    const conditions = [
      /through\s+[A-Za-z]+\s+\d{1,2},?\s+\d{4}/i.exec(segment)?.[0],
      /starting\s+[A-Za-z]+\s+\d{1,2},?\s+\d{4}/i.exec(segment)?.[0],
      /limited availability/i.exec(segment)?.[0],
    ].filter((value): value is string => Boolean(value)).join("; ") || null;
    raw.push({
      model: cleanText(match[0]),
      inputUsdPerMillion: cells[0] ?? null,
      cachedInputUsdPerMillion: cells[3] ?? null,
      outputUsdPerMillion: cells[4] ?? null,
      contextWindow: null,
      conditions,
      sourceUrls: [sourceUrl],
    });
  }
  const currentModels = new Set(raw.filter((fact) => !/^starting\b/i.test(fact.conditions ?? "")).map((fact) => normalizedKey(fact.model)));
  return raw.filter((fact) => !/^starting\b/i.test(fact.conditions ?? "") || !currentModels.has(normalizedKey(fact.model)));
}

function extractMiniMaxOfficial(text: string, sourceUrl: string): PricingFact[] {
  const scope = providerPricingScope("MiniMax", text);
  if (!/\bMiniMax-M(?:3|2\.7)\b/i.test(scope)) return [];
  const pattern = /\bMiniMax-(?:M3|M2\.7(?:-highspeed)?)\b/gi;
  const matches = [...scope.matchAll(pattern)];
  const facts: PricingFact[] = [];
  let m3Index = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) continue;
    const start = match.index ?? 0;
    const next = matches[index + 1]?.index ?? scope.length;
    const segment = scope.slice(start, next).slice(0, 520);
    let values = extractNormalizedMoneyValues(segment, "USD per 1M tokens");
    if (/\b(?:off|descuento)\b/i.test(segment) && values.length >= 6) {
      values = values.filter((_value, valueIndex) => valueIndex % 2 === 1);
    }
    if (values.length < 3) continue;
    const model = cleanText(match[0]);
    const conditions: string[] = [];
    if (/MiniMax-M3/i.test(model)) {
      conditions.push(m3Index < 2 ? "Standard" : "Priority");
      m3Index += 1;
    } else {
      conditions.push("Standard");
    }
    const range = /[≤<>]=?\s*512k\s+input\s+tokens?/i.exec(segment)?.[0];
    if (range) conditions.push(range);
    if (/Permanent\s+50%\s+off/i.test(segment)) conditions.push("Permanent 50% off");
    facts.push({
      model,
      inputUsdPerMillion: values[0] ?? null,
      outputUsdPerMillion: values[1] ?? null,
      cachedInputUsdPerMillion: values[2] ?? null,
      contextWindow: range ? "512k tokens" : null,
      conditions: conditions.join("; "),
      sourceUrls: [sourceUrl],
    });
  }
  return facts;
}

function extractProviderOfficialRows(subject: string, text: string, sourceUrl: string): PricingFact[] {
  const provider = getPricingProfile(subject)?.id;
  if (provider === "DeepSeek") return extractDeepSeekOfficial(text, sourceUrl);
  if (provider === "OpenAI") return extractOpenAiOfficial(text, sourceUrl);
  if (provider === "Anthropic") return extractAnthropicOfficial(text, sourceUrl);
  if (provider === "MiniMax") return extractMiniMaxOfficial(text, sourceUrl);
  return [];
}

function extractNormalizedMoneyValues(text: string, unitHint: string): string[] {
  const clean = withoutStruckPrices(text);
  const values: string[] = [];
  for (const match of clean.matchAll(/(?:US\$|USD\s*|\$)\s*(\d+(?:[.,]\d+)?)/gi)) {
    const normalized = normalizePrice(match[0], text, unitHint);
    if (normalized) values.push(normalized);
  }
  return values;
}

function compactConditions(segment: string): string | null {
  const conditions = [
    /(?:permanent|permanente)\s+\d+(?:\.\d+)?%\s+(?:off|de descuento)/i.exec(segment)?.[0],
    /(?:through|hasta)\s+[A-Za-zÁÉÍÓÚáéíóú]+\s+\d{1,2},?\s+\d{4}/i.exec(segment)?.[0],
    /(?:starting|desde)\s+[A-Za-zÁÉÍÓÚáéíóú]+\s+\d{1,2},?\s+\d{4}/i.exec(segment)?.[0],
    /[≤<>]=?\s*\d+k\s+input\s+tokens?/i.exec(segment)?.[0],
    /(?:short|long)\s+context/i.exec(segment)?.[0],
  ].filter((value): value is string => Boolean(value));
  return conditions.length > 0 ? [...new Set(conditions)].join("; ") : null;
}

/**
 * Recupera filas que los sitios modernos exponen como texto compacto, por
 * ejemplo `gpt-5.6-sol$5.00$0.50$6.25$30.00`. Estas filas no tienen `|` ni
 * etiquetas repetidas, pero conservan el orden de columnas publicado por cada
 * proveedor. No contiene precios fijos: únicamente interpreta el documento.
 */
function extractCompactPricingRows(text: string, sourceUrl: string, subject: string): PricingFact[] {
  const profile = getPricingProfile(subject);
  if (!profile) return [];
  const clean = cleanText(text);
  const pattern = new RegExp(profile.modelPattern.source, "gi");
  const matches = [...clean.matchAll(pattern)];
  const unitHint = documentUnitHint(clean);
  const facts: PricingFact[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) continue;
    const start = match.index ?? 0;
    const nextStart = matches[index + 1]?.index ?? clean.length;
    const segment = clean.slice(start, Math.min(nextStart, start + 500));
    let values = extractNormalizedMoneyValues(segment, unitHint);
    if (values.length < 2) continue;

    // MiniMax publica el precio anterior tachado y después el descuento. Si el
    // extractor perdió el marcado HTML pero conservó ambos importes, se toma el
    // segundo valor de cada pareja únicamente cuando la propia fila anuncia el
    // descuento.
    if (profile.id === "MiniMax" && /\b(?:off|descuento)\b/i.test(segment) && values.length >= 6) {
      values = values.filter((_value, valueIndex) => valueIndex % 2 === 1);
    }

    let input: string | null = null;
    let cache: string | null = null;
    let output: string | null = null;

    if (profile.id === "OpenAI") {
      input = values[0] ?? null;
      if (values.length >= 4) {
        cache = values[1] ?? null;
        output = values[3] ?? null;
      } else if (values.length >= 3) {
        cache = values[1] ?? null;
        output = values[2] ?? null;
      } else {
        output = values[1] ?? null;
      }
    } else if (profile.id === "Anthropic") {
      input = values[0] ?? null;
      if (values.length >= 5) {
        cache = values[values.length - 2] ?? null;
        output = values[values.length - 1] ?? null;
      } else if (values.length >= 3) {
        cache = values[1] ?? null;
        output = values[values.length - 1] ?? null;
      } else {
        output = values[1] ?? null;
      }
    } else if (profile.id === "DeepSeek") {
      if (values.length >= 3) {
        cache = values[0] ?? null;
        input = values[1] ?? null;
        output = values[2] ?? null;
      } else {
        input = values[0] ?? null;
        output = values[1] ?? null;
      }
    } else if (profile.id === "MiniMax") {
      input = values[0] ?? null;
      output = values[1] ?? null;
      cache = values[2] ?? null;
    }

    if (!input && !output && !cache) continue;
    facts.push({
      model: cleanText(match[0]).replace(/\s*[≤<>]=?\s*\d+k(?:\s+input\s+tokens?)?$/i, "").trim(),
      inputUsdPerMillion: input,
      cachedInputUsdPerMillion: cache,
      outputUsdPerMillion: output,
      contextWindow: /\b\d+(?:[.,]\d+)?\s*(?:k|m)\s*(?:context|tokens?)\b/i.exec(segment)?.[0] ?? null,
      conditions: compactConditions(segment),
      sourceUrls: [sourceUrl],
    });
  }

  return facts;
}

function mergeFact(existing: PricingFact, incoming: PricingFact): PricingFact {
  return {
    model: existing.model === "Modelo no identificado" && incoming.model !== "Modelo no identificado" ? incoming.model : existing.model,
    inputUsdPerMillion: existing.inputUsdPerMillion ?? incoming.inputUsdPerMillion,
    cachedInputUsdPerMillion: existing.cachedInputUsdPerMillion ?? incoming.cachedInputUsdPerMillion,
    outputUsdPerMillion: existing.outputUsdPerMillion ?? incoming.outputUsdPerMillion,
    contextWindow: existing.contextWindow ?? incoming.contextWindow,
    conditions: existing.conditions ?? incoming.conditions,
    sourceUrls: [...new Set([...existing.sourceUrls, ...incoming.sourceUrls])],
  };
}

function numericPrice(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalModelForSubject(subject: string, value: string): string | null {
  const profile = getPricingProfile(subject);
  const clean = cleanText(value);
  if (!profile) return clean && clean !== "Modelo no identificado" ? clean : null;
  const match = new RegExp(profile.modelPattern.source, "i").exec(clean);
  return match?.[0]?.trim() ?? null;
}

function sanitizePricingFact(subject: string, fact: PricingFact): PricingFact | null {
  const model = canonicalModelForSubject(subject, fact.model);
  if (!model) return null;
  const input = numericPrice(fact.inputUsdPerMillion);
  const output = numericPrice(fact.outputUsdPerMillion);
  if (input === null || output === null || input <= 0 || output <= 0) return null;
  if (input > 1_000 || output > 1_000) return null;
  if (/\b(?:realtime|audio|transcrib|speech|tts|image|embedding|moderation)\b/i.test(model)) return null;
  const cache = numericPrice(fact.cachedInputUsdPerMillion);
  return {
    ...fact,
    model,
    inputUsdPerMillion: formatNumber(input),
    outputUsdPerMillion: formatNumber(output),
    cachedInputUsdPerMillion: cache !== null && cache > 0 && cache <= 1_000 ? formatNumber(cache) : null,
  };
}

function deduplicateFacts(subject: string, facts: PricingFact[]): PricingFact[] {
  const merged = new Map<string, PricingFact>();
  for (const raw of facts) {
    const fact = sanitizePricingFact(subject, raw);
    if (!fact) continue;
    const key = [normalizedKey(fact.model), normalizedConditionKey(fact.conditions ?? "")].join("|");
    const existing = merged.get(key);
    merged.set(key, existing ? mergeFact(existing, fact) : fact);
  }
  return [...merged.values()];
}

function extractSourceFacts(subject: string, evidence: string, sourceUrl: string): PricingFact[] {
  const official = deduplicateFacts(subject, extractProviderOfficialRows(subject, evidence, sourceUrl));
  if (official.length > 0) return official;
  const scoped = providerPricingScope(subject, evidence);
  const markdown = deduplicateFacts(subject, extractMarkdownTables(scoped, sourceUrl));
  if (markdown.length > 0) return markdown;
  const loose = deduplicateFacts(subject, extractLooseTableRows(scoped, sourceUrl));
  if (loose.length > 0) return loose;
  const compact = deduplicateFacts(subject, extractCompactPricingRows(scoped, sourceUrl, subject));
  if (compact.length > 0) return compact;
  // Para proveedores conocidos no se interpreta prosa libre: es demasiado
  // fácil asociar cifras de otro párrafo con un modelo cercano.
  if (getPricingProfile(subject)) return [];
  return deduplicateFacts(subject, extractLabeledPrices(scoped, sourceUrl));
}

function sourceEvidenceText(source: PricingEvidenceSource): string {
  return [source.content, source.snippet].filter(Boolean).join("\n");
}

export function extractPricingDataDeterministically(
  subject: string,
  sources: PricingEvidenceSource[],
  searchResults: SearchResultItem[] = [],
): PricingResearchData {
  const facts: PricingFact[] = [];
  const usedSources = new Set<string>();
  const notes: string[] = [];

  for (const source of sources) {
    if (!isTrustedPricingSourceUrl(subject, source.url)) continue;
    const evidence = source.content ?? "";
    if (!evidence || !PRICE_KEYWORDS.test(evidence)) continue;
    const extracted = extractSourceFacts(subject, evidence, source.url);
    if (extracted.length > 0) {
      facts.push(...extracted);
      usedSources.add(source.url);
    }
  }

  // Los fragmentos del buscador sirven para descubrir URLs, nunca como datos
  // de precio. Pueden estar truncados, desactualizados o mezclar varias tablas.
  if (searchResults.some((result) => result.snippet && isOfficialPricingUrl(subject, result.url))) {
    notes.push("Los fragmentos del buscador se ignoraron como evidencia de precios; solo se usó contenido abierto de páginas oficiales de pricing.");
  }

  return {
    provider: getPricingProfile(subject)?.id ?? subject,
    items: deduplicateFacts(subject, facts),
    notes: [...new Set(notes)],
    sources: [...usedSources],
  };
}

export function mergePricingResearchData(
  primary: PricingResearchData,
  secondary: PricingResearchData | null | undefined,
): PricingResearchData {
  if (!secondary) return primary;
  return {
    provider: primary.provider || secondary.provider,
    items: deduplicateFacts(primary.provider || secondary.provider, [...primary.items, ...secondary.items]),
    notes: [...new Set([...primary.notes, ...secondary.notes])],
    sources: [...new Set([...primary.sources, ...secondary.sources])],
  };
}

export function pricingDataHasVerifiedPrices(data: PricingResearchData): boolean {
  return data.items.some((item) => item.inputUsdPerMillion !== null && item.outputUsdPerMillion !== null);
}
