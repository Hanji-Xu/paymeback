# Pay Me Back: build spec

This is the spec the site was built from, kept for reference. Where the code and its tests differ from this
text, the code and tests are right. The site was first built as a one-file app called Settle Graph; this
spec calls that the "legacy app".

## 1. What we are building

A static website called Pay Me Back, a bill-splitting tool that shows, as an animated graph, how a
group's debts simplify into a few payments. The owner wants visitors to get a sense of **accuracy, clarity
and simplicity**. The look and interaction follow https://postevand.com/pages/tap-water (notes in §9).

Decisions already made by the owner:

- **Text input** is parsed by a built-in rule-based parser in the browser. No AI, no server.
- **Sharing** is by link: the whole group is encoded in the URL fragment. No accounts, no database.
- **Hosting** is GitHub Pages, served from the `docs/` folder. Static files only, no build step.
- **Least energy**: no images, no web fonts, no frameworks, no analytics, no third-party requests except
  one optional exchange-rate fetch. Target: under 60 KB gzipped for everything.

A working earlier version exists as one file (the "legacy app", not part of this repository).
Its math, simplification steps, provenance tracking, graph drawing and bill editor are verified and should
be **ported, not reinvented**. Its artifact-specific code (`window.claude`, `buildDocument`, publish/save,
`#split-state` JSON) is dropped.

## 2. File layout

```
./                             repository root (only docs/ is published)
  SPEC.md                      this file
  README.md                    how to run, test and deploy (written by the integrator)
  package.json                 {"type":"module"}; `npm test` = node --test
  tests/*.test.mjs             node:test unit tests, import from ../docs/js/*.js
  docs/                        THE PUBLISHED SITE (GitHub Pages serves this folder)
    .nojekyll
    index.html                 static shell, all sections, no inline script or style
    css/style.css              all styles
    js/core.js                 money, currencies, rates lookup, bill math      (pure, no DOM)
    js/simplify.js             simplification steps, provenance, breakdowns    (pure, no DOM)
    js/parse.js                text -> bills, bills -> text                    (pure, no DOM)
    js/share.js                group <-> link fragment, strict validation      (pure, no DOM)
    js/graph.js                graph layout + SVG string builder               (pure, no DOM)
    js/app.js                  state, storage, all UI wiring                   (DOM)
    sw.js                      tiny offline cache
```

Rules for everything under `docs/`:

- Plain ES modules, relative imports (`./core.js`), named exports only, no default exports, no dependencies.
- Relative URLs everywhere (the site will live at `https://user.github.io/repo/`).
- A CSP meta tag is set: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'self' https://open.er-api.com; base-uri 'none'; form-action 'none'`. Therefore:
  **no inline `<script>`, no inline event handlers, no `style="..."` attributes in HTML or in HTML strings**
  (they are blocked). Setting `el.style.x = ...` from JS is fine. SVG presentation attributes are fine.
- All user-controlled text (names, titles, anything from a link or pasted text) is **untrusted**. Escape it
  with `esc()` whenever it goes into an HTML string, or use `textContent`.
- Pure modules must run under Node 22 (`node --test`) with no DOM. `Intl`, `CompressionStream`,
  `TextEncoder`, `btoa/atob`, `structuredClone` exist in Node 22.
- Code style: modern JS (const/let, arrow functions), small functions, a short comment where a rule is
  non-obvious. No dead code.

## 3. Data model

All money inside the program is an **integer number of minor units** of its currency (cents for USD, whole
yen for JPY). Never store or add floats of money. Amounts typed by people are kept as strings in the data
model and converted with `toMinor()`.

