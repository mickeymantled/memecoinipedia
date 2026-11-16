import type { ParentCoin } from './parent-score.js';

/**
 * Made-up coins for testing the parent-candidate provider. Deterministic. Not real data.
 */

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
export const SYNTH_EPOCH = Date.UTC(2025, 0, 1);

const SYLLABLES = [
  'ba',
  'be',
  'bo',
  'ka',
  'ke',
  'ki',
  'ko',
  'la',
  'lo',
  'lu',
  'ma',
  'mi',
  'mo',
  'na',
  'ne',
  'no',
  'pa',
  'pe',
  'po',
  'ra',
  're',
  'ro',
  'sa',
  'se',
  'si',
  'so',
  'ta',
  'te',
  'ti',
  'to',
  'va',
  'vo',
  'za',
  'zo',
  'xu',
  'qi',
  'jo',
  'ju',
  'fa',
  'fi',
];

/** A pronounceable made-up word of 2 to 4 syllables. */
export function gibberish(rand: () => number): string {
  const n = 2 + Math.floor(rand() * 3);
  let w = '';
  for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(rand() * SYLLABLES.length)]!;
  return w;
}

export interface SyntheticCoin extends ParentCoin {
  description: string | null;
  /** When the ATH was reached. Stored in the database; the ranking does not read it. */
  ath_at: number | null;
}

/** `n` listed coins with gibberish names: shaped like the real table for timing, not for meaning. */
export function syntheticListedCoins(n: number, seed = 1): SyntheticCoin[] {
  const rand = rng(seed);
  const out: SyntheticCoin[] = [];
  for (let i = 0; i < n; i++) {
    const a = gibberish(rand);
    const b = rand() < 0.4 ? gibberish(rand) : null;
    const name = b ? `${a} ${b}` : a;
    const launched = SYNTH_EPOCH + Math.floor(rand() * 300 * DAY);
    out.push({
      address: `PS${i.toString(36).padStart(9, '0')}`,
      ticker: (b ? a + b : a).toUpperCase().slice(0, 10),
      name,
      description:
        rand() < 0.6
          ? Array.from({ length: 5 + Math.floor(rand() * 40) }, () => gibberish(rand)).join(' ')
          : null,
      launched_at: launched,
      ath_market_cap_usd: 100_000 + Math.floor(rand() * rand() * 20_000_000),
      ath_at: launched + Math.floor(rand() * 40_000) * 1000,
    });
  }
  return out;
}

export interface PlantedSet {
  coins: SyntheticCoin[];
  /** child address to the true parent's address. */
  parentOf: Map<string, string>;
  /** Coins with no relation to any other: must get an empty list. */
  unrelated: string[];
  /** Addresses of decoys that must never be candidates (later, or unlisted). */
  later: { child: string; decoy: string }[];
  unlisted: { child: string; decoy: string }[];
  stopWordOnly: string[];
}

function coin(
  address: string,
  ticker: string,
  name: string,
  day: number,
  ath: number,
  extra: Partial<SyntheticCoin> = {},
): SyntheticCoin {
  const launched = SYNTH_EPOCH + day * DAY;
  return {
    address,
    ticker,
    name,
    description: null,
    launched_at: launched,
    ath_market_cap_usd: ath,
    ath_at: launched + 3_600_000,
    ...extra,
  };
}

/** Planted families (prefix, suffix, baby, son of, wif-style, sequel with a digit) and decoys. */
export function plantedSet(): PlantedSet {
  const coins: SyntheticCoin[] = [];
  const parentOf = new Map<string, string>();
  const family = (parent: SyntheticCoin, children: SyntheticCoin[]): void => {
    coins.push(parent, ...children);
    for (const c of children) parentOf.set(c.address, parent.address);
  };
  family(coin('P_PNUT', 'PNUT', 'Peanut the Squirrel', 10, 900_000_000), [
    coin('C_BABYPNUT', 'BABYPNUT', 'Baby Pnut', 100, 400_000),
    coin('C_PNUTCASH', 'PNUTCASH', 'Pnut Cash', 101, 300_000),
  ]);
  family(coin('P_BONK', 'BONK', 'Bonk', 20, 1_500_000_000), [
    coin('C_SONOFBONK', 'SONOFBONK', 'Son of Bonk', 110, 500_000),
    coin('C_MEGABONK', 'MEGABONK', 'Mega Bonk', 111, 250_000),
  ]);
  family(coin('P_WIF', 'WIF', 'dogwifhat', 30, 4_000_000_000), [
    coin('C_CATWIF', 'CATWIF', 'catwifhat', 120, 800_000),
    coin('C_FROGWIFHAT', 'FROGWIFHAT', 'frog wif hat', 121, 600_000),
  ]);
  family(coin('P_GIGACHAD', 'GIGACHAD', 'Giga Chad', 40, 300_000_000), [
    coin('C_GIGACHAD2', 'GIGACHAD2', 'Giga Chad 2', 130, 700_000),
  ]);
  family(coin('P_MOODENG', 'MOODENG', 'Moo Deng', 50, 600_000_000), [
    coin('C_MOODENGINU', 'MDINU', 'moodeng returns', 140, 200_000, {
      description: 'The sequel to Moo Deng, back for revenge',
    }),
  ]);

  // Stop words only: a "DOG" parent exists, and a coin whose only link is the word dog.
  coins.push(coin('P_DOG', 'DOG', 'Dog', 60, 50_000_000));
  coins.push(coin('P_COIN', 'COIN', 'Coin', 61, 50_000_000));
  coins.push(coin('C_BABYDOG', 'BABYDOG', 'Baby Dog', 150, 150_000));
  coins.push(coin('C_COININU', 'COININU', 'Coin Inu', 151, 150_000));
  const stopWordOnly = ['C_BABYDOG', 'C_COININU'];

  // Never candidates: a later coin and an unlisted coin with the same ticker as the parent.
  coins.push(coin('P_ZORB', 'ZORB', 'Zorb', 70, 90_000_000));
  coins.push(coin('C_ZORBCASH', 'ZORBCASH', 'Zorb Cash', 160, 400_000));
  coins.push(coin('L_ZORB', 'ZORB', 'Zorb', 200, 90_000_000)); // launched after the child
  coins.push(coin('U_ZORB', 'ZORBY', 'Zorb', 80, 50_000)); // unlisted: ATH under $100k
  coins.push(coin('E_NOLAUNCH', 'ZORBX', 'Zorbx', 0, 90_000_000, { launched_at: null }));
  parentOf.set('C_ZORBCASH', 'P_ZORB');

  // Unrelated gibberish that shares nothing with anything above.
  const unrelated = ['U1', 'U2', 'U3'];
  coins.push(coin('U1', 'QXVZMT', 'Qxvzmt', 170, 120_000));
  coins.push(coin('U2', 'WRYPLK', 'Wryplk Jyx', 171, 120_000));
  coins.push(coin('U3', 'HJKQWX', 'Hjkqwx', 172, 120_000));

  return {
    coins,
    parentOf,
    unrelated,
    later: [{ child: 'C_ZORBCASH', decoy: 'L_ZORB' }],
    unlisted: [{ child: 'C_ZORBCASH', decoy: 'U_ZORB' }],
    stopWordOnly,
  };
}
