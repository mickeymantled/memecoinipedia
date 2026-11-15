import { fileURLToPath } from 'node:url';
import type { MessageParams } from './client.js';

export const DEFAULT_FIRST_MODEL = 'claude-haiku-5-5';
export const DEFAULT_SECOND_MODEL = 'claude-sonnet-5-5';

const PROMPTS_DIR = fileURLToPath(new URL('../../prompts/', import.meta.url));
export const DEFAULT_PROMPT_PATH = `${PROMPTS_DIR}classify-v0.md`;
/** Draft copy of docs/taxonomy.md sections 2 to 7. The lead swaps it with --taxonomy. */
export const DEFAULT_TAXONOMY_PATH = `${PROMPTS_DIR}taxonomy-draft.md`;

export interface ClassifyConfig {
  firstModel: string;
  secondModel: string;
  /** Coins with a stored confidence below this, from the first-pass model, are re-run. */
  secondPassThreshold: number;
  promptPath: string;
  taxonomyPath: string;
  /** Cache lifetime of the system prompt. Batches can take over 5 minutes, so the default is 1 hour. */
  cacheTtl: '5m' | '1h';
  maxTokens: number;
  /** Thinking setting per model id; models not listed send no `thinking` field. */
  thinking: Record<string, MessageParams['thinking']>;
  /** Stop adding requests to a batch at this count (the API allows 100,000). */
  batchMaxRequests: number;
  /** Stop adding requests at this many bytes of request JSON (the API allows 256 MB). */
  batchMaxBytes: number;
  pollIntervalMs: number;
  /** A coin whose classification failed this many times is skipped unless --force. */
  maxAttempts: number;
  /** Estimator inputs for the dry run. See estimate.ts for where each default comes from. */
  charsPerToken: number;
  outputTokensPerCoin: number;
  secondPassRate: number;
  cacheHitRate: number;
}

export function defaultConfig(env: Record<string, string | undefined> = {}): ClassifyConfig {
  const firstModel = env['CLASSIFY_FIRST_MODEL'] ?? DEFAULT_FIRST_MODEL;
  const secondModel = env['CLASSIFY_SECOND_MODEL'] ?? DEFAULT_SECOND_MODEL;
  return {
    firstModel,
    secondModel,
    secondPassThreshold: 0.7,
    promptPath: DEFAULT_PROMPT_PATH,
    taxonomyPath: env['CLASSIFY_TAXONOMY_PATH'] ?? DEFAULT_TAXONOMY_PATH,
    cacheTtl: '1h',
    maxTokens: 800,
    // Thinking is on by default on both models and adds billed output tokens. The dry run
    // cannot estimate those, so v0 turns it off: Haiku 5.5 accepts "disabled" at effort
    // `high` or below (the default is medium); Sonnet 5.5 rejects "disabled" with a 400 and
    // its lowest setting is "between_tools". Source:
    // https://platform.claude.com/docs/en/build-with-claude/thinking
    thinking: {
      [DEFAULT_FIRST_MODEL]: { type: 'disabled' },
      [DEFAULT_SECOND_MODEL]: { type: 'between_tools' },
    },
    batchMaxRequests: 10_000,
    batchMaxBytes: 200 * 1024 * 1024,
    pollIntervalMs: 60_000,
    maxAttempts: 3,
    charsPerToken: 3,
    outputTokensPerCoin: 220,
    secondPassRate: 0.15,
    cacheHitRate: 0.9,
  };
}
