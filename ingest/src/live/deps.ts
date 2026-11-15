import type { Database, StageName } from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import type { DiscoveredToken, DiscoverOptions } from '../sources/codex/client.js';
import type { JupiterToken } from '../sources/jupiter/client.js';
import type { Logger } from '../worker/log.js';
import type { SpendGate } from './gate.js';

/**
 * What a pass of a live loop needs: the database, the clients, a clock. A pass is a plain
 * function of these; nothing in a pass sleeps, so a test hands in a fake clock and simulated
 * clients and calls it directly.
 */
export interface LiveDeps {
  db: Kysely<Database>;
  /** The Codex.io client's discovery walk (`CodexClient.discoverGraduated`). */
  codex: {
    discoverGraduated(
      range: { from: number; to: number },
      opts?: DiscoverOptions,
    ): AsyncGenerator<DiscoveredToken>;
  };
  jupiter: {
    getTokens(mints: readonly string[]): Promise<JupiterToken[]>;
    /**
     * Milliseconds until Jupiter requests may go out again after a 429 (`JupiterClient.pausedForMs`).
     * A pass that sees a positive number ends instead of waiting, so the next tick starts with the
     * watch loop again. Absent: never paused.
     */
    pausedForMs?(): number;
  };
  /** Puts coins in a stage's queue (`PipelineWorker.enqueueCoins`). The stage rows stay the truth. */
  enqueue(stage: StageName, coinIds: readonly number[]): Promise<void>;
  gate: SpendGate;
  now: () => Date;
  log: Logger;
}
