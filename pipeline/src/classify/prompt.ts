import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { BatchRequest, MessageParams } from './client.js';
import type { ClassifyConfig } from './config.js';
import { buildUserContent, type CoinInput } from './input.js';
import { outputJsonSchema, type Narrative } from './schema.js';

/**
 * Prompt assembly. System prompt = template (instructions and output rules) with the
 * taxonomy text and the slug mapping filled in. It depends only on the template, the
 * taxonomy file and the narrative list, never on the coin, so it is byte-identical in
 * every request and is the cached prefix. The coin record is the user message.
 */

export interface PromptParts {
  /** First line of the template: `prompt-version: <id>`. */
  baseVersion: string;
  template: string;
}

export function parseTemplate(raw: string): PromptParts {
  const m = /^prompt-version:\s*(\S+)\s*\n---\n([\s\S]*)$/.exec(raw);
  if (!m)
    throw new Error('Prompt template must start with "prompt-version: <id>" and a "---" line');
  return { baseVersion: m[1]!, template: m[2]!.trim() };
}

export function slugMapping(narratives: readonly Narrative[]): string {
  return narratives.map((n) => `- ${n.label} -> ${n.slug}`).join('\n');
}

export function buildSystemPrompt(
  parts: PromptParts,
  taxonomy: string,
  narratives: readonly Narrative[],
): string {
  const out = parts.template
    .replace('{{slug_mapping}}', () => slugMapping(narratives))
    .replace('{{taxonomy}}', () => stripDraftComments(taxonomy).trim());
  if (out.includes('{{')) throw new Error('Prompt template has an unfilled placeholder');
  return out;
}

/** Leading HTML comments in the taxonomy file are notes for people, not for the model. */
function stripDraftComments(text: string): string {
  return text.replace(/^(\s*<!--[\s\S]*?-->\s*)+/, '');
}

/**
 * The version stored with every result: the template's own id plus a hash of the final
 * system prompt, so swapping the taxonomy file changes the version and re-opens the coins.
 */
export function promptVersion(baseVersion: string, systemPrompt: string): string {
  const hash = createHash('sha256').update(systemPrompt).digest('hex').slice(0, 8);
  return `${baseVersion}+${hash}`;
}

export class PromptBuilder {
  readonly system: string;
  readonly version: string;
  readonly slugs: string[];
  private readonly schema: Record<string, unknown>;

  constructor(
    readonly config: ClassifyConfig,
    parts: PromptParts,
    taxonomy: string,
    narratives: readonly Narrative[],
  ) {
    this.system = buildSystemPrompt(parts, taxonomy, narratives);
    this.version = promptVersion(parts.baseVersion, this.system);
    this.slugs = narratives.map((n) => n.slug);
    this.schema = outputJsonSchema(this.slugs);
  }

  systemBlocks(): MessageParams['system'] {
    return [
      {
        type: 'text',
        text: this.system,
        cache_control: { type: 'ephemeral', ttl: this.config.cacheTtl },
      },
    ];
  }

  /** One request body for `model`. Only `messages` differs between coins. */
  params(model: string, coin: CoinInput): MessageParams {
    const p: MessageParams = {
      model,
      max_tokens: this.config.maxTokens,
      system: this.systemBlocks(),
      messages: [{ role: 'user', content: buildUserContent(coin) }],
      output_config: { format: { type: 'json_schema', schema: this.schema } },
    };
    const thinking = this.config.thinking[model];
    if (thinking) p.thinking = thinking;
    return p;
  }

  request(customId: string, model: string, coin: CoinInput): BatchRequest {
    return { custom_id: customId, params: this.params(model, coin) };
  }
}

export async function loadPromptBuilder(
  config: ClassifyConfig,
  narratives: readonly Narrative[],
): Promise<PromptBuilder> {
  const [template, taxonomy] = await Promise.all([
    readFile(config.promptPath, 'utf8'),
    readFile(config.taxonomyPath, 'utf8'),
  ]);
  return new PromptBuilder(config, parseTemplate(template), taxonomy, narratives);
}