```js
Group = {
  id: 'g-' + 7 base36 chars,
  name: string (1..60),
  currency: 'USD',                  // the settle-up currency ("base")
  rev: 1791140000000,               // ms timestamp of the last edit; set by app on every change
  example?: true,                   // only on the built-in example
  people: [ { id: 'p-' + 7 base36, name: string (1..40) } ],     // order = display order
  expenses: [ Expense | Payment ],  // order = order added
  rates: { [code]: { rate: string, base: code } },   // rates typed by the user: 1 code = rate base
  fx?: { date: 'YYYY-MM-DD', usd: { [code]: number } }  // pinned auto rates, units per 1 USD, for the
                                                        // currencies this group uses (see §8)
}

Expense = {
  id: 'e-' + 7 base36, kind: 'expense',
  title: string (1..80),
  amount: '120.00',                 // decimal string in the bill's currency; ignored when split.mode==='items'
  currency: 'EUR',
  fx?: { rate: '1.1251', base: 'USD' },   // optional rate fixed for this bill: 1 EUR = 1.1251 USD
  paid:  { mode: 'single'|'equal'|'exact'|'percent'|'shares', who: [personId], values: { [personId]: string } },
  split: { mode: 'equal'|'exact'|'percent'|'shares'|'items', who: [personId], values: { [personId]: string },
           items: [ { name: string, amount: string, who: [personId] } ], tax: string, tip: string }
}
// paid.mode 'single' uses who[0]. 'exact' values are amounts in the bill currency and must sum to the total.
// 'percent' values must sum to 100. 'shares' values are positive weights.
// split.mode 'items': each item is split equally between its people; tax% and tip% are applied to the
// subtotal and shared in proportion to what each person ordered. The total is items + tax + tip.

Payment = { id, kind: 'payment', title: string, amount: string, currency: code, fx?, from: personId, to: personId }
// "from paid to": reduces what `from` owes. As a debt edge it is [to, from, amount] (to owes from).
```

## 4. `js/core.js`

```js
export const CURRENCIES            // array of supported ISO codes (take the legacy list)
export const BUILTIN_RATES         // { date, source, usd: {...} } copied from the legacy RATES constant
export function esc(s)             // HTML-escape & < > " '
export function uid(prefix)        // prefix + '-' + 7 base36 chars
export function num(v)             // lenient number from string, 0 if not finite (legacy behaviour)
export function minorDigits(code)  // 0 for JPY, KRW, VND; 2 for the other offered currencies (a fixed table, so two browsers cannot disagree)
export function toMinor(v, code)   // Math.round(num(v) * 10^digits)
export function fromMinor(m, code) // decimal string with exactly `digits` decimals, no grouping: 12345 -> '123.45'
export function formatMoney(minor, code, locale)   // Intl currency format; fallback 'EUR 123.45'
export function allocate(total, entries)           // largest-remainder split of an integer; port exactly
export function rateFor(group, code)   // -> { rate, source } | null. 1 code = rate group.currency.
                                       //    source: 'same' | 'manual' | 'pinned' | 'builtin'   (order of precedence: see §8)
export function billRate(group, bill)  // -> { rate, source } where source may also be 'fixed'; { rate: null } if unknown
export function fmtRate(r)             // six significant digits, so a conversion can be checked by hand
export function computeExpense(group, bill)   // -> Result (below). Port of legacy computeExpense + convert, made pure.
export function personTotals(group)    // Map personId -> { paid, share } in base minor units, valid bills only
export function usedCurrencies(group)  // codes other than the base that appear on bills
```

`Result` keeps the legacy shape so the rest ports easily:

```js
{ cur, rate, rateSource,
  total, paid: Map, owed: Map,              // in BASE minor units; paid and owed each sum exactly to total
  totalOrig, paidOrig: Map, owedOrig: Map,  // in the BILL's minor units
  edges: [ [debtorId, creditorId, baseMinor] ],   // each beneficiary's share owed to payers in proportion to what each paid
  subtotal, extra, splitNote,               // items mode / shares note, bill currency
  err, errPaid, errSplit, errFx, errTitle } // user-facing messages or null/undefined; err = first blocking one
```

Conversion to base: `total = round(totalOrig / 10^dOrig * rate * 10^dBase)`, done in whole-number arithmetic
(floating point rounds some exact half-cents the wrong way), then `paid` and `owed` are re-allocated from the
original maps with `allocate(total, entries)` so they always sum exactly. When a bill has several payers its
debts are counted off what each payer is still owed, so every person's net is paid minus share to the cent.

Generalise the legacy "cents" code to `minorDigits`: a JPY bill is split in whole yen.
The legacy functions read a global group; here every function takes `group` explicitly.

## 5. `js/simplify.js`

