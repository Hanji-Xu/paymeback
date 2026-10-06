# Pay Me Back

A visual tool for the most efficient debt settling.

Pay Me Back is a bill-splitting page: you write down who paid for what, and it works out who owes whom.
It then shows, step by step on an animated graph, how the debts shrink to the few payments that settle
everything, and which bills each amount comes from.
It is a static site with no accounts and no server: a group lives in the browser and in the link you share.

Everything that is published is in the `docs/` folder. There is no build step and nothing to install.

## Run it on your computer

From this folder:

```
python3 -m http.server 8765 --directory docs
```

Then open <http://localhost:8765>. (`npm run serve` does the same.)

- The page opens with an example trip. Your changes are saved in the browser, under this address only.
- After you edit a file, reload. If the browser still shows the old file, reload with Shift held down.
- The offline cache (`docs/sw.js`) is only switched on over `https`, so it never runs in this local preview.

## Run the tests

You need Node 22 or newer. Nothing else.

```
node --test
```

`npm test` does the same. About 1,500 tests run in about 20 seconds. They cover the money math, the
simplifying steps, the text reader, the link format, the graph drawing, the store, the stage, the bill
editor, and the published folder as a whole (`tests/page.test.mjs`: nothing the content security policy
would block, every import and element id resolves, the example lines on the page really work).

Three tests compare the simplifying, step by step, with the earlier one-file app this site grew out of.
That file is not in this repository; the tests look for it at `../index.html` or at the path in
`SETTLE_LEGACY_HTML`, and are skipped without it. A recorded fingerprint of the same graphs stands in.

## Where it is published

The site is served by GitHub Pages from the `docs/` folder of this repository:

<https://hanji-xu.github.io/paymeback/>

Pages is switched on once, in the repository's **Settings → Pages**: under **Build and deployment** set
**Source** to **Deploy from a branch**, choose branch **main** and folder **/docs**, and press **Save**.
The first deployment takes about a minute; the **Actions** tab shows it as it runs.

To publish a change: edit the files, run `node --test`, then

```
git add .
git commit -m "What changed"
git push
```

The site updates a minute later. Visitors who have been there before get the new version on their
second visit after that: the first one notices the change and fetches it in the background.
If you changed `docs/sw.js` itself, or added or removed a file under `docs/`, also raise the number in
`const CACHE = 'paymeback-v1'` in `docs/sw.js` and keep its list of files in step.

Every address in the site is relative, so it also works under any other repository name or on a domain
of its own. `docs/.nojekyll` tells GitHub to serve the files as they are.

## Update the built-in exchange rates

