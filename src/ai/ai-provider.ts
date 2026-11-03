export const AI_PROVIDER_IDS = ['openai', 'deepseek', 'gemini', 'vpsttt'] as const;

export type AiProvider = (typeof AI_PROVIDER_IDS)[number];

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  gemini: 'Google Gemini',
  // The company IDE "AI API": OpenAI-compatible, backed by Claude/Codex accounts.
  vpsttt: 'VPSTTT AI',
};

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && AI_PROVIDER_IDS.includes(value as AiProvider);
}
