# Wilson / OpenSpend — Brand Guide

**Style: Forensic Noir**

Named after Frank J. Wilson, the forensic accountant who followed the money to convict Al Capone. The design language reflects this identity: a financial investigator's terminal — clean, precise, confident, a bit cinematic. Case files meet modern interfaces.

---

## Design Philosophy

### What Forensic Noir Is

- **Editorial precision** — Every element earns its place. No decoration.
- **Utilitarian confidence** — Tools that look like they work. Dark backgrounds, sharp type, green accents that say "money."
- **Cinematic restraint** — The drama is in the data, not the chrome. Let the numbers hit.
- **Investigator's clarity** — Information hierarchy is everything. The eye should follow the money trail naturally.

### What It Is Not

- **Not Swiss/International** — Too neutral, too corporate. Wilson has a point of view.
- **Not cyberpunk/hacker** — Chaos undermines trust. People's money is on the line.
- **Not fintech-pastel** — No rounded-corner cards with gradient backgrounds. That's the competition.
- **Not brutalist** — We're direct, not hostile.

### Guiding Tension

**Trust + Edge.** A bank's reliability with an investigator's sharpness. Users hand over their financial data — the interface must feel secure. But it also needs to feel smarter than everything else they've tried.

---

## Color System

### Core Palette

| Token | Hex | Name | Role |
|---|---|---|---|
| `money` | `#22c55e` | Money Green | Primary. The `$`. Actions, confirmations, headings, the brand mark. |
| `money-light` | `#86efac` | Mint | Highlights, selected items, inline code, links |
| `ledger` | `#e5e7eb` | Ledger White | Primary body text |
| `ink` | `#9ca3af` | Ink Gray | Secondary text, metadata, timestamps, captions |
| `carbon` | `#374151` | Carbon | Borders, separators, code block frames |
| `slate` | `#1f2937` | Slate | Panels, query bar background, cards |
| `void` | `#111827` | Void | Page/terminal background |

### Signal Colors

| Token | Hex | Name | Role |
|---|---|---|---|
| `alert` | `#ef4444` | Red Flag | Errors, anomalies, overspending, danger states |
| `caution` | `#f59e0b` | Amber | Warnings, permissions, approaching limits |
| `lead` | `#06b6d4` | Lead Blue | Info callouts, hyperlinks, external references |

### Usage Rules

1. **Green is money.** Use `money` for anything the user should act on or that represents value.
2. **Signal colors are semantic only.** Never use `alert` or `caution` decoratively.
3. **Dark by default.** `void` background, `ledger` text. Light mode is not a priority.
4. **Muted is most of the UI.** `ink` and `carbon` carry the bulk. Green is the punctuation.

### Web Palette Extensions

For the marketplace site, extend the terminal palette with surface colors:

| Token | Hex | Name | Role |
|---|---|---|---|
| `surface-0` | `#0a0f1a` | Deep Void | Hero sections, above-the-fold |
| `surface-1` | `#111827` | Void | Primary page background |
| `surface-2` | `#1f2937` | Slate | Cards, panels, raised surfaces |
| `surface-3` | `#374151` | Carbon | Borders, dividers, input fields |
| `money-dim` | `#166534` | Dark Green | Hover states, subtle green backgrounds |
| `money-glow` | `rgba(34,197,94,0.15)` | Green Glow | Focus rings, active card borders |

---

## Typography

### CLI (Terminal)

All monospace. The terminal is the medium.

| Element | Treatment |
|---|---|
| ASCII art / brand mark | Block letters with `$` characters |
| Section headers | Markdown `##` rendered bold green |
| Body text | Sentence case, `ledger` color |
| Numbers / currency | Always formatted: `$1,234.56`, never raw |
| Status / metadata | `ink` gray, lowercase, terse: `3.2s · 1,204 tokens` |
| Thinking verbs | Title case, financial vocabulary: Auditing, Reconciling, Tallying |

### Web / Marketplace

