/* Pay Me Back simplification: turns a group's bills into the steps the graph plays through, and keeps
   track of which bill every unit of money on every arrow came from.
   Pure functions, no DOM. Ported from the earlier single-file app: same order of work, same tie-breaks.

   A graph `g` is a Map 'a>b' -> minor units of the group's currency, meaning "a owes b".
   Step titles are plain text. Step text is HTML made here: every name, title and amount goes through
   esc(), and the only tags are <b class="who"> and <span class="amt">. */

import { esc, num, personName, listJoin, formatMoney, fxNote, computeExpense } from './core.js';

export const PHASES = Object.freeze([
  { key: 'start', label: 'Start' },
  { key: 'bills', label: 'Add bills' },
  { key: 'pairs', label: 'Net pairs' },
  { key: 'loops', label: 'Cancel loops' },
  { key: 'middle', label: 'Skip middlemen' },
  { key: 'swap', label: 'Swap payees' },
  { key: 'done', label: 'Settled' }
].map(Object.freeze));

/* ---------- graph helpers ---------- */

export function edgeKey(a, b) {
  return a + '>' + b;
}

const gv = (g, a, b) => g.get(edgeKey(a, b)) || 0;

// Add v to a→b. An arrow that reaches zero is removed, so a Map entry always means a real debt.
function gadd(g, a, b, v) {
  const n = gv(g, a, b) + v;
  if (n > 0) g.set(edgeKey(a, b), n); else g.delete(edgeKey(a, b));
}

export function edgesOf(g) {
  return [...g].filter(([, v]) => v > 0).map(([k, v]) => { const [a, b] = k.split('>'); return [a, b, v]; });
}

// Net position of everyone on the graph: positive = is owed money, negative = owes.
export function balancesOf(g) {
  const bal = new Map();
  g.forEach((v, k) => {
    const [a, b] = k.split('>');
    bal.set(a, (bal.get(a) || 0) - v);
    bal.set(b, (bal.get(b) || 0) + v);
  });
  return bal;
}

/* ---------- words ---------- */

// The text helpers for one group: W wraps a person's name, M an amount, both escaped.
function wordsFor(group, locale) {
  const base = group.currency || 'USD';
  const nameOf = id => personName(group, id);
  const W = id => '<b class="who">' + esc(nameOf(id)) + '</b>';
  const M = (minor, cur) => '<span class="amt">' + esc(formatMoney(minor, cur || base, locale)) + '</span>';
  return { base, locale, nameOf, W, M,
    chainTxt: path => path.map(W).join(' → '),
    edgeTxt: e => W(e[0]) + ' owes ' + W(e[1]) + ' ' + M(e[2]) };
}

function describeSplit(words, bill, r) {
  const { W, M } = words, s = bill.split, values = s.values || {};
  const bens = [...r.owed].filter(([, v]) => v > 0);
  if (s.mode === 'items') {
    return 'Itemized: each person covers what they ordered' + (r.extra ? ', plus their part of ' + M(r.extra, r.cur) + ' tax and tip' : '') + '.';
  }
  if (s.mode === 'equal') {
    // Left-over cents make some shares one unit bigger, so only say a flat "each" when it is true.
    const uneven = bens.some(([, v]) => v !== bens[0][1]);
    return 'Split equally between ' + listJoin(bens.map(([id]) => W(id))) + ' (' + (uneven ? 'about ' : '') + M(bens[0] ? bens[0][1] : 0) + ' each).';
  }
  if (s.mode === 'shares') return 'Split by shares: ' + listJoin(bens.map(([id]) => W(id) + ' ' + esc(num(values[id])))) + '.';
  if (s.mode === 'percent') return 'Split by percent: ' + listJoin(bens.map(([id]) => W(id) + ' ' + esc(num(values[id])) + '%')) + '.';
  return 'Split by set amounts: ' + listJoin(bens.map(([id, v]) => W(id) + ' ' + M(v))) + '.';
}

