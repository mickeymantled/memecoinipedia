# Narrative taxonomy guide

Status: **draft for review.** Not yet reviewed by Muse or approved by the repository owner.

Everyone who assigns a narrative follows this file: Muse's hand labels, Grok's research batches and the Haiku classifier. The eval only means something if all three mean the same thing by each label.

## 1. What is being labelled

Each coin gets:

- **One primary narrative**: the subject the coin trades on. Ask what a buyer on launch day would have said the coin was about.
- **Up to three secondary narratives**: other labels that clearly also apply. Most coins have none, one or two. Never repeat the primary. List the strongest first.
- **A parent coin**, when the coin is a derivative (section 4).
- **A confidence** from 0 to 1 (section 6) and a one-line reason.
- **A `sensitive` flag** (section 7).

Label the coin as it was at launch: its name, ticker, description, image and linked socials, plus general knowledge of what those refer to. What the coin became later does not change its label. A dog coin whose community later built a game is still `animal`.

The label values are written exactly as in `AGENTS.md`: `AI`, `tech`, `animal`, `celebrity`, `political`, `news event`, `culture/meme`, `gaming`, `derivative`, `utility`, `other`.

## 2. The eleven narratives

| Label | The coin's subject is | Typical cases |
|---|---|---|
| `AI` | Artificial intelligence: AI agents and the coins they promote or launch, AI models and labs, chatbots, AI-run accounts, AI products | A coin promoted by an AI agent account; a token for an agent framework; a coin named after a model |
| `tech` | Technology or science as a theme, where the coin itself claims no product: space, rockets, robots, quantum computing, biotech, blockchains and crypto infrastructure as a topic, developers and software culture | A coin named after a rocket launch; a coin about a chain upgrade |
| `animal` | An animal, real or drawn: dogs, cats, frogs, any species; a specific famous animal; a pet | Dog and cat coins; a viral zoo animal; a founder's pet |
| `celebrity` | A real, named person who is famous outside the meme itself, and is not a politician: entertainers, athletes, streamers, influencers, founders, crypto personalities. Includes coins a celebrity launched or endorsed. | A musician's official coin; a coin about a streamer |
| `political` | Politicians and candidates, elections, parties, governments and their departments, policy, ideology, geopolitics and war | A coin about a president; an election-night coin; a coin about a government department |
| `news event` | A specific dated happening that is itself the subject: a disaster, accident, outage, court ruling, market crash, sports result, weather, product release date | A coin about a named outage; a coin about an eclipse |
| `culture/meme` | Internet memes and formats, catchphrases, viral clips and the people known only from them, fictional characters and franchises, film, TV, anime, music, art, food, holidays, religion, crypto-native in-jokes, absurd or shock humour | A coin named after a catchphrase; a cartoon character; a joke about flatulence |
| `gaming` | A video game, game franchise or game character, esports, gaming culture, or a coin whose own claimed product is a game | A coin for a game character; a play-to-earn token |
| `derivative` | Another specific coin. The coin exists because of that coin and would make no sense without it. | "Baby X", "X's wife", "X 2.0", a copy of a coin-native token, a port of a coin from another chain |
| `utility` | A function the coin claims for itself: a product, platform, protocol, tool, bot, launchpad, payments, revenue share, staking, a business | A token for a trading bot; a token that claims to fund research |
| `other` | Nothing above, or not enough information to tell | An empty description and a random-string ticker |

`utility` is judged by what the coin claimed at launch. We cannot verify that a product exists, and the label does not say it does.

`other` is a last resort. If a coin's subject can be named at all, one of the first ten labels fits it.

## 3. Tie-breaks

Most coins fit more than one label. Apply these rules in order and stop at the first that settles the primary. The labels that lose become secondaries when they clearly apply.

1. **Another coin is the subject: `derivative`.** If the coin would not exist without one specific other coin, the primary is `derivative` and the parent is recorded (section 4). The theme it borrows from the parent goes in the secondaries.
2. **The coin claims a function.** If that function is an AI product, the primary is `AI` with `utility` secondary. If it is a game, `gaming` with `utility` secondary. Otherwise `utility`.
3. **AI is the subject: `AI`.** This includes a coin of any theme whose selling point is that an AI agent created or promoted it. Its theme goes in the secondaries.
4. **The mascot is an animal: `animal`.** This holds however the animal became known, so a viral zoo animal or a pet in the news is `animal` with `news event` or `celebrity` secondary. Exception: a humanoid cartoon character whose name, ticker and description never mention its species is `culture/meme`.
5. **The subject is a politician, a government, an election or a political cause: `political`.** A person who holds or is seeking office is `political`, not `celebrity`. A famous person acting in a government role is `political` for coins about that role.
6. **The subject is a real, named person famous beyond one viral moment: `celebrity`.** A person known only from a single viral clip is `culture/meme`.
7. **The subject is a video game or game character: `gaming`.**
8. **The subject is a technology or science theme: `tech`.**
9. **The subject is the happening itself: `news event`.** Use this as the primary only when no person, animal, coin, product, game or meme is the subject. A coin set off by a dated event but about a nameable subject takes that subject's label and gets `news event` as a secondary.
10. **A cultural reference of any other kind: `culture/meme`.**
11. **Otherwise: `other`.**

