# Auren brand

Black for the stage, gold for you, and Apple's own colors for every state.

| File | What it is |
|---|---|
| [`tokens.css`](tokens.css) | Every color and font as CSS custom properties. The web console loads it from `/brand/tokens.css`. |
| [`mark.svg`](mark.svg) | The mark: a gold dot inside three rings. |
| [`make-icon.swift`](make-icon.swift) | Draws the 1024 px app icon from the same geometry: `swift brand/make-icon.swift out.png` |
| [`../apps/apple/AurenKit/Sources/AurenKit/Brand.swift`](../apps/apple/AurenKit/Sources/AurenKit/Brand.swift) | The same palette for SwiftUI, plus the `AurenMark` view. |

When a color changes, change `tokens.css`, `Brand.swift` and the two `AccentColor` assets together.

## The mark
The dot is you. The rings are the golden layer around you:

| Ring | Stands for | Devices |
|---|---|---|
| Inner, 100% | What you wear | Apple Watch, Ray-Ban Meta glasses |
| Middle, 60% | What you carry | iPhone |
| Outer, 35% | What you sit at | Mac |
| Beyond | Every app | Tools and computer use |

The geometry is fixed on a 22-unit grid: rings of radius 4, 7 and 10, a dot of radius 1.6 and a 1.2 stroke. Keep clear space of one ring gap (3 units) around it. Don't fill the rings, add gradients or recolor them.

## The one rule: gold means you
Gold appears in exactly two places:
1. **The mark.**
2. **Anything waiting for your tap**: a send, a booking, a payment. Gold fills the button, and the label names the action.

Nothing else is gold: not body text, links, receipts or charts. Keep gold under about 2% of any screen.

## Palette

### Brand
| Name | Hex | Use | On Onyx |
|---|---|---|---|
| Onyx | `#0B0B0C` | The stage: web, film, slides. Native apps use system black. | — |
| Aurum | `#D4AB54` | You. The mark and the tap. Onyx text on it is 9.1 : 1. | 9.1 : 1 |
| Halo | `#F4F1EA` | Text and the wordmark on dark | 17.4 : 1 |
| Ash | `#9A968C` | Secondary text, and things Muse did on its own (Read) | 6.7 : 1 |
| Paper | `#FFFFFF` | The light ground: README, deck, docs | — |

Aurum ramp, hue 41°: 100 `#F7ECD4` · 200 `#EDD6A6` · 300 `#E2C179` · **400 `#D4AB54`** · 500 `#BA9036` · 600 `#92712A` (gold text on Paper, 4.55 : 1) · 700 `#735921` (gold buttons on Paper, 6.6 : 1).

### Surfaces
Apple's dark system grays, used as they are: Graphite `#1C1C1E` (Gray 6) for cards, Raised `#2C2C2E` (Gray 5) for sheets, Seam `#3A3A3C` (Gray 4) for hairlines only.

### Signals
Auren doesn't invent state colors. It uses Apple's system colors (Human Interface Guidelines values, updated June 9, 2025), so a state looks the same on the watch, the phone and the Mac. Every state also has a word and a glyph; color is never the only cue.

| Signal | Means | Color | Light | Dark | Increased contrast (light / dark) |
|---|---|---|---|---|---|
| **Your move** | A send, booking or payment is waiting for your tap | Aurum (app accent) | `#92712A` | `#D4AB54` | `#735921` / `#E2C179` |
| **Done** | A write went through, with a receipt and Undo | systemGreen | `#34C759` | `#30D158` | `#008932` / `#4AD968` |
| **Stopped** | A CAPTCHA, an error, or a commit Auren won't make for you | systemRed | `#FF383C` | `#FF4245` | `#E9152D` / `#FF6165` |
| **Proof** | A link to the source: the event, the message, the page | systemBlue | `#0088FF` | `#0091FF` | `#1E6EF4` / `#5CB8FF` |
| **Read** | Muse looked something up. No color, by design | Ash | `#5E5B55` | `#9A968C` | Halo / Onyx |

