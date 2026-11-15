import type { CoinInput } from './input.js';
import type { WorkItem } from './store.js';

/**
 * Made-up coins for dry runs with no database (`--synthetic N`). Deterministic for a given
 * count. Lengths are chosen to look like pump.fun launches: a short name and ticker, a
 * description of 0 to about 70 words, a few socials. Not real data; for cost estimates only.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'dog',
  'cat',
  'frog',
  'moon',
  'pepe',
  'wif',
  'hat',
  'baby',
  'based',
  'chad',
  'ai',
  'agent',
  'rocket',
  'giga',
  'sigma',
  'inu',
  'coin',
  'cult',
  'king',
  'goat',
  'squirrel',
  'president',
  'game',
  'pixel',
  'bot',
  'swap',
  'yield',
  'meme',
  'vibes',
  'banana',
  'cheese',
  'zoo',
];

export function syntheticItems(n: number): WorkItem[] {
  const rand = rng(n * 7919 + 13);
  const pick = (): string => WORDS[Math.floor(rand() * WORDS.length)]!;
  const items: WorkItem[] = [];
  for (let i = 0; i < n; i++) {
    const name = `${pick()} ${pick()}`;
    const descWords = Math.floor(rand() * rand() * 70);
    const description =
      descWords === 0 ? null : Array.from({ length: descWords }, pick).join(' ') + '.';
    const socials: Record<string, string> = {};
    if (rand() < 0.7) socials['twitter'] = `https://x.com/${pick()}${pick()}${i}`;
    if (rand() < 0.5) socials['telegram'] = `https://t.me/${pick()}${i}`;
    if (rand() < 0.4) socials['website'] = `https://${pick()}${i}.example`;
    const launch = Date.UTC(2025, 0, 1) + Math.floor(rand() * 300 * 86_400_000);
    const secondsToAth = Math.floor(rand() * 40_000);
    const coin: CoinInput = {
      chain: 'solana',
      address: `SYN${i.toString(36).padStart(8, '0')}`,
      name,
      ticker: name.replace(' ', '').slice(0, 8).toUpperCase(),
      description,
      socials,
      launched_at: new Date(launch).toISOString(),
      graduated_at: new Date(launch + 3_600_000).toISOString(),
      ath_market_cap_usd: 100_000 + Math.floor(rand() * rand() * 20_000_000),
      ath_at: new Date(launch + secondsToAth * 1000).toISOString(),
      seconds_to_ath: secondsToAth,
      status: (['alive', 'dead', 'rugged'] as const)[Math.floor(rand() * 3)]!,
    };
    items.push({ key: String(i + 1), coin, candidates: [] });
  }
  return items;
}