Normally you do not need to. When someone first uses another currency, the page asks
[Exchange Rate API](https://www.exchangerate-api.com) for today's rates (at most once a day) and pins
them in the group. The built-in table is only the fallback for when that request fails, and it is always
shown with its date. It is also what the example trip is worked out with.

To refresh it:

1. Print today's numbers in the table's format:

   ```
   curl -s https://open.er-api.com/v6/latest/USD | node -e '
   const want = "USD EUR GBP CAD AUD NZD CHF SGD HKD CNY INR MXN BRL ZAR SEK NOK DKK PLN AED THB MYR PHP JPY KRW TWD IDR VND TRY ILS CZK HUF".split(" ");
   let s = "";
   process.stdin.on("data", d => { s += d; }).on("end", () => {
     const j = JSON.parse(s);
     console.log("date: " + new Date(j.time_last_update_unix * 1000).toISOString().slice(0, 10));
     console.log("usd: { " + want.map(c => c + ": " + j.rates[c]).join(", ") + " }");
   });'
   ```

2. In `docs/js/core.js`, replace `date` and `usd` in `BUILTIN_RATES` with what was printed. Keep the same
   31 currencies in the same order (the list of currencies the page offers is read from this table).
   The numbers are units of each currency per 1 US dollar.

3. Run `node --test`. **Expect about 45 tests to fail.** They spell out amounts of the example trip, and
   rates, at the old numbers (in `core`, `simplify`, `stage-logic`, `store`, `editor-logic` and `parse`).
   Each failure prints the new value next to the old one; put the new values into the tests.
   For `GRAPH_FINGERPRINT` in `tests/simplify.test.mjs`, the failure prints the new fingerprint.
   The test that compares bill math with the earlier app will no longer agree on converted bills, because
   that app has the old rates inside it; route its groups through
   `loadLegacy(group, { compute })`, as that test already does for some groups.

4. Check the page by eye (the example trip's amounts will have moved a little), then publish.

Groups that people already have are not affected: their rates are pinned inside each group and only change
when someone presses UPDATE RATES.

## Why this site uses very little energy

Measured on the published folder (`gzip -9`), which is everything a visitor ever downloads:

| File | Bytes | Gzipped |
|---|---:|---:|
| `index.html` | 17,584 | 4,863 |
| `css/style.css` | 43,505 | 10,650 |
| `js/app.js` | 35,041 | 12,089 |
| `js/core.js` | 20,316 | 7,429 |
| `js/editor.js` | 35,802 | 11,781 |
| `js/graph.js` | 14,330 | 5,808 |
| `js/parse.js` | 70,434 | 22,682 |
| `js/share.js` | 21,099 | 7,664 |
| `js/simplify.js` | 26,010 | 8,924 |
| `js/stage.js` | 33,572 | 11,453 |
| `js/store.js` | 25,149 | 8,229 |
| `sw.js` | 4,036 | 1,641 |
| **Total** | **346,878** | **113,213** |

That is about 111 KB over the wire for the whole site, in 12 requests, once. The target in the
spec was 60 KB; it is not met. The files are served exactly as written, with their comments, because
there is no build step. Without comments and indentation it would be about 82 KB. Getting near 60 KB would
take a minifier, which means adding a build step.

The choices that keep it small and quiet:

- **Static files only.** No server code, no database, no accounts. GitHub Pages sends files from a
  cache close to the visitor; nothing is computed per visit.
- **No images, no web fonts, no frameworks, no libraries.** The page uses the system's own Helvetica or
  Arial. The icon is a few bytes inside the HTML. The graph is drawn as SVG by under 300 lines of code.
- **No analytics, no trackers, no cookies.** The content security policy in `index.html` forbids
  loading anything from another site.
- **One outside request, and only when needed.** Exchange rates are fetched when a group first uses
  another currency or when UPDATE RATES is pressed, at most once a day per device. A group in one
  currency never makes that request. Opening the example makes none.
- **The data travels in the link.** Sharing a group uploads nothing and stores nothing anywhere. The
  example trip is a link of under 600 characters.
- **Second visits download nothing.** `sw.js` keeps the files on the device. A later visit is served
  from there, and the server is only asked "did anything change?" (a short "no" per file). The page
  also opens with no connection at all.
- **Nothing runs while you are not looking.** There are no polling timers. The graph only uses
  animation frames while a step is moving. The moving sentence at the bottom is a CSS animation that
  pauses when it is off screen, and stops for people who ask their device for less motion.
- **Two colours.** Black and white, swapped in dark mode, which also suits screens that use less
  power for black.

## What is where

```
docs/                 the published site
  index.html          the page: every section and all fixed text
  method.html         how the simplifying works, what accurate means, where the data goes
  css/style.css       all styles
  js/core.js          money in whole cents, currencies, rates, the math of one bill
  js/simplify.js      the steps that shrink the debts, and where each amount comes from
  js/parse.js         typed lines to bills, and bills back to text
  js/share.js         a group to a link and back, with strict checks on what a link may hold
  js/graph.js         the picture, as SVG text
  js/store.js         the data: saving, undo, groups, links, rates
  js/stage.js         the graph band, the player, settle cards, totals
  js/editor.js        the bill form
  js/app.js           everything else on the page, and start-up
  sw.js               the offline cache
tests/                node:test files, one per module, plus page.test.mjs for the folder as a whole
SPEC.md               the spec the site was built from
```

When a bill has several payers, it is shared out so that every person's total is exactly what they paid
minus their share, to the cent. The example trip settles with Ben → Eli $104.10, Cy → Eli $69.09,
Dee → Ana $123.00 and Dee → Eli $112.73.