Apple's default light values are 2.2 to 3.6 : 1 on white: fine for icons and fills. Text on Paper uses the increased-contrast value.

### Why these colors
- **Blue for proof.** In a controlled test of otherwise identical finance, legal and medical sites, the blue version was rated most trustworthy and the black one least (Alberts & van der Geest, *Technical Communication* 58(2), 2011). So black is the stage and never the message, and blue marks the link that lets you check Auren's work.
- **Gold for you, rarely.** Gold props raised tips through perceived status across five studies (Lee, Noble & Biswas, *JAMS* 46, 2018). Gold signals that something matters, so it is spent only on the moment that needs you.
- **Red only for Stopped.** People associate red with danger automatically, and green with safety only weakly (Pravossoudovitch et al., *Ergonomics* 57(4), 2014). Red never decorates, and Done always carries the word.
- **Apple's values for states.** Apple's guidance is that system colors make an app feel at home on the device and adapt to dark mode and Increase Contrast.
- **Color is a minor trust cue.** Receipts, Undo and a tap before every send are what make Auren trustworthy. The palette makes them easy to see.

## Apple and Meta
- **Apple.** Aurum is the app accent color, with light, dark and increased-contrast variants. Primary buttons get the color on the background, not the label. Apple Watch stays black except the approval screen, which gets a gold wash because it means "your move". On the Mac, people can override the accent color, so a button's word has to carry its meaning.
- **Meta.** Auren's identity must not derive from Meta's colors or type (Meta's partner guidelines), which black and gold satisfies. Auren's only blue is Apple's, 7° of hue from the blue on Meta's site, so the two never clash. Meta's logo needs Meta's brand review; until then the film credits Meta in text only.

## Type
| Role | Web | Apple |
|---|---|---|
| Display: wordmark, titles | Marcellus. Wordmark uppercase with +32% tracking. Never below 20 px. | Marcellus for the wordmark only |
| Text | Instrument Sans for docs and pages. The console uses the system font. | SF Pro (iPhone), SF Compact (Apple Watch), with Dynamic Type |
| Data: receipts, timings, code | JetBrains Mono | SF Mono |

## Naming
- **Auren** in sentences, **AUREN** only in the wordmark, `auren` in code, the repo and URLs. Proposed pronunciation: OR-en, like Lauren without the L.
- **Never:** Auren AI, AurenAI, the Auren app, Muse by Auren, Powered by Muse.
- **Wake phrase:** "Hey Muse". We're still waiting on Meta's answer in #office-hours. If Meta says no: "Hey Auren".
- **Crediting Meta:** plain description in sentence case, such as "Uses Muse models from Meta". Meta approves credit lines case by case and doesn't use "Powered by" for any of its brands.
- **Integrations** follow Meta's partner-first pattern: "Auren for Ray-Ban Meta glasses", "Auren with Muse".
- **Lines.** Primary: *Say it once. On anything.* Descriptor: *The layer between you and everything digital.* Origin: *The golden layer around you.*

| People see | In code and docs | Avoid |
|---|---|---|
| Watch · Glasses · Phone · Mac | `surface`, kind `watch` `glasses` `phone` `web` | surface, node, iWatch |
| Receipt | `receipt` | log, audit event |
| Undo | `POST /v1/receipts/:id/undo` | rollback, revert |
| The action verb: Post, Send, Book | `approval_request` | Confirm, OK, Yes |
| Read · Write · Send | `Tier` | low / medium / high risk |
| "The task follows you" | `handoff` | Handoff, Continuity (Apple's names) |
| (not shown) | Auren Core, device picker (`#pick`), Auren Router, Auren Memory | output router, Memory Hub |

## How Muse sounds
Short, past tense, one line per action. It asks for a tap by naming the action, and it never says "Done" before the receipt exists.

| Moment | Example |
|---|---|
| Ack | "On it." |
| Receipt | "Moved your 3 PM to 3:15. Reply to Prof. Lee is drafted." |
| Ask | "Your office-hours post is on your watch. Tap Post to send it." |
| Stop | "The checkout wants a CAPTCHA. I've stopped there for you." |