```js
export const PHASES    // [{key,label}] exactly the legacy seven: Start, Add bills, Net pairs, Cancel loops, Skip middlemen, Swap payees, Settled
export function buildSteps(group, mode)   // mode: 'fewest' | 'keep'. Port the legacy algorithm EXACTLY (same order, same tie-breaks).
export function edgeKey(a, b)             // 'a>b'
export function edgesOf(g)                // [[a,b,v]] from a step graph Map
export function balancesOf(g)             // Map id -> net (positive = is owed)
export function edgeBreakdown(steps, stepIndex, key)   // structured provenance for one arrow (below)
export function personBreakdown(steps, group, personId)// structured per-bill rows for one person (below)
export function finalPayments(steps)      // [[from,to,minor]] of the last step, sorted by people order then amount desc
```

`buildSteps` returns an array of steps with extra properties, as in the legacy code:
`steps.rawCount`, `steps.ok` (every balance identical before and after simplifying), `steps.maxV`,
`steps.afterBills`, `steps.bills` (Map billId -> `{ e, r }`).

```js
Step = { phase: 0..6,
         title: string,                 // PLAIN TEXT (app sets it with textContent)
         text: string,                  // TRUSTED HTML built here: user text escaped with esc(); only <b class="who"> and <span class="amt"> tags
         g: Map 'a>b' -> minor,         // the debt graph after this step
         P: Map 'a>b' -> { parts, notes },   // provenance, legacy structure
         hl: { kind?: 'add'|'net'|'loop'|'hop'|'swap', edges?: [[a,b]], path?: [ids], direct?: [a,b], plus?, bill?: string },
         people: Set<personId> }
```

Invariants (must be unit-tested, including with randomly generated groups):

1. At every step, for every arrow, the sum of its provenance parts equals the arrow's amount, and P has no
   key that g lacks.
2. Every person's balance after the "Add bills" phase is identical at every later step (`steps.ok === true`).
3. Mode `fewest`: the final graph has at most `n - 1` arrows for `n` people with a non-zero balance, and no
   person both pays and receives.
4. Mode `keep`: every final arrow connects two people who had a debt between them (either direction) after
   the "Net pairs" phase.
5. Regression: the built-in example group (in §11) with `BUILTIN_RATES`, base USD, gives final payments
   `fewest`: Dee→Ana 12300, Ben→Eli 10410, Cy→Eli 6909, Dee→Eli 11273 (23 steps);
   `keep`: Ben→Ana 3962, Dee→Ana 8211, Ben→Eli 6448, Cy→Eli 6782, Dee→Eli 15362, Cy→Ana 127 (22 steps).
   (The legacy app lost a cent or two on bills with several payers and gave slightly different numbers.)

Breakdowns replace the legacy HTML builders `edgeDetailHtml` / `nodeDetailHtml` with data; app.js renders them.

```js
edgeBreakdown -> { from, to, total,
  pieces: [ { amount,                       // base minor; pieces sum to total
              bill: billId, debtor, creditor,          // the original bill debt this money started as
              via: [ { bill, from, to } ],             // later hops it was passed along
              redirects: [ { from, to } ] } ],         // "swap payees" redirections
  notes:  [ { kind: 'net', amount, other, bills: [billId] } | { kind: 'loop', amount, ring: [ids] } ] }
  // pieces with identical bill/via/redirects are merged; sorted by amount desc

personBreakdown -> { paid, share, net,
  rows: [ { bill: billId, paid, share, net, isPayment } ],
  plan: [ { dir: 'pay'|'get', other: personId, amount } ] }
```

## 6. `js/parse.js`: the text input

This is the feature visitors will judge accuracy by. Principles:

- **Never guess silently.** If a line can be read two ways, or a required part is missing, the draft is not
  `ok` and carries a plain-language message that says how to fix it.
- **Deterministic.** Same text + same group = same result.
- **Round trip.** `formatBill(group, bill)` writes any valid bill as one canonical line (plus item lines),
  and parsing that text gives back an equivalent bill. This is unit-tested for every mode.

```js
export function parseText(text, group, opts)   // opts: { me?: personId }
  -> { drafts: Draft[], people: [ { name, isNew } ], defaultCurrency }
export function formatBill(group, bill)        // canonical text (may be several lines for itemised bills)
export function formatGroup(group)             // 'People: ...' line + every bill, parseable into an empty group
export function describeBill(group, bill)      // one plain sentence: how the bill was understood (see below)

Draft = { line: number,            // 1-based first line of this entry
          lines: number,           // how many source lines it covers (items make it > 1)
          source: string,
          kind: 'expense' | 'payment' | 'people' | 'currency' | 'me' | 'comment',
          ok: boolean,
          bill?: Expense | Payment,          // present when the entry is a bill and could be built
          errors: string[], warnings: string[],
          newPeople: string[] }              // names this entry would add to the group
```

