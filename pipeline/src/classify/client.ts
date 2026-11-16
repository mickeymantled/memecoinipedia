/**
 * The pipeline's own view of the Anthropic API. Nothing outside `anthropic.ts`
 * imports the SDK; tests inject a fake that implements `ClassifierClient`.
 */

export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

/** One Messages API request body, as sent inside a batch. */
export interface MessageParams {
  model: string;
  max_tokens: number;
  system: Array<{ type: 'text'; text: string; cache_control?: CacheControl }>;
  messages: Array<{ role: 'user'; content: string }>;
  output_config: { format: { type: 'json_schema'; schema: Record<string, unknown> } };
  thinking?: { type: 'disabled' } | { type: 'between_tools' } | { type: 'adaptive' };
}

export interface BatchRequest {
  custom_id: string;
  params: MessageParams;
}

export interface BatchCounts {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

export interface BatchInfo {
  id: string;
  status: 'in_progress' | 'canceling' | 'ended';
  counts: BatchCounts;
}

/** Token usage of one response, as the API reports it. */
export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export type BatchResultEntry =
  | {
      customId: string;
      outcome: 'succeeded';
      /** Text of the first text block, or null when there is none. */
      text: string | null;
      stopReason: string | null;
      usage: Usage;
    }
  | { customId: string; outcome: 'errored'; errorType: string; errorMessage: string }
  | { customId: string; outcome: 'canceled' | 'expired' };

export interface ClassifierClient {
  /** Submits a batch. The caller keeps each batch under the API's limits. */
  createBatch(requests: BatchRequest[]): Promise<BatchInfo>;
  getBatch(batchId: string): Promise<BatchInfo>;
  /** Streams every result of an ended batch, in any order. Match by `customId`. */
  readResults(batchId: string): AsyncIterable<BatchResultEntry>;
  /** Input tokens for a prompt, from the count_tokens endpoint (free, rate limited). */
  countTokens(params: {
    model: string;
    system: MessageParams['system'];
    messages: MessageParams['messages'];
  }): Promise<number>;
}