// The sentence shown when a bill arrives on the graph.
function describeExpense(group, words, bill, r) {
  const { W, M, edgeTxt } = words, foreign = r.cur !== words.base;
  if (bill.kind === 'payment') {
    return W(bill.from) + ' paid ' + W(bill.to) + ' ' + (foreign ? M(r.totalOrig, r.cur) + ' (about ' + M(r.total) + ')' : M(r.total)) +
      '. On the graph that shows up as ' + W(bill.to) + ' owing ' + W(bill.from) + ' ' + M(r.total) +
      ', which cancels against what ' + W(bill.from) + ' already owes.';
  }
  const payers = [...r.paid].filter(([, v]) => v > 0);
  const paidTxt = payers.length === 1 ? W(payers[0][0]) + ' paid' : listJoin(payers.map(([id, v]) => W(id) + ' paid ' + M(v)));
  const cost = foreign ? M(r.totalOrig, r.cur) + ' (about ' + M(r.total) + ' at ' + esc(fxNote(group, r, words.locale)) + ')' : M(r.total);
  let out = esc(bill.title) + ' cost ' + cost + '. ' + paidTxt + '. ' + describeSplit(words, bill, r);
  if (payers.length > 1) {
    out += ' Because more than one person paid, each share is owed to the payers in proportion to what they put in (' +
      listJoin(payers.map(([id, v]) => W(id) + ' ' + Math.round(v / r.total * 100) + '%')) + '). The cents are rounded so that each payer is covered exactly.';
  }
  const selfPay = payers.filter(([id]) => r.owed.get(id) > 0);
  if (selfPay.length) out += ' ' + listJoin(selfPay.map(([id]) => W(id))) + (selfPay.length > 1 ? ' cover their own shares.' : ' covers their own share.');
  const shown = r.edges.slice(0, 6).map(edgeTxt);
  if (shown.length) out += ' New debts: ' + listJoin(shown) + (r.edges.length > 6 ? ', plus ' + (r.edges.length - 6) + ' more' : '') + '.';
  return out;
}

/* ---------- where the money on an arrow came from ----------
   P maps 'a>b' to { parts: [{ c, hops: [{ f, t, b }], re: [{ from, to }] }], notes: [...] }.
   A part is c minor units; hops is the chain of bill debts it travels along (f owed t for bill b), and re
   lists the times it was sent to a different payee. Records and parts are never changed in place, so a
   shallow copy of P is a safe snapshot for a step. */

const prec = (P, k) => P.get(k) || { parts: [], notes: [] };
const part = (p, c, extraRe) => ({ c, hops: p.hops, re: extraRe ? p.re.concat([extraRe]) : p.re });

// Take m units off the front of an arrow's parts and return them.
function ptake(P, k, m) {
  const rec = prec(P, k), parts = rec.parts.slice(), out = [];
  while (m > 0 && parts.length) {
    const p = parts[0];
    if (p.c <= m) { out.push(p); m -= p.c; parts.shift(); }
    else { out.push(part(p, m)); parts[0] = part(p, p.c - m); m = 0; }
  }
  if (parts.length) P.set(k, { parts, notes: rec.notes }); else P.delete(k);
  return out;
}

function pput(P, k, parts) {
  const rec = prec(P, k);
  P.set(k, { parts: rec.parts.concat(parts), notes: rec.notes });
}

function pnote(P, k, note) {
  if (!P.has(k)) return;
  const rec = P.get(k);
  P.set(k, { parts: rec.parts, notes: rec.notes.concat([note]) });
}

// Pair money owed to a middleman with money the middleman owes onward: each piece becomes one longer chain.
function pzip(A, B) {
  const out = [], a = A.slice(), b = B.slice();
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const c = Math.min(a[i].c, b[j].c);
    out.push({ c, hops: a[i].hops.concat(b[j].hops), re: a[i].re.concat(b[j].re) });
    a[i] = part(a[i], a[i].c - c);
    b[j] = part(b[j], b[j].c - c);
    if (!a[i].c) i++;
    if (!b[j].c) j++;
  }
  return out;
}

// The bills behind some parts, each once, first seen first.
function billsOf(parts) {
  const ids = [];
  parts.forEach(p => p.hops.forEach(h => { if (!ids.includes(h.b)) ids.push(h.b); }));
  return ids;
}

