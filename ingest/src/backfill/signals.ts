/**
 * Stop signals for a long run. The first SIGINT or SIGTERM asks the run to stop gracefully (take
 * no new coin, let those in flight finish, print the summary, exit 0). A second one exits at once;
 * the stage rows left `running` become claimable again after the stage's timeout.
 */
import type { Logger } from '../worker/log.js';

export function installStopSignals(
  log: Logger,
  exit: (code: number) => never = (code) => process.exit(code),
): AbortSignal {
  const abort = new AbortController();
  let seen = 0;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      seen++;
      if (seen === 1) {
        log.warn(`${sig} received: taking no new coins, letting the ones in flight finish`);
        abort.abort();
      } else {
        log.warn(`${sig} received again: exiting now`);
        exit(1);
      }
    });
  }
  return abort.signal;
}