| Element | Font | Weight | Size |
|---|---|---|---|
| Display / hero | **Space Grotesk** | 700 | 48–72px |
| Headlines | **Space Grotesk** | 600 | 24–36px |
| Body | **Inter** | 400 | 16–18px |
| Code / data | **JetBrains Mono** | 400 | 14–16px |
| Captions / meta | **Inter** | 400 | 12–14px |

**Why these fonts:**
- **Space Grotesk** — Geometric sans with character. Feels technical without being cold. The slightly squared letterforms echo ledger grids and terminal glyphs.
- **Inter** — Workhorse. Designed for screens, excellent at small sizes, neutral enough to let the data breathe.
- **JetBrains Mono** — For code blocks, transaction data, API examples. Bridges the CLI and web experience.

### Type Rules

1. **No all-caps body text.** Reserve uppercase for tiny labels and badges only.
2. **Left-aligned everything.** No centered paragraphs. Center-align only hero headlines and the logo.
3. **Numbers are first-class.** Currency, percentages, and counts should be visually prominent — use `money` green or `ledger` white at a larger weight.
4. **Monospace for money.** Transaction amounts, account numbers, and financial data always render in `JetBrains Mono`.

---

## Iconography & Symbols

### CLI Glyphs

| Symbol | Unicode | Meaning |
|---|---|---|
| `$` | U+0024 | Wilson's signature. Money. The brand. |
| `⏺` | U+23FA | Wilson is speaking (answer marker) |
| `⏺` | U+23FA | Tool execution |
| `⎿` | U+23BF | Continuation / nested detail |
| `❯` | U+276F | User prompt |
| `✻` | U+273B | Metadata / performance stats |
| `═` | U+2550 | Heavy separator (emphasis) |
| `─` | U+2500 | Light separator |

### Web Icons

- **Style**: Outlined, 1.5px stroke, rounded caps. Minimal.
- **Size**: 20px standard, 24px in navigation, 16px inline.
- **Color**: `ink` gray by default, `money` green for active/interactive states.
- **Library**: Lucide Icons (consistent with the outlined, geometric feel).
- **Custom marks**: The `$` in block-letter form is the primary brand mark. No logomark beyond this.

---

## Voice & Tone

From `SOUL.md`, codified for all surfaces:

### Principles

| Principle | Example |
|---|---|
| **Direct, not decorative** | "You spent $340 on dining" not "Your dining expenditure totaled approximately $340" |
| **Active voice always** | "Cancel this subscription" not "This subscription could be cancelled" |
| **Financial verbs** | Audit, track, reconcile, flag, surface, follow |
| **Dry humor, sparingly** | In thinking verbs and empty states. Never in error messages. |
| **No jargon** | "You're spending more than you earn" not "Negative cash flow detected" |
| **Respect the mess** | Never judgmental about spending. Matter-of-fact. |

### Writing Rules

1. **Headlines**: Imperative or declarative. "Follow the money." "Your spending, audited."
2. **CTAs**: Short verb phrases. "Get started." "Import transactions." "See the breakdown."
3. **Error messages**: Say what happened, then what to do. "Import failed — the CSV has no date column. Check the file format."
4. **Empty states**: Brief, useful. "No transactions yet. Import a CSV or connect Monarch to get started."
5. **Marketing copy**: Lead with the pain. "Every finance app stops at charts. Wilson tells you what to do."

---

## Layout Principles

### CLI

1. **72–80 character width** — The top border is 72. Stay consistent.
2. **Left-aligned, indentation = hierarchy** — `⎿` for nested details under tool events.
3. **Breathing room** — Single blank line between conversation turns.
4. **No boxes** — Avoid box-drawing characters for containers. Use indentation and color.
5. **Green is the signal** — In a sea of gray, green draws the eye to what matters.

### Web / Marketplace

1. **Max content width**: 1200px. Readable, not sprawling.
2. **Grid**: 12-column, 24px gutter. Cards on a 4-column grid.
3. **Vertical rhythm**: 8px base unit. Spacing in multiples of 8.
4. **Dark-first**: `void` background is the default. Cards in `slate`, borders in `carbon`.
5. **Depth via surface color, not shadow.** Elevate with lighter background tones (`surface-2`, `surface-3`), not drop shadows.
6. **Terminal moments**: Feature code blocks prominently. Show the CLI in context. The terminal IS the product — let it show through on the web.
7. **Data is the hero**: Tables, charts, and numbers should be the largest visual elements. Not illustrations. Not stock photos.