// Take m off both a→b and b→a and leave a note on whatever is left of each.
function cancelPair(g, P, a, b, m) {
  gadd(g, a, b, -m);
  gadd(g, b, a, -m);
  const tookAB = ptake(P, edgeKey(a, b), m), tookBA = ptake(P, edgeKey(b, a), m);
  pnote(P, edgeKey(a, b), { kind: 'net', c: m, other: b, bills: billsOf(tookBA) });
  pnote(P, edgeKey(b, a), { kind: 'net', c: m, other: a, bills: billsOf(tookAB) });
}

/* ---------- searches ---------- */

// Who each person owes: Map debtor -> [creditor], in the order the arrows were first drawn.
function creditorsOf(g) {
  const out = new Map();
  edgesOf(g).forEach(([a, b]) => { if (!out.has(a)) out.set(a, []); out.get(a).push(b); });
  return out;
}

// A ring of debts a→b→…→a, or null. People and their creditors are tried in the group's order.
function findDirectedCycle(g, order) {
  const out = creditorsOf(g);
  out.forEach(list => list.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  const color = new Map(), stack = [];   // 1 = on the current path, 2 = finished
  const dfs = u => {
    color.set(u, 1);
    stack.push(u);
    for (const v of out.get(u) || []) {
      if (color.get(v) === 1) return stack.slice(stack.indexOf(v));
      if (!color.get(v)) { const found = dfs(v); if (found) return found; }
    }
    stack.pop();
    color.set(u, 2);
    return null;
  };
  for (const id of order) {
    if (!color.get(id)) { const found = dfs(id); if (found) return found; }
  }
  return null;
}

// A ring of people joined by debts in either direction, or null.
function findUndirectedCycle(g, order) {
  const adj = new Map();
  edgesOf(g).forEach(([a, b]) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  });
  const seen = new Set(), parent = new Map(), depth = new Map();
  const dfs = (u, from) => {
    seen.add(u);
    for (const w of adj.get(u) || []) {
      if (w === from) continue;
      if (seen.has(w)) {
        if (depth.get(w) < depth.get(u)) {
          const ring = [u];
          for (let x = u; x !== w;) { x = parent.get(x); ring.push(x); }
          return ring;
        }
        continue;
      }
      parent.set(w, u);
      depth.set(w, depth.get(u) + 1);
      const found = dfs(w, u);
      if (found) return found;
    }
    return null;
  };
  for (const start of order) {
    if (seen.has(start) || !adj.has(start)) continue;
    depth.set(start, 0);
    const found = dfs(start, null);
    if (found) return found;
  }
  return null;
}

// The shortest chain of debts from u to v that does not use the direct u→v debt, or null. `out` is creditorsOf(g).
function shortestPath(out, u, v) {
  const prev = new Map([[u, null]]), queue = [u];
  while (queue.length) {
    const x = queue.shift();
    for (const y of out.get(x) || []) {
      if ((x === u && y === v) || prev.has(y)) continue;
      prev.set(y, x);
      if (y === v) {
        const path = [v];
        for (let c = v; prev.get(c) !== null;) { c = prev.get(c); path.unshift(c); }
        return path;
      }
      queue.push(y);
    }
  }
  return null;
}

// Fewest payments: the pair of debts x→y, y→z that lets the most money skip y. The first one found wins a tie.
function bestMiddle(g, order) {
  let best = null;
  order.forEach(y => {
    const payees = order.filter(z => gv(g, y, z));
    if (!payees.length) return;
    order.forEach(x => {
      const xy = gv(g, x, y);
      if (!xy) return;
      payees.forEach(z => {
        if (z === x) return;
        const m = Math.min(xy, gv(g, y, z));
        if (!best || m > best.m) best = { path: [x, y, z], m };
      });
    });
  });
  return best;
}

// Only existing debts: the chain that can move the most money between two people who already deal directly.
function bestShortcut(g, order, allowed) {
  const out = creditorsOf(g);
  let best = null;
  order.forEach(u => order.forEach(v => {
    if (u === v || !allowed.has(edgeKey(u, v))) return;
    const path = shortestPath(out, u, v);
    if (!path) return;
    let m = Infinity;
    for (let j = 0; j < path.length - 1; j++) m = Math.min(m, gv(g, path[j], path[j + 1]));
    if (!best || m > best.m) best = { path, m };
  }));
  return best;
}

