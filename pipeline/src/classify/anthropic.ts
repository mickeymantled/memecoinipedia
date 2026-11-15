/**
 * The only file in the package that imports `@anthropic-ai/sdk` (pinned in package.json).
 *
 * Sources, all read on 2026-11-15:
 * - SDK shapes: the installed package's own type declarations (`resources/messages/batches.d.ts`,
 *   `resources/messages/messages.d.ts`) and the claude-api skill's `typescript/claude-api/batches.md`.
 *   Batches: `client.messages.batches.create({ requests: [{ custom_id, params }] })`,
 *   `.retrieve(id)` -> `processing_status` ('in_progress' | 'canceling' | 'ended') and
 *   `request_counts`, `.results(id)` -> async iterable of `{ custom_id, result }` where
 *   `result.type` is 'succeeded' | 'errored' | 'canceled' | 'expired'.
 *   Token counting: `client.messages.countTokens({ model, system, messages })` -> `input_tokens`.
 * - Batch behaviour and limits: https://platform.claude.com/docs/en/build-with-claude/batch-processing
 * - Structured outputs: `output_config.format = { type: 'json_schema', schema }`,
 *   https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 * - Caching: `cache_control: { type: 'ephemeral', ttl?: '5m' | '1h' }` on a system text block,
 *   https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *
 * The key comes from the environment (the SDK reads ANTHROPIC_API_KEY itself) and is never
 * read into a variable, logged or put in an error message here.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  BatchInfo,
  BatchRequest,
  BatchResultEntry,
  ClassifierClient,
  MessageParams,
} from './client.js';

function toInfo(b: Anthropic.Messages.MessageBatch): BatchInfo {
  return {
    id: b.id,
    status: b.processing_status,
    counts: {
      processing: b.request_counts.processing,
      succeeded: b.request_counts.succeeded,
      errored: b.request_counts.errored,
      canceled: b.request_counts.canceled,
      expired: b.request_counts.expired,
    },
  };
}

export class AnthropicClassifierClient implements ClassifierClient {
  private readonly sdk: Anthropic;

  /** Reads ANTHROPIC_API_KEY from the environment. Throws, without printing it, when unset. */
  constructor(sdk?: Anthropic) {
    if (!sdk && !process.env['ANTHROPIC_API_KEY']) {
      throw new Error('ANTHROPIC_API_KEY is not set in the environment.');
    }
    this.sdk = sdk ?? new Anthropic();
  }

  async createBatch(requests: BatchRequest[]): Promise<BatchInfo> {
    const batch = await this.sdk.messages.batches.create({
      requests: requests.map((r) => ({ custom_id: r.custom_id, params: r.params })),
    });
    return toInfo(batch);
  }

  async getBatch(batchId: string): Promise<BatchInfo> {
    return toInfo(await this.sdk.messages.batches.retrieve(batchId));
  }

  async *readResults(batchId: string): AsyncIterable<BatchResultEntry> {
    for await (const item of await this.sdk.messages.batches.results(batchId)) {
      const r = item.result;
      switch (r.type) {
        case 'succeeded': {
          const block = r.message.content.find((b) => b.type === 'text');
          yield {
            customId: item.custom_id,
            outcome: 'succeeded',
            text: block && block.type === 'text' ? block.text : null,
            stopReason: r.message.stop_reason,
            usage: {
              input_tokens: r.message.usage.input_tokens,
              cache_creation_input_tokens: r.message.usage.cache_creation_input_tokens ?? 0,
              cache_read_input_tokens: r.message.usage.cache_read_input_tokens ?? 0,
              output_tokens: r.message.usage.output_tokens,
            },
          };
          break;
        }
        case 'errored':
          yield {
            customId: item.custom_id,
            outcome: 'errored',
            errorType: r.error.error.type,
            errorMessage: r.error.error.message,
          };
          break;
        case 'canceled':
        case 'expired':
          yield { customId: item.custom_id, outcome: r.type };
          break;
      }
    }
  }

  async countTokens(params: {
    model: string;
    system: MessageParams['system'];
    messages: MessageParams['messages'];
  }): Promise<number> {
    const res = await this.sdk.messages.countTokens({
      model: params.model,
      system: params.system,
      messages: params.messages,
    });
    return res.input_tokens;
  }
}
