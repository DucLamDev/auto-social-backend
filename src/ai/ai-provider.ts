export const AI_PROVIDER_IDS = ['openai', 'deepseek', 'gemini'] as const;

export type AiProvider = (typeof AI_PROVIDER_IDS)[number];

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  gemini: 'Google Gemini',
};

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && AI_PROVIDER_IDS.includes(value as AiProvider);
}