/* ---------- the phases ----------
   Each works on run = { group, order, g, P, words, push }. All but addBills return how many steps they added.
   The `limit` in each loop is a safety net that is never reached: it is the most steps the phase can take. */

function addBills(run, valid) {
  const { g, P, words } = run;
  valid.forEach(({ e, r }) => {
    r.edges.forEach(([a, b, v]) => {
      gadd(g, a, b, v);
      pput(P, edgeKey(a, b), [{ c: v, hops: [{ f: a, t: b, b: e.id }], re: [] }]);
    });
    run.push(1, e.title + ' · ' + formatMoney(r.totalOrig, r.cur, words.locale), describeExpense(run.group, words, e, r),
      { edges: r.edges.map(([a, b]) => [a, b]), kind: 'add', bill: e.title }, r.edges.flatMap(([a, b]) => [a, b]));
  });
}

function netPairs(run) {
  const { g, P, order } = run, { W, M, edgeTxt, nameOf } = run.words;
  let netted = 0;
  order.forEach((a, i) => order.slice(i + 1).forEach(b => {
    const ab = gv(g, a, b), ba = gv(g, b, a);
    if (!ab || !ba) return;
    const m = Math.min(ab, ba);
    cancelPair(g, P, a, b, m);
    const left = gv(g, a, b) ? edgeTxt([a, b, gv(g, a, b)]) : gv(g, b, a) ? edgeTxt([b, a, gv(g, b, a)]) : 'they are even';
    run.push(2, nameOf(a) + ' and ' + nameOf(b) + ' cancel out',
      W(a) + ' owed ' + W(b) + ' ' + M(ab) + ' and ' + W(b) + ' owed ' + W(a) + ' ' + M(ba) +
      '. Paying each other back and forth is pointless, so ' + M(m) + ' comes off both: ' + left + '.',
      { edges: [[a, b], [b, a]], kind: 'net' }, [a, b]);
    netted++;
  }));
  return netted;
}

function cancelLoops(run) {
  const { g, P, order } = run, { W, M, chainTxt } = run.words;
  const limit = g.size;   // every loop removes at least one arrow
  let loops = 0, cyc;
  while (loops < limit && (cyc = findDirectedCycle(g, order))) {
    const ring = cyc.concat([cyc[0]]), links = cyc.map((a, i) => [a, ring[i + 1]]);
    const m = Math.min(...links.map(([a, b]) => gv(g, a, b)));
    const gone = [];
    links.forEach(([a, b]) => {
      gadd(g, a, b, -m);
      ptake(P, edgeKey(a, b), m);
      pnote(P, edgeKey(a, b), { kind: 'loop', c: m, ring });
      if (!gv(g, a, b)) gone.push(W(a) + ' → ' + W(b));
    });
    run.push(3, 'A loop of ' + cyc.length,
      'Money goes around in a circle: ' + chainTxt(ring) + '. Each of them would pay ' + M(m) + ' and get ' + M(m) +
      ' straight back, so ' + M(m) + ' comes off every link in the loop.' +
      (gone.length ? ' The ' + listJoin(gone) + ' debt' + (gone.length > 1 ? 's disappear.' : ' disappears.') : ''),
      { path: ring, edges: links, kind: 'loop' }, cyc);
    loops++;
  }
  return loops;
}

// Add m (with its parts) to a→b. If b→a exists the two cancel; returns a sentence about that, or ''.
// Once the loops are gone a skip never meets a debt going the other way, so the cancelling is a safety net:
// it makes sure a→b and b→a can never both stay on the graph.
function addWithNet(run, a, b, m, parts) {
  const { g, P } = run, { W, M, edgeTxt } = run.words;
  const back = gv(g, b, a);
  gadd(g, a, b, m);
  pput(P, edgeKey(a, b), parts);
  if (!back) return '';
  cancelPair(g, P, a, b, Math.min(gv(g, a, b), back));
  const left = gv(g, a, b) ? edgeTxt([a, b, gv(g, a, b)]) : gv(g, b, a) ? edgeTxt([b, a, gv(g, b, a)]) : W(a) + ' and ' + W(b) + ' are even';
  return ' ' + W(b) + ' already owed ' + W(a) + ' ' + M(back) + ', so those cancel: ' + left + '.';
}