People in a parsed bill are referenced by existing ids, or by a temporary id `new:<Name>` for people who are
not in the group yet; `people` lists every name with `isNew`. The app creates real ids when the user adds.

### Grammar (one entry per line)

Clause keywords split a line; lists are separated by commas, `and`, `&` or `+`.

| You write | Meaning |
|---|---|
| `People: Ana, Ben, Cy` | adds people (also `Group:`). The only way to add a name that looks like a typo of an existing one |
| `Currency: EUR` | default currency for the lines below it |
| `I am Ana` / `I'm Ana` / `Me: Ana` | lets you write `I`, `me`, `my` |
| `# note` or `// note` | ignored |
| `Dinner 120 paid by Ana` | expense, split between everyone (default), default currency |
| `Dinner: 120.00 EUR, paid by Ana, split between Ana, Ben and Cy` | canonical form; `:` after the title is optional but removes doubt when the title has numbers |
| `Ana paid 120 for dinner` / `Ana paid €120 for dinner, split with Ben and Cy` | payer first. `with` **includes the payer(s)**; `between` / `among` / `for <people>` list exactly who shares |
| `Taxi $45 paid by Ben for Ana and Cy` | Ben paid, only Ana and Cy share |
| `... for everyone except Dee` / `everyone but Dee` | everyone minus names. `everyone`, `everybody`, `all`, `all of us`, `us`, `the group`, `each` mean the whole group |
| `... paid by Ana and Ben` | several payers in equal parts |
| `... paid by Ana 80, Ben 40` | payers by amount (must add up to the total) |
| `... paid by Ana 60%, Ben 40%` | payers by percent (must make 100) |
| `... split Ana 30, Ben 20, Cy 10` | set amounts (must add up to the total) |
| `... split Ana 50%, Ben 30%, Cy 20%` | percent |
| `... split Ana x2, Ben x1` (also `2x`, `×2`, `2 shares`) | shares. **Bare numbers are amounts, never shares.** If bare numbers do not add up, the message suggests `x2` |
| `... split equally` / `split 5 ways` | everyone; `N ways` is only accepted when N is the group size, otherwise ask which people |
| `Cy paid Ana back 50` / `Cy paid Ana 50` / `Cy sent Ana $50` / `Cy gave Ana 50` / `Cy repaid Ana 50` / `Cy -> Ana 50` / `Cy → Ana 50` | payment between two people |
| `..., tip 10%` / `tax 8.5%` | only with items |
| `..., rate 1.1251` | fixes this bill's exchange rate: 1 unit of the bill's currency = 1.1251 of the group's currency |

Itemised bill: a header line followed by item lines that start with `-`, `*`, `•` or two or more spaces:

```
Dinner at the taberna, paid by Dee, tip 10%
  - Bacalhau 38 Ben
  - Shared petiscos 30 Ana, Eli
  - Vinho verde 52: Ana, Ben, Dee
```

An item is `name amount people`. No people on an item means everyone. If the header also has an amount it
must equal items + tax + tip, otherwise it is an error that shows both numbers.

### Amounts and currencies

- `120`, `120.5`, `1,200.50`, `1 200,50`, `1.200,50`, `12,50` (comma + 1 or 2 digits at the end = decimals;
  comma + 3 digits = thousands). More decimals than the currency has is an error. Zero or negative is an error.
- Currency by code next to the number, any case: `120 EUR`, `eur 120`, `120eur`. By symbol: `€ £ ₹ ₩ ₫ ₺ ₪ ₱ ฿`.
  `$` means the group's currency if that is a dollar currency, else USD. `¥` means CNY if the group's
  currency is CNY, else JPY. By word: euro(s), pound(s), yen, yuan, rupee(s), franc(s), dollar(s)/bucks (same rule as `$`).
- Which number is the amount: the one with a currency mark; otherwise the number right after `:`; otherwise
  the last number in the head (the part before the first clause keyword). Other numbers stay in the title.
  If two numbers both carry currency marks, it is an error.
- No currency on the line: the last `Currency:` directive, else the group's settle-up currency.

### People