---

## Marketplace & Payments Integration

### x402 Protocol

Wilson's marketplace supports [x402](https://www.x402.org/) — the HTTP-native payment standard built on the `402 Payment Required` status code. This enables:

- **Per-skill pricing** — Individual skills (tax prep, subscription audit, rental property) purchasable via single HTTP request
- **Agent-to-agent payments** — Wilson can pay for external services (data providers, APIs) autonomously
- **Micro-transactions** — Charges as low as $0.001 per request for granular usage-based pricing
- **No payment forms** — Payment is in the protocol. The `$` in the ASCII art isn't just branding, it's functional.

**Design implications for x402:**
- Payment states are first-class UI. Show `402 Payment Required` as a clear, non-threatening prompt — not an error.
- Use `money` green for successful payment confirmations.
- Use `caution` amber for payment-required states (it's a prompt, not an error).
- Transaction receipts should render in monospace, ledger-style.
- Display payment amounts prominently in `money` green with JetBrains Mono.

### Web4 / AI-Native Commerce

The marketplace is designed for [Web 4.0](https://web4.ai/) — the AI-agent layer of the internet where autonomous agents transact on behalf of users.

**Design implications:**
- **Agent activity indicators** — Show when Wilson is transacting autonomously. Use the tool event pattern (`⏺` + `⎿`) adapted for the web.
- **Trust through transparency** — Every agent action should be visible and auditable. No black boxes.
- **Machine-readable, human-reviewable** — Interfaces serve both agents (structured data, APIs) and humans (rendered, styled). Same data, two presentations.
- **Skill marketplace cards** — Each skill is a purchasable unit. Card design: `slate` background, `money` green price badge, description in `ledger`, metadata in `ink`.

---

## Component Patterns

### Skill Marketplace Card

```
┌─────────────────────────────────┐  surface-2
│  Subscription Audit             │  ledger, Space Grotesk 600
│  Find forgotten charges and     │  ink, Inter 400
│  recurring fees you don't use.  │
│                                 │
│  [$15/yr]          [Activate]   │  money green badge + CTA
└─────────────────────────────────┘  carbon border
```

### Payment Required State

```
┌─────────────────────────────────┐  surface-2
│  ⚠ Payment Required             │  caution amber
│                                 │
│  Tax Prep Skill — $25/year      │  ledger + money green
│  Categorize deductions, flag    │
│  write-offs, export for filing. │  ink
│                                 │
│  [Pay with x402]    [Details]   │  money green CTA
└─────────────────────────────────┘
```

### Transaction Row (Web)

```
  Mar 01   NETFLIX.COM        Entertainment   -$15.99    ink / mono
  Mar 01   WHOLE FOODS #123   Groceries       -$87.42    ink / mono
  Feb 28   PAYROLL DEPOSIT    Income        +$3,200.00   money green / mono
```

---

## Brand Mark

The `$` is the brand. The ASCII block-letter "Wilson" with `$` characters is the primary mark for the CLI. For the web:

- **Wordmark**: "Wilson" in Space Grotesk 700, with the period from "Wilson." rendered in `money` green.
- **Icon**: A single `$` in JetBrains Mono Bold, `money` green on `void` background. Used for favicons, app icons, social.
- **Tagline**: "Follow the money." — Always with the period.

### Mark Usage

- Minimum clear space: 1x the height of the `$` character on all sides.
- Never place the green `$` on a green background.
- The mark works at any size because it's a single character.

---

## File Reference

| File | Purpose |
|---|---|
| `SOUL.md` | Wilson's personality, values, anti-patterns |
| `BRAND.md` | This file. Visual identity and design system |
| `src/theme.ts` | CLI color tokens and chalk theme implementation |
| `src/components/` | TUI component library |

---

*The design should feel like opening a case file at 2am — dark, focused, and every detail matters.*