function skipMiddlemen(run, mode, allowed) {
  const { g, P, order } = run, { W, M, chainTxt, nameOf } = run.words;
  // With the loops gone the arrows have a direction of flow. Every skip removes an arrow and at most adds a
  // longer one, and an arrow cannot span more people than there are.
  const limit = g.size * order.length;
  let hops = 0;
  while (hops < limit) {
    const best = mode === 'fewest' ? bestMiddle(g, order) : bestShortcut(g, order, allowed);
    if (!best) break;
    const p = best.path, m = best.m, u = p[0], v = p[p.length - 1];
    const before = p.slice(0, -1).map((a, j) => [a, p[j + 1], gv(g, a, p[j + 1])]);
    const hadDirect = gv(g, u, v);
    let moved = null;
    before.forEach(([a, b]) => {
      gadd(g, a, b, -m);
      const taken = ptake(P, edgeKey(a, b), m);
      moved = moved ? pzip(moved, taken) : taken;
    });
    const netNote = addWithNet(run, u, v, m, moved);
    let title, text;
    if (p.length === 3) {
      const y = p[1];
      title = 'Skip ' + nameOf(y) + ' as the middle';
      text = W(u) + ' owes ' + W(y) + ' ' + M(before[0][2]) + ', and ' + W(y) + ' owes ' + W(v) + ' ' + M(before[1][2]) + '. ' +
        W(y) + ' would just be passing ' + M(m) + ' along, so ' + W(u) + ' pays ' + W(v) + ' that ' + M(m) + ' directly' +
        (hadDirect ? ' (on top of the ' + M(hadDirect) + ' ' + W(u) + ' already owed ' + W(v) + ')' : '') + '. ' +
        W(y) + ' ends up exactly where they started: ' + M(m) + ' less coming in and ' + M(m) + ' less going out.' + netNote;
    } else {
      title = 'Send it straight to ' + nameOf(v);
      text = 'Money flows ' + chainTxt(p) + '. ' + W(u) + ' already deals with ' + W(v) + ' directly, so ' + M(m) + ' can skip everyone in between. ' +
        listJoin(p.slice(1, -1).map(W)) + ' each receive ' + M(m) + ' less and pay ' + M(m) + ' less, so their balances do not move.' + netNote;
    }
    run.push(4, title, text, { path: p, edges: before.map(([a, b]) => [a, b]).concat([[u, v]]), direct: [u, v], kind: 'hop' }, p);
    hops++;
  }
  return hops;
}

/* Fewest payments only. By now nobody both pays and receives, so a ring of payments (ignoring direction)
   goes payer, payee, payer, payee. That is one payment more than needed: shift the smallest amount around
   it, more on every other link and less on the rest, and one link drops out while every total stays put. */
function swapPayees(run) {
  const { g, P, order } = run, { W, M } = run.words;
  const limit = g.size;   // every swap removes at least one arrow
  let swaps = 0, ring;
  while (swaps < limit && (ring = findUndirectedCycle(g, order))) {
    const links = ring.map((a, j) => { const b = ring[(j + 1) % ring.length]; return gv(g, a, b) ? [a, b] : [b, a]; });
    const amounts = links.map(([a, b]) => gv(g, a, b));
    const least = odd => Math.min(...amounts.filter((_, j) => j % 2 === odd));
    // The side holding the smallest link is the one that shrinks; a tie shrinks the odd links.
    const shrink = least(0) < least(1) ? 0 : 1, d = least(shrink);
    const sign = links.map((_, j) => (j % 2 === shrink ? -1 : 1));
    const pool = [];
    links.forEach(([a, b], j) => { if (sign[j] < 0) pool.push({ debtor: a, from: b, parts: ptake(P, edgeKey(a, b), d) }); });
    links.forEach(([a, b], j) => {
      if (sign[j] < 0) return;
      const src = pool.find(x => x.debtor === a && x.parts) || pool.find(x => x.parts);
      pput(P, edgeKey(a, b), src.parts.map(p => part(p, p.c, { from: src.from, to: b })));
      src.parts = null;
    });
    const changes = [], dropped = [];
    links.forEach(([a, b], j) => {
      gadd(g, a, b, sign[j] * d);
      changes.push(W(a) + ' pays ' + W(b) + ' ' + M(d) + (sign[j] > 0 ? ' more' : ' less'));
      if (!gv(g, a, b)) dropped.push(W(a) + ' → ' + W(b));
    });
    const payers = [...new Set(links.map(l => l[0]))], payees = [...new Set(links.map(l => l[1]))];
    run.push(5, 'Swap who pays whom',
      listJoin(payers.map(W)) + ' all pay into ' + listJoin(payees.map(W)) + ' through crossing payments, which is more payments than needed. Shift ' +
      M(d) + ': ' + listJoin(changes) + '. Everyone still pays or receives the same total, and ' + listJoin(dropped) + ' drops out.',
      { edges: links, plus: links.filter((_, j) => sign[j] > 0), kind: 'swap' }, ring);
    swaps++;
  }
  return swaps;
}