- Names match existing people case-insensitively, whole words, longest name first (names may have spaces).
- An unknown capitalised word in a people position proposes a **new person** (reported in `newPeople`,
  shown to the user before adding).
- If an unknown name is within edit distance 1 of an existing name (2 for names of 6+ letters), the draft is
  **not ok**: "Bne is not in the group. Did you mean Ben? To add a new person, write: People: Bne".
- `I`, `me`, `my`, `myself` need `opts.me` or an `I am ...` line; otherwise an error that says so.
- The same person twice in one list is an error.

### Required parts and messages

- Expense: title, amount, payer. No payer: "Who paid? Add: paid by <name>". No title: "What was it for?
  Add a name before the amount". Split missing: everyone (a warning-free default, but `describeBill` states it).
- Payment: two different people and an amount.
- Messages are short, specific, and say what to type. They never blame.

### `describeBill`

One sentence in plain words, with exact per-person amounts in the bill's currency, e.g.
`Ana paid 120.00 EUR. Split equally: Ana 40.00, Ben 40.00, Cy 40.00.` or
`Cy paid Ana back 50.00 USD.` It uses `computeExpense`, so it shows exactly what will be added. This is
what the page shows under each typed line.

### Tests

Table-driven tests for every row of the grammar, every number format, every error message path, the
round-trip property for every mode (including items with tax and tip, several payers, fixed rate, payment,
zero-decimal currency), and a fuzz test: random junk never throws and never produces an `ok` draft whose
bill fails `computeExpense`.

## 7. `js/share.js`: the link is the data

```js
export function sanitizeGroup(obj)        // strict: returns a clean Group or throws Error(userMessage)
export async function encodeGroup(group)  // -> fragment payload string, e.g. 'v1.<base64url>'
export async function decodeGroup(payload)// -> Group (already sanitized); throws Error(userMessage)
export function sameContent(a, b)         // true if two groups are identical ignoring `rev` and `example`
```

- Format: compact JSON (short keys, defaults dropped) -> `deflate-raw` via `CompressionStream` -> base64url.
  Prefix `v1.` compressed, `u1.` uncompressed fallback when `CompressionStream` is missing.
- The page URL becomes `…/#v1.…`. The fragment never reaches the server.
- `sanitizeGroup` is the security boundary for links and pasted backups: check every type; clamp string
  lengths (§3); ids must match `/^[a-z]-[a-z0-9]{1,12}$/` and be unique, otherwise regenerate consistently;
  drop references to unknown people; currencies must be in `CURRENCIES` (else throw); cap sizes (200
  people, 2000 bills, 100 items per bill); numbers stored as strings must match a decimal pattern; ignore
  unknown keys; never copy `__proto__`, `constructor`, `prototype`. Decoding also caps the inflated size (1 MB).
- Tests: round trip for the example and random groups; hostile inputs (wrong types, huge strings, proto
  keys, script tags in names survive as plain text only, truncated base64, zip bomb) all throw or are cleaned.

## 8. Exchange rates

- Lookup order when converting a bill in currency C to the group's currency B:
  1. the bill's own fixed rate (`bill.fx`), bridged to B if its base differs;
  2. a rate the user typed for the group (`group.rates[C]` whose `base === B`);
  3. the group's pinned table (`group.fx.usd[C]` and `[B]`);
  4. `BUILTIN_RATES`.
- **Rates are pinned, not live.** Friends opening the same link must see the same numbers, so a group's
  numbers only change when someone presses "Update rates". The app (not core) fetches
  `https://open.er-api.com/v6/latest/USD` (CORS is open; free with attribution) at most once per 24 h, caches
  it in `localStorage`, and pins the currencies a group uses into `group.fx` when a currency is first used,
  or when the user presses "Update rates". Offline or blocked: fall back to `BUILTIN_RATES` and say so.
- The UI always shows the rate, its date and its source next to any converted amount.
- Attribution link required by the provider: "Rates by Exchange Rate API" → https://www.exchangerate-api.com

## 9. Look and interaction (from the reference page)

Measured on https://postevand.com/pages/tap-water:

- White `#fff`, black `#000`, nothing else. Type: 12px / 1.4 Helvetica (they use Nimbus Sans; we use the
  system stack `"Helvetica Neue", Helvetica, Arial, sans-serif`, zero font downloads). `html{font-size:10px}`
  so `1rem = 10px` there; we may use px or rem but keep the scale: **12px body, 10px small print, 24px
  statement headings, 56px marquee**. Nothing else. Weights 400 and 700 only.
