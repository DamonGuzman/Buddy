/**
 * Normalize a user-supplied OpenAI secret key when it is structurally
 * complete enough to send to the API. The server remains authoritative for
 * whether the credential is active and authorized.
 */
export function normalizeOpenAiApiKey(value: string): string | null {
  const normalized = value.trim();
  return /^sk-\S{17,}$/.test(normalized) ? normalized : null;
}

/** Normalize a complete Firecrawl project key without ever exposing it in diagnostics. */
export function normalizeFirecrawlApiKey(value: string): string | null {
  const normalized = value.trim();
  return /^fc-\S{17,}$/.test(normalized) ? normalized : null;
}