/* ---------- steps ---------- */

const sameBalances = (a, b) => [...a].every(([id, v]) => v === (b.get(id) || 0)) && [...b].every(([id, v]) => v === (a.get(id) || 0));

// What the bills themselves say everyone is owed: what they paid minus their share.
function billBalances(comps) {
  const bal = new Map();
  comps.forEach(({ r }) => {
    if (r.err) return;
    r.paid.forEach((v, id) => bal.set(id, (bal.get(id) || 0) + v));
    r.owed.forEach((v, id) => bal.set(id, (bal.get(id) || 0) - v));
  });
  return bal;
}

function closingStep(run, any, rawCount, ok) {
  const n = edgesOf(run.g).length;
  const title = n ? n + (n === 1 ? ' payment settles everything' : ' payments settle everything') : any ? 'Everyone is even' : 'No bills yet';
  const text = !any ? (run.order.length ? 'Add a bill to see the graph.' : 'Add people and a bill to see the graph.')
    : 'After adding up the bills there ' + (rawCount === 1 ? 'was 1 debt' : 'were ' + rawCount + ' separate debts') +
      '. Now ' + (n || 'no') + ' payment' + (n === 1 ? ' covers' : 's cover') + ' all of it. ' +
      (ok ? 'Every person still ends up paying or receiving exactly what their bills say: what they paid minus their share.'
        : 'Warning: balances drifted, please report this group.');
  run.push(6, title, text, {}, []);
}

/* mode: 'fewest' (anyone may pay anyone) or 'keep' (people only pay someone they already had a debt with).
   locale is optional and only changes how amounts are written in titles and text.
   Returns the steps, with rawCount, afterBills, ok, maxV, bills and order set on the array. */
export function buildSteps(group, mode, locale) {
  const steps = [], g = new Map(), P = new Map();
  const order = (group.people || []).map(p => p.id);
  const push = (phase, title, text, hl, people) => {
    steps.push({ phase, title, text, g: new Map(g), P: new Map(P), hl, people: new Set(people) });
  };
  const run = { group, order, g, P, push, words: wordsFor(group, locale) };
  const comps = (group.expenses || []).map(e => ({ e, r: computeExpense(group, e) }));
  const valid = comps.filter(x => !x.r.err && x.r.edges.length);
  const any = valid.length > 0;

  push(0, 'How to read this graph', 'Each circle is a person and each arrow means “owes”: it points from the person who owes to the person who is owed. ' +
    'Press play to watch the bills arrive one by one, then see how the debts shrink to a few payments without changing what anyone ends up paying.', {}, []);

  addBills(run, valid);
  const rawCount = edgesOf(g).length, afterBills = new Map(g);

  if (!netPairs(run) && any) push(2, 'No back-and-forth debts', 'Nobody owes someone who also owes them, so there is nothing to cancel between pairs.', {}, []);
  // "Only existing debts" may add to or reverse a debt that exists now, but never join two new people.
  const allowed = new Set(edgesOf(g).flatMap(([a, b]) => [edgeKey(a, b), edgeKey(b, a)]));

  if (!cancelLoops(run) && any) push(3, 'No loops', 'There is no circle of people paying each other around, so nothing to cancel here.', {}, []);

  if (!skipMiddlemen(run, mode, allowed) && any) {
    push(4, 'No middlemen', mode === 'fewest' ? 'Nobody is both owed money and owing money, so no one is passing money along.'
      : 'No chain of debts can be shortened without creating a debt between two people who did not already owe each other.', {}, []);
  }

  if (mode === 'fewest' && !swapPayees(run) && any) {
    push(5, 'No swaps needed', 'The remaining payments already have no crossing pattern, so they cannot be merged further this way.', {}, []);
  }

  // Checked on every run: no step changed anyone's balance, and each balance is what the bills say.
  const ok = sameBalances(balancesOf(afterBills), balancesOf(g)) && sameBalances(billBalances(comps), balancesOf(g));
  closingStep(run, any, rawCount, ok);

  steps.rawCount = rawCount;
  steps.afterBills = afterBills;
  steps.ok = ok;
  steps.maxV = 1;
  steps.forEach(s => s.g.forEach(v => { if (v > steps.maxV) steps.maxV = v; }));
  steps.bills = new Map(comps.map(x => [x.e.id, x]));
  steps.order = order;
  return steps;
}