- Section titles: 12px, 700, uppercase, letter-spacing 0.01em, 28px gap to the text below.
- Hairlines: every structural edge is `1px solid #000`. No shadows, no rounded corners, no gradients, no
  background fills. Depth comes from the grid of lines.
- Header: fixed, 40px tall, white, hairline below, split into cells by vertical hairlines: wordmark cell
  (left third), nav cell (middle third, uppercase 12px links, the current one bold), then two narrow cells
  on the right. Content starts below it.
- Text blocks: 80px vertical padding, 20px side padding, text column about 500px wide, offset from the left
  by about 150px on desktop (flush with 20px padding on phones). Paragraph gap = one line.
- "Media" bands: full-bleed, hairline above and below. They have photos; **we have none**. Our full-bleed
  bands are the graph and the text input.
- Statement heading: a single 24px regular-weight sentence, centred, with about 90px of air above and below.
- Link cards: a row of three equal cells split by vertical hairlines; each has a square "media" area on top
  and a details panel below (hairline above it) with an uppercase bold title followed by an em dash, and one
  line of text. **On hover the details panel slides up 40px** (`transform .4s ease`), covering the bottom of the
  media area and revealing more room below.
- Links: underlined; the underline is a 1px line that **shrinks to zero width on hover** (`width .2s ease`).
- Footer: hairline grid of cells: wordmark + two lines of 10px text, an empty cell, then columns of 10px
  links under 10px bold uppercase headings.
- Marquee: one sentence at 56px scrolling slowly leftwards in a band with a hairline above it.
- Modal (their newsletter box): centred white panel, × top right, 24px heading, a text input with a thin
  border, a full-width solid black button with white 12px text.
- Motion: `ease`, 0.2s for small things, 0.4s for panels. Nothing bounces.

Our adaptation:

- Dark scheme: swap the two colours with `prefers-color-scheme` (two custom properties, `--ink`, `--paper`,
  plus `--mute` grey for secondary text and inactive graph lines). Grey is the only third colour:
  `#767676` on white, `#8e8e8e` on black. Errors are not red; they are marked with the word and a bold label.
- On phones (< 768px): body 14px, inputs 16px (prevents iOS zoom), tap targets at least 44px high, header
  shows wordmark + SHARE + GROUP cells, nav links move to a second hairline row that scrolls sideways.
- Focus: `outline: 2px solid var(--ink); outline-offset: 2px` on `:focus-visible`.
- `prefers-reduced-motion`: no marquee movement, no slide transitions, graph steps jump instead of animating.
- The graph is monochrome: people are circles with a 1px ink stroke; a person who is owed money is a **filled
  ink circle with paper-coloured initials**, a person who owes is a paper circle, a settled person has a grey
  stroke. Arrows are ink; width 1 to 6px by amount; arrows not involved in the current step go grey; an arrow
  that is shrinking is dashed; a small ink dot travels along the path during "loop" and "middleman" steps.
  Amount labels are paper rectangles with a 1px ink border, 11px text.

## 10. Page structure and behaviour

One page, top to bottom. IDs in brackets are the anchors the nav uses.

1. **Header.** `Pay Me Back` | `BILLS  GRAPH  SETTLE UP  METHOD` (scroll-spy bolds the current one) |
   `SHARE` | `GROUP (5)`.
   - SHARE opens a small panel: the link in a read-only field, COPY LINK (and the system share sheet where
     `navigator.share` exists), its length, and one line: "Everything is inside this link. Nothing is uploaded."
   - GROUP opens a right-hand drawer: group name (editable), switch group, new group, delete group,
     settle-up currency, people (add, rename, remove if unused), "I am" (who `me` is on this device),
     exchange rates (table of used currencies with rate, date, source, a field to type your own, UPDATE RATES),
     copy all bills as text. This drawer is where all settings live; nothing else on the page is a setting.
2. **Intro text block.** Title + two short paragraphs: what it is, and that the page opens with an example
   trip you can clear.
