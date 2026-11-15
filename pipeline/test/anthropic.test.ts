import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicClassifierClient } from '../src/classify/anthropic.js';
import { testBuilder, testConfig, coin } from './helpers.js';

/** The SDK wrapper, against a hand-made stand-in for the SDK. No network. */

function fakeSdk(results: unknown[]) {
  const create = vi.fn((_p: unknown) =>
    Promise.resolve({
      id: 'msgbatch_1',
      processing_status: 'in_progress',
      request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    }),
  );
  const retrieve = vi.fn((_id: string) =>
    Promise.resolve({
      id: 'msgbatch_1',
      processing_status: 'ended',
      request_counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 },
    }),
  );
  const resultsFn = vi.fn((_id: string) =>
    Promise.resolve({
      async *[Symbol.asyncIterator]() {
        for (const r of results) yield r;
      },
    }),
  );
  const countTokens = vi.fn((_p: unknown) => Promise.resolve({ input_tokens: 777 }));
  const sdk = {
    messages: { batches: { create, retrieve, results: resultsFn }, countTokens },
  } as unknown as Anthropic;
  return { sdk, create, retrieve, resultsFn, countTokens };
}

describe('AnthropicClassifierClient', () => {
  const builder = testBuilder();
  const params = builder.params(testConfig().firstModel, coin());

  it('creates a batch with custom_id and params exactly as built, and maps the reply', async () => {
    const f = fakeSdk([]);
    const info = await new AnthropicClassifierClient(f.sdk).createBatch([
      { custom_id: '42', params },
    ]);
    expect(f.create).toHaveBeenCalledWith({ requests: [{ custom_id: '42', params }] });
    expect(info).toEqual({
      id: 'msgbatch_1',
      status: 'in_progress',
      counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    });
  });

  it('polls with retrieve', async () => {
    const f = fakeSdk([]);
    const info = await new AnthropicClassifierClient(f.sdk).getBatch('msgbatch_1');
    expect(f.retrieve).toHaveBeenCalledWith('msgbatch_1');
    expect(info.status).toBe('ended');
  });

  it('maps the four result types, usage fields included', async () => {
    const f = fakeSdk([
      {
        custom_id: '1',
        result: {
          type: 'succeeded',
          message: {
            content: [
              { type: 'thinking', thinking: '' },
              { type: 'text', text: '{"a":1}' },
            ],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 5,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: 4000,
              output_tokens: 90,
            },
          },
        },
      },
      {
        custom_id: '2',
        result: {
          type: 'errored',
          error: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
        },
      },
      { custom_id: '3', result: { type: 'expired' } },
      { custom_id: '4', result: { type: 'canceled' } },
    ]);
    const out = [];
    for await (const r of new AnthropicClassifierClient(f.sdk).readResults('msgbatch_1'))
      out.push(r);
    expect(out).toEqual([
      {
        customId: '1',
        outcome: 'succeeded',
        text: '{"a":1}',
        stopReason: 'end_turn',
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 4000,
          output_tokens: 90,
        },
      },
      {
        customId: '2',
        outcome: 'errored',
        errorType: 'invalid_request_error',
        errorMessage: 'bad',
      },
      { customId: '3', outcome: 'expired' },
      { customId: '4', outcome: 'canceled' },
    ]);
  });

  it('counts tokens with the model, system and messages', async () => {
    const f = fakeSdk([]);
    const n = await new AnthropicClassifierClient(f.sdk).countTokens({
      model: params.model,
      system: params.system,
      messages: params.messages,
    });
    expect(n).toBe(777);
    expect(f.countTokens).toHaveBeenCalledWith({
      model: params.model,
      system: params.system,
      messages: params.messages,
    });
  });

  it('refuses to start without a key in the environment, and the message names no key', () => {
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      expect(() => new AnthropicClassifierClient()).toThrow(
        'ANTHROPIC_API_KEY is not set in the environment.',
      );
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });
});