## 4. Derivatives and parents

A coin is a derivative when its subject is **another coin**, not the thing that coin is about.

The test: would this coin make sense if the other coin did not exist?

- A coin called "Baby X", "X's wife", "X 2.0" or "X killer", where X is a coin, fails the test. It is a `derivative` of X.
- A second coin about the same squirrel, the same politician or the same news story passes the test. Both coins are about the real-world subject. Neither is a derivative of the other, however much bigger one became.
- A copy of a coin whose subject only exists as a coin (a coin-native character or joke) fails the test. It is a `derivative` of the original.
- A coin that reuses a generic format ("something Inu", "something coin") passes the test unless it names one specific coin. A coin that copies one coin's distinctive format, such as its exact visual joke with a different animal, is a `derivative` of that coin.
- A port of a coin from another chain is a `derivative` of that coin.

**Choosing the parent.** The parent is the one specific coin the derivative refers to. When several coins share the parent's name, the parent is the one that was largest when the derivative launched. Record the parent's contract address when it is known. When the parent is on another chain or cannot be identified with confidence, record no address and name the parent in the reason.

A coin has at most one parent. A derivative of a derivative points at its immediate parent.

`derivative` may also be a secondary label, when a coin has its own clear subject and also leans on one specific coin. Record the parent in that case too.

## 5. Worked examples

These are well-known coins, labelled from public knowledge of how they started. They illustrate the rules; Muse should check them against each coin's own launch data.

| Coin | Primary | Secondaries | Rule that decides |
|---|---|---|---|
| GOAT (Goatseus Maximus) | `AI` | `culture/meme` | 3: its selling point was promotion by an AI agent account |
| Fartcoin | `culture/meme` | `AI` | 10: the subject is the joke. The AI origin is real but was not what the coin was about. |
| Pnut (Peanut the squirrel) | `animal` | `news event`, `political` | 4: the mascot is an animal, however it became known |
| Moo Deng | `animal` | `culture/meme` | 4 |
| Chill Guy | `culture/meme` | none | 4, exception: a humanoid character whose species plays no part |
| A coin called "Chill Dog" launched after Chill Guy | `derivative` | `culture/meme`, `animal` | 1: parent is Chill Guy |
| An official coin launched by a musician | `celebrity` | none | 6 |
| A coin about a sitting president | `political` | none | 5 |
| A coin about a government department run by a famous founder | `political` | `celebrity` | 5 |
| A coin named after a founder's dog | `animal` | `celebrity` | 4 |
| A token for a Telegram trading bot | `utility` | none | 2 |
| A token for an AI agent framework | `AI` | `utility` | 2 |
| A coin about a worldwide software outage | `news event` | `tech` | 9 |
| A coin named after a woman from one viral street interview | `culture/meme` | none | 6: known only from the clip |

Fartcoin and GOAT are the pair to study. Both came out of the same AI agent's activity. GOAT was sold as "the coin the AI is promoting", so rule 3 applies. Fartcoin was sold as a joke, so rule 3 does not, and `AI` is a secondary.

## 6. Confidence

| Range | Meaning |
|---|---|
| 0.9 to 1.0 | The subject is unmistakable and one rule clearly decides |
| 0.7 to 0.9 | The subject is clear; there is some doubt about which of two labels is primary |
| 0.5 to 0.7 | Two labels are about equally plausible, or the information is thin |
| Below 0.5 | Largely a guess |

Confidence is about the primary label. Do not raise it because the secondaries are certain. A coin with no usable information is `other` with low confidence, not a confident `other`.

The classifier re-runs every coin under 0.7 on a larger model.

## 7. The `sensitive` flag

Set `sensitive` when the name, ticker, description or image contains any of: slurs or hate symbols; sexually explicit content; sexual content involving minors in any form; gore or glorified violence; mockery of a named private individual; celebration of a death or tragedy.

The flag is independent of the narrative. A flagged coin still gets its normal labels. Flagged coins have their images hidden by default on the site.

Crude humour alone is not sensitive. A coin about flatulence is not flagged.

## 8. Open questions for review

1. **Rule 4 and its exception.** Giving every animal mascot to `animal` matches how traders talk ("dog coins", "frog coins") but sends some pure internet memes there. The exception for humanoid characters is the least clear-cut rule in this file. Is it workable when labelling at speed?
2. **Same-subject coins.** Hundreds of coins launch for the same news story. This file says none of them is a derivative of another. The alternative is to treat every later copy as a derivative of the first coin to succeed, which is what a trader might call them, but it cannot be decided from launch data.
3. **`tech` against `utility`.** The line is whether the coin claims a function for itself. Many descriptions are vague about that.
4. **Images.** Labellers see the image. Whether the classifier does is decided in task B4 on cost. If it does not, coins whose subject is only visible in the image will be a known source of disagreement.