3. **Write it down [#bills].** Full-bleed band. A large plain textarea (one bill per line), and beside or
   below it the live reading of each line: line number, `OK` or `FIX` in bold, the `describeBill` sentence
   or the error message, and `NEW PERSON: Fay` when relevant. One solid black button: `ADD 3 BILLS`
   (it adds the OK lines and leaves the lines that need fixing in the box). A "What you can write" disclosure
   lists eight example lines; clicking one inserts it. Parsing runs on input with a 150 ms debounce.
4. **Bills.** A hairline table: title, amount (original currency, and the converted amount when different),
   who paid, how it is split. A row opens the bill editor (modal, ported from the legacy editor: every
   payer and split mode, items, currency, fixed rate, live preview, delete, duplicate). Links below the
   table: `ADD WITH A FORM`, `ADD A PAYMENT`, `COPY ALL AS TEXT`, `CLEAR ALL`.
5. **Graph [#graph].** Full-bleed band holding the SVG, with a control strip built like the header (cells
   split by hairlines): previous, play/pause, next, step counter, speed, mode (FEWEST PAYMENTS / ONLY EXISTING
   DEBTS), FOLLOW (a person). Under it a text block that narrates the current step: phase label, step title,
   the sentence, and the check line "Every balance is unchanged" from the netting phase on. Hovering or
   tapping an arrow or a person shows a hairline panel with the breakdown (which bills the money comes from).
   The seven phases are a row of text links above the graph; the current one is bold.
6. **Statement.** One centred 24px sentence: "4 payments settle everything." (or "Everyone is even.").
7. **Settle up [#settle].** Link-card grid, three per row: the top area shows the amount large (24px) and
   `Ben → Eli`; the details panel says `BEN PAYS ELI —` and one line naming the bills behind it. Hover or tap
   slides the panel up and shows the full breakdown. Below the grid: a hairline table "What each person paid
   and owes" (paid, share, net), and `COPY PLAN`.
8. **Method [#method].** Text blocks: how the simplifying works (the five moves in plain words), what
   "accurate" means here (whole cents, largest-remainder rounding, balances checked at every step, rates
   pinned with their date), and where the data goes (your browser and the link, nowhere else).
9. **Footer grid + marquee.** Marquee sentence = the settle-up plan ("Ben pays Eli $104.07 — Dee pays Ana
   $122.98 — …"), or "If A owes B and B owes C, A pays C." when there is nothing to settle.

State and storage (app.js):

- `localStorage['settle.v1'] = { groups: [Group], current: groupId, me: { [groupId]: personId }, ui: { mode, speed } }`,
  every access in try/catch. First visit: the example group from §11.
- Opening a link with a fragment: decode + sanitize. If no local group has that id, add it and show it. If
  one does and the content is identical, show it. If it differs, show the link's version read-only with a
  hairline notice: "This link has a different version of Lisbon trip." with `USE THE LINK'S VERSION` and
  `KEEP MINE`. After handling, remove the fragment from the address bar (`history.replaceState`).
  A bad link shows a notice with the reason and leaves local data untouched.
- Every destructive action (delete bill, clear all, delete group, remove person) is undoable once through a
  status line at the bottom of the screen: "Bill deleted. UNDO".
- No `alert`, `confirm` or `prompt`. Dialogs use the native `<dialog>` element.
- Nothing runs when idle: no timers or animation frames unless something is playing or the marquee is
  visible. The marquee is a CSS animation, paused when off-screen.

Copy rules for every word on the page: plain, short sentences; say what happens; name things the way a
person splitting a dinner bill would; no jargon (never "edge", "node", "provenance", "fragment", "parse");
uppercase is only for labels and buttons; no exclamation marks; no emoji.

## 11. The built-in example group

Taken from the legacy app
(group "Lisbon trip (example)": Ana, Ben, Cy, Dee, Eli; six bills in EUR and USD; base USD). Keep the group
and people ids as is; rename the bill ids `e1`..`e6` to `e-1`..`e-6` so they match the id pattern in §7.
`core.js` exports it as `EXAMPLE_GROUP` (a frozen plain object; callers `structuredClone` it).

## 12. Definition of done for any module

- Its exports match this spec exactly (names, parameters, return shapes).
- `node --test` passes from the repository root, and `node --check` passes on every file you wrote.
- No TODOs, no console.log left in, no unused exports.
- Your final report lists: files written, exported names, anything in this spec you had to interpret or
  could not satisfy, and what you verified.
