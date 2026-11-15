import { done, failed, type Stage } from '../stage.js';

/**
 * The `discovered` stage: the coin exists in our table with an address.
 *
 * Seeding (`discoverCoins` in /db) completes this stage in bulk when it
 * inserts coins, so the worker normally never runs it. It is registered so a
 * coin that reached the table another way (a live feed, a hand insert) can be
 * pushed through the same pipeline: the stage checks the identity and passes.
 */
export const discoveredStage: Stage = {
  name: 'discovered',
  version: 1,
  async run(_ctx, coin) {
    if (coin.address.trim() === '') return failed('invalid_coin: empty address', false);
    return done();
  },
};