/* ---------- reading the result ---------- */

// The payments that settle everything: [[from, to, minor]], in the group's order of payers, largest first.
export function finalPayments(steps) {
  const { order } = steps;
  return edgesOf(steps[steps.length - 1].g).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]) || b[2] - a[2]);
}

/* Where the money on one arrow comes from, at one step. Each piece started as `debtor` owing `creditor` for
   `bill`; `via` lists the debts it was passed along afterwards and `redirects` the payee swaps. Pieces
   with the same story are merged and the largest comes first. Notes say what already came off this arrow. */
export function edgeBreakdown(steps, stepIndex, key) {
  const step = steps[stepIndex];
  const [from, to] = key.split('>');
  const rec = (step && step.P.get(key)) || { parts: [], notes: [] };
  const merged = new Map();
  rec.parts.forEach(p => {
    const story = JSON.stringify([p.hops, p.re]);
    const piece = merged.get(story);
    if (piece) { piece.amount += p.c; return; }
    const [first, ...rest] = p.hops;
    merged.set(story, { amount: p.c, bill: first.b, debtor: first.f, creditor: first.t,
      via: rest.map(h => ({ bill: h.b, from: h.f, to: h.t })),
      redirects: p.re.map(r => ({ from: r.from, to: r.to })) });
  });
  return { from, to, total: (step && step.g.get(key)) || 0,
    pieces: [...merged.values()].sort((a, b) => b.amount - a.amount),
    notes: rec.notes.map(n => (n.kind === 'net'
      ? { kind: 'net', amount: n.c, other: n.other, bills: n.bills.slice() }
      : { kind: 'loop', amount: n.c, ring: n.ring.slice() })) };
}

/* One person's bills, in the group's currency. `paid` and `share` are what the bill says. `net` is what the
   bill does to the person's balance on the graph (the debts owed to them minus the debts they owe), so the
   nets add up to exactly the balance the plan settles. */
export function personBreakdown(steps, group, personId) {
  const rows = [];
  (group.expenses || []).forEach(e => {
    const x = steps.bills.get(e.id);
    if (!x || x.r.err) return;
    const paid = x.r.paid.get(personId) || 0, share = x.r.owed.get(personId) || 0;
    if (!paid && !share) return;
    const net = x.r.edges.reduce((s, [a, b, v]) => s + (b === personId ? v : 0) - (a === personId ? v : 0), 0);
    rows.push({ bill: e.id, paid, share, net, isPayment: e.kind === 'payment' });
  });
  const sum = field => rows.reduce((s, row) => s + row[field], 0);
  const plan = finalPayments(steps).filter(([a, b]) => a === personId || b === personId)
    .map(([a, b, v]) => (a === personId ? { dir: 'pay', other: b, amount: v } : { dir: 'get', other: a, amount: v }));
  return { paid: sum('paid'), share: sum('share'), net: sum('net'), rows, plan };
}
