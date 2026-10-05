/* Pay Me Back stage: the graph band and what follows from it. Here: the phase links, the drawing and its
   player, the narration, the breakdown panel, the statement, the settle cards, the totals table and
   COPY PLAN. All data comes from the store; the steps are store.steps.

   The first part of this file is pure: it turns steps and breakdowns into words and markup, and it times
   the player. It touches no page and is tested under Node. initStage(store), at the end, is the only
   part that needs one. Every name and title is escaped before it goes into markup. */

import { esc, fmtDate, formatMoney, listJoin, personName } from './core.js';
import { PHASES, edgeBreakdown, edgeKey, finalPayments, personBreakdown } from './simplify.js';
import { graphSVG, layoutFor } from './graph.js';

const MAX_PIECES = 8;       // rows shown for one arrow before the rest is folded into one line
const MAX_NAMED = 4;        // bills named on a settle card before "and 3 more bills"
const NARROW_BELOW = 560;   // px: a band narrower than this gets the phone picture
const MINUS = '\u2212';   // a real minus sign, not a hyphen

const MODE_NOTES = {
  fewest: 'Fewest payments: anyone may pay anyone, as long as every total stays right.',
  keep: 'Only existing debts: every payment is between two people who already had a debt between them.'
};

const CHECK_OK = '<b class="tag">OK</b><span>Every balance is unchanged.</span>';
const CHECK_BAD = '<b class="tag tag--fix">Check</b><span>The balances changed. Please report this.</span>';
const CLOSE = '<button type="button" class="x breakdown__close" aria-label="Close"></button>';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

/* ---------- words ---------- */

// "+$12.00", "−$3.50" (a real minus sign) or "$0.00".
export function signedMoney(minor, code) {
  return (minor > 0 ? '+' : minor < 0 ? MINUS : '') + formatMoney(Math.abs(minor), code);
}

// The text helpers for one set of steps. name, money and title give escaped markup;
// raw and rawTitle give plain text.
function wordsOf(steps, group) {
  const cur = group.currency || 'USD';
  const billOf = id => steps.bills.get(id);
  const rawTitle = id => {
    const x = billOf(id);
    return x ? x.e.title || (x.e.kind === 'payment' ? 'Payment' : 'Untitled') : 'a bill';
  };
  return {
    cur, billOf, rawTitle,
    raw: id => personName(group, id),
    name: id => esc(personName(group, id)),
    money: (minor, code) => esc(formatMoney(minor, code || cur)),
    title: id => '<b>' + esc(rawTitle(id)) + '</b>'
  };
}

const headHTML = (what, amount) => `<p class="breakdown__head"><span>${what}</span><span class="num">${amount}</span></p>`;

const rowHTML = (amount, what, lines) =>
  `<li class="breakdown__row"><span class="breakdown__amt">${amount}</span><span class="breakdown__what">${what}` +
  lines.map(t => `<span class="breakdown__via">${t}</span>`).join('') + '</span></li>';

// "(€780.00 bill)" after the name of a bill that was not in the group's currency.
function origNote(w, id) {
  const x = w.billOf(id);
  return x && x.r.cur !== w.cur ? ` <span class="mute">(${w.money(x.r.totalOrig, x.r.cur)} ${x.e.kind === 'payment' ? 'payment' : 'bill'})</span>` : '';
}

const balanceWords = (w, net) => (net > 0 ? 'gets ' + w.money(net) : net < 0 ? 'owes ' + w.money(-net) : 'even');

// What the plan asks of one person: "pays Eli $104.10", "gets $123.00 from Dee", both, or ''.
function planWords(w, plan, amount) {
  const pays = plan.filter(p => p.dir === 'pay').map(p => w.name(p.other) + ' ' + amount(p.amount));
  const gets = plan.filter(p => p.dir === 'get').map(p => amount(p.amount) + ' from ' + w.name(p.other));
  return [pays.length ? 'pays ' + listJoin(pays) : '', gets.length ? 'gets ' + listJoin(gets) : ''].filter(Boolean).join(' and ');
}

/* ---------- where the money on an arrow comes from ---------- */

/* A piece of an arrow can have been sent to another payee more than once ("swap payees"). What matters to
   the reader is who it was owed to at first and who it is owed to now, so swaps that follow each other
   count as one, and as none when the money is back with the payee it started with. Pieces that then tell
   the same story are added together. Largest first; the amounts still add up to the arrow. */
export function tidyPieces(pieces) {
  const merged = new Map();
  pieces.forEach(p => {
    const redirects = [];
    p.redirects.forEach(r => {
      const prev = redirects[redirects.length - 1];
      if (!prev || prev.to !== r.from) redirects.push({ from: r.from, to: r.to });
      else if (prev.from === r.to) redirects.pop();
      else prev.to = r.to;
    });
    const story = JSON.stringify([p.bill, p.debtor, p.creditor, p.via, redirects]);
    const same = merged.get(story);
    if (same) same.amount += p.amount; else merged.set(story, { ...p, redirects });
  });
  return [...merged.values()].sort((a, b) => b.amount - a.amount);
}

// How a piece started: as someone's share of a bill, or as a payment between two people.
function pieceLead(w, p) {
  const x = w.billOf(p.bill);
  if (x && x.e.kind === 'payment') {
    // A payment's name often says it all already ("Cy paid Ana back"). Only another name needs the words.
    const said = w.raw(p.creditor) + ' paid ' + w.raw(p.debtor);
    return w.title(p.bill) + (x.e.title === said || x.e.title === said + ' back' ? '' : ': ' + esc(said) + ' back');
  }
  return `${w.name(p.debtor)}’s share of ${w.title(p.bill)}, paid by ${w.name(p.creditor)}`;
}

// A later debt the money was passed along: the middle person owed it onward.
function viaLine(w, h) {
  const x = w.billOf(h.bill);
  return x && x.e.kind === 'payment'
    ? `Passed on via ${w.name(h.from)}, who got money from ${w.name(h.to)} (${w.title(h.bill)}).`
    : `Passed on via ${w.name(h.from)}, who owed ${w.name(h.to)} for ${w.title(h.bill)}.`;
}

const redirectLine = (w, r) => `Now goes to ${w.name(r.to)} instead of ${w.name(r.from)}, which saves a payment. Everyone’s totals stay the same.`;

// What already came off an arrow, and why.
function noteLine(w, from, n) {
  if (n.kind === 'net') {
    const bills = n.bills.length ? ' (' + n.bills.map(w.title).join(', ') + ')' : '';
    return `Already lowered by ${w.money(n.amount)} that ${w.name(n.other)} owed ${w.name(from)}${bills}. Those cancelled out.`;
  }
  const ring = n.ring.slice(0, -1).map(w.name).join(', ') + ', back to ' + w.name(n.ring[n.ring.length - 1]);
  return `Already lowered by ${w.money(n.amount)} from a loop (${ring}) that cancelled out.`;
}

/* The breakdown of one arrow at one step, as the markup inside a .breakdown: an optional head line
   ("Dee owes Eli" and the amount), one row per piece, then what already came off the arrow. */
export function arrowBreakdown(steps, group, stepIndex, key, withHead) {
  const w = wordsOf(steps, group), b = edgeBreakdown(steps, stepIndex, key);
  const pieces = tidyPieces(b.pieces), rest = pieces.slice(MAX_PIECES);
  const rows = pieces.slice(0, MAX_PIECES).map(p => rowHTML(w.money(p.amount), pieceLead(w, p) + origNote(w, p.bill),
    [...p.via.map(h => viaLine(w, h)), ...p.redirects.map(r => redirectLine(w, r))]));
  if (rest.length) {
    rows.push(rowHTML(w.money(rest.reduce((sum, p) => sum + p.amount, 0)), 'From ' + plural(rest.length, 'smaller piece', 'smaller pieces'), []));
  }
  return (withHead ? headHTML(`${w.name(b.from)} owes ${w.name(b.to)}`, w.money(b.total)) : '') +
    `<ul class="breakdown__rows">${rows.join('')}</ul>` +
    b.notes.map(n => `<p class="breakdown__note">${noteLine(w, b.from, n)}</p>`).join('');
}

// The one line on a settle card that names the bills behind the payment, largest part first.
export function billsLine(steps, group, key) {
  const w = wordsOf(steps, group);
  const ids = [...new Set(tidyPieces(edgeBreakdown(steps, steps.length - 1, key).pieces).map(p => p.bill))];
  const named = ids.length > MAX_NAMED ? ids.slice(0, MAX_NAMED - 1) : ids;
  const titles = named.map(w.rawTitle);
  if (ids.length > named.length) titles.push(ids.length - named.length + ' more bills');
  return titles.length ? 'For ' + listJoin(titles) + '.' : '';
}

/* ---------- one person ---------- */

/* One person's bills, as the markup inside a .breakdown: an optional head line (the name and "gets $12.00"),
   one row per bill with what they paid and their share, then the totals and what the plan asks of them. */
export function personDetail(steps, group, id, withHead) {
  const w = wordsOf(steps, group), b = personBreakdown(steps, group, id), name = w.name(id);
  const head = withHead ? headHTML(name, balanceWords(w, b.net)) : '';
  if (!b.rows.length) return head + '<p class="mute">Not on any bill yet.</p>';
  const rows = b.rows.map(r => {
    const e = w.billOf(r.bill).e;
    const facts = r.isPayment
      ? [r.paid ? `Paid ${w.money(r.paid)} to ${w.name(e.to)}.` : `Got ${w.money(r.share)} from ${w.name(e.from)}.`]
      : [r.paid ? `Paid ${w.money(r.paid)}.` : '', r.share ? `Share ${w.money(r.share)}.` : ''];
    return rowHTML(esc(signedMoney(r.net, w.cur)), w.title(r.bill) + origNote(w, r.bill), [facts.filter(Boolean).join(' ')]);
  });
  const plan = planWords(w, b.plan, w.money);
  return head + `<ul class="breakdown__rows">${rows.join('')}</ul>` +
    `<p class="breakdown__note">Paid ${w.money(b.paid)} in all, share ${w.money(b.share)}.` +
    (plan ? ` In the plan ${name} ${plan}.` : ' Nothing to pay or get.') + '</p>';
}

/* The trail of the person being followed: what they paid and owe in one sentence, then every step that
   involves them as a button that jumps to it. */
export function trailHTML(steps, group, id) {
  const w = wordsOf(steps, group), b = personBreakdown(steps, group, id), name = w.name(id);
  const amount = v => `<span class="amt">${w.money(v)}</span>`;
  const result = b.net > 0 ? `${name} gets back ${amount(b.net)}` : b.net < 0 ? `${name} owes ${amount(-b.net)}` : `${name} is even`;
  const plan = planWords(w, b.plan, amount);
  const sentence = `${name} paid ${amount(b.paid)} and ${name}’s share of everything is ${amount(b.share)}, so ${result}.` +
    (plan ? ` In the plan ${name} ${plan}.` : '');
  const items = steps.map((s, i) => (s.people.has(id)
    ? `<li><button type="button" class="trail__step" data-step="${i}"><span class="trail__n">${i}</span><span>${esc(PHASES[s.phase].label + ': ' + s.title)}</span></button></li>`
    : '')).join('');
  return `<h4 class="title">Following ${name}</h4><p>${sentence}</p>` + (items ? `<ol class="trail__list">${items}</ol>` : '');
}

/* ---------- the result ---------- */

const hasBills = steps => [...steps.bills.values()].some(x => !x.r.err);
const dimmed = (focus, ...ids) => !!focus && !ids.includes(focus);

// The one sentence above the settle cards.
export function statementOf(steps) {
  const n = finalPayments(steps).length;
  if (n) return n === 1 ? '1 payment settles everything.' : n + ' payments settle everything.';
  return hasBills(steps) ? 'Everyone is even.' : 'Add a bill to see who pays whom.';
}

// "17 debts become 4 payments.", or '' while there are no debts.
export function summaryOf(steps) {
  const n = finalPayments(steps).length;
  if (!steps.rawCount) return '';
  return plural(steps.rawCount, 'debt becomes', 'debts become') + ' ' + (n ? plural(n, 'payment', 'payments') : 'nothing to pay') + '.';
}

// "In USD. Rates of 4 Oct 2026.": the currency of the plan and where its exchange rates come from.
export function ratesNote(steps, group) {
  const said = new Set();
  steps.bills.forEach(({ r }) => {
    if (r.err || r.rateSource === 'same') return;
    said.add(r.rateSource === 'pinned' ? 'rates of ' + fmtDate(r.rateDate)
      : r.rateSource === 'builtin' ? 'built-in rates of ' + fmtDate(r.rateDate)
      : r.rateSource === 'manual' ? 'rates typed for this group' : 'rates set on single bills');
  });
  const text = listJoin([...said]);
  return 'In ' + group.currency + '.' + (text ? ' ' + text[0].toUpperCase() + text.slice(1) + '.' : '');
}

// The plan as plain text, for pasting into a chat: the group's name, then one line per payment.
export function planText(steps, group) {
  const w = wordsOf(steps, group);
  return [group.name + ': settle up', ...finalPayments(steps).map(([a, b, v]) => `${w.raw(a)} pays ${w.raw(b)} ${formatMoney(v, w.cur)}`)].join('\n');
}

/* The settle cards, one per payment of the plan. `open` holds the keys ('from>to') of the cards that are
   open, `focus` the person being followed or ''. With bills but nothing to pay it is one line of text. */
export function cardsHTML(steps, group, open, focus) {
  const w = wordsOf(steps, group), last = steps.length - 1, plan = finalPayments(steps);
  if (!plan.length) return hasBills(steps) ? '<p class="empty">Nobody owes anybody.</p>' : '';
  return plan.map(([a, b, v]) => {
    const key = edgeKey(a, b), isOpen = open.has(key), line = esc(billsLine(steps, group, key));
    return `<article class="card${isOpen ? ' is-open' : ''}${dimmed(focus, a, b) ? ' is-dim' : ''}" data-key="${esc(key)}">` +
      `<div class="card__top"><p class="card__amount">${w.money(v)}</p><p class="card__who">${w.name(a)} → ${w.name(b)}</p></div>` +
      '<div class="card__panel"><div class="card__summary">' +
      `<h3 class="title title--dash"><button type="button" class="card__toggle" aria-expanded="${isOpen}">${w.name(a)} pays ${w.name(b)}</button></h3>` +
      `<p class="card__line" title="${line}">${line}</p></div>` +
      `<div class="breakdown">${arrowBreakdown(steps, group, last, key, false)}</div></div></article>`;
  }).join('');
}

// What each person paid, their share and their net, in the group's order. The net is what the plan settles,
// and it is exactly paid minus share.
export function totalsRows(steps, group) {
  return group.people.map(p => {
    const b = personBreakdown(steps, group, p.id);
    return { id: p.id, name: p.name, paid: b.paid, share: b.share, net: b.net };
  });
}

// The line above the totals table.
export const totalsNote = code => `In ${code}. Net is paid minus share. A plus means they get money back.`;

// The row that opens under a person's row of the totals table: their bills.
export function totalsMoreHTML(steps, group, id) {
  return `<tr class="total__more"><td colspan="4"><div class="breakdown">${personDetail(steps, group, id, false)}</div></td></tr>`;
}

// The body of the totals table. `open` holds the ids of the people whose row is open.
export function totalsHTML(steps, group, rows, open, focus) {
  const cur = group.currency;
  if (!rows.length) return '<tr class="empty"><td colspan="4">No people yet.</td></tr>';
  return rows.map(r => {
    const isOpen = open.has(r.id), cell = text => `<td class="num">${esc(text)}</td>`;
    return `<tr class="total${dimmed(focus, r.id) ? ' is-dim' : ''}" data-id="${esc(r.id)}">` +
      `<th scope="row"><button type="button" class="total__open" aria-expanded="${isOpen}">${esc(r.name)}</button></th>` +
      cell(formatMoney(r.paid, cur)) + cell(formatMoney(r.share, cur)) + cell(signedMoney(r.net, cur)) + '</tr>' +
      (isOpen ? totalsMoreHTML(steps, group, r.id) : '');
  }).join('');
}

/* ---------- phases, timing, placing ---------- */

// For each of the seven phases: its first step (-1 if this run has none) and whether anything moves in it.
export function phaseStates(steps) {
  return PHASES.map((_, phase) => ({
    first: steps.findIndex(s => s.phase === phase),
    moves: phase === 0 || phase === 6 || steps.some(s => s.phase === phase && !!s.hl.kind)
  }));
}

// How long a step takes to draw and how long it then stays, in ms. A step that moves money along a
// path takes longer; a step that only says "nothing to do here" stays shorter.
export const stepDuration = (step, speed) => (step.hl.path ? 2300 : 1300) / speed;
export const stepHold = (step, speed) => (!step.hl.kind && step.phase > 0 && step.phase < 6 ? 1100 : 2600) / speed;

/* Where the floating breakdown goes: just right of and below the pointer, to the left of it when the
   right side has no room, and always inside the band. Every number is in px from the band's corner. */
export function panelSpot(px, py, boxW, boxH, w, h) {
  const x = px + 16 + w > boxW - 8 ? px - w - 16 : px + 16;
  const y = py + 16 + h > boxH - 8 ? boxH - h - 8 : py + 16;
  return { x: clamp(x, 8, Math.max(8, boxW - w - 8)), y: Math.max(8, y) };
}

/* The player: which step is on screen and when the next one comes. It draws nothing itself.
     draw(t)     asked for a frame: t from 0 to 1 while moving from step `from` to step `index`, 1 at rest
     changed()   told after the step on screen or the playing state changed
     still()     true when steps must jump instead of move (reduced motion)
     speed()     1 is normal
   frame, now, later and cancel stand in for requestAnimationFrame, performance.now, setTimeout and
   clearTimeout in tests. A frame is only asked for while a step is moving, a timer only while playing. */
export function createPlayer(env) {
  const { draw, changed, still, speed } = env;
  const frame = env.frame || (fn => requestAnimationFrame(fn));
  const now = env.now || (() => performance.now());
  const later = env.later || ((fn, ms) => setTimeout(fn, ms));
  const cancel = env.cancel || (id => clearTimeout(id));
  let steps = [], index = 0, playing = false, anim = null, timer = 0, asked = false;

  // After a step has been shown for a while, the next one comes, or playing ends at the last one.
  function wait() {
    cancel(timer);
    timer = later(() => { if (index < steps.length - 1) goTo(index + 1, true); else play(false); }, stepHold(steps[index], speed()));
  }

  function tick(time) {
    asked = false;
    if (!anim) return;
    const t = clamp((time - anim.start) / anim.dur, 0, 1);
    if (t < 1) {
      draw(t);
      asked = true;
      frame(tick);
      return;
    }
    anim = null;
    draw(1);
    if (playing) wait();
  }

  // Only a move to the very next step is animated; every other move is a jump.
  function goTo(n, animate) {
    cancel(timer);
    const from = index;
    index = clamp(n, 0, steps.length - 1);
    if (animate && index === from + 1 && !still()) {
      anim = { from, start: now(), dur: stepDuration(steps[index], speed()) };
      if (!asked) { asked = true; frame(tick); }
    } else {
      anim = null;
      draw(1);
      if (playing) wait();
    }
    changed();
  }

  function play(on) {
    if (playing === on) return;
    playing = on;
    if (!on) cancel(timer);
    else if (index >= steps.length - 1) { goTo(0, false); return; }   // at the end: start over
    else if (!anim) { goTo(index + 1, true); return; }
    changed();
  }

  return {
    get index() { return index; },
    get from() { return anim ? anim.from : index; },   // the step the picture is moving away from
    get moving() { return anim !== null; },
    get playing() { return playing; },
    // New steps: stop, and stand on the last one, the settled result. The caller draws.
    load(list) {
      cancel(timer);
      steps = list;
      index = list.length - 1;
      playing = false;
      anim = null;
    },
    goTo, play
  };
}

/* ---------- the page ---------- */

export function initStage(store) {
  const $ = id => document.getElementById(id);
  const section = $('graph'), box = $('graph-box'), svg = $('graph-svg'), panel = $('graph-panel');
  const controls = $('controls'), prevBtn = $('step-prev'), playBtn = $('step-play'), nextBtn = $('step-next');
  const speedSel = $('speed'), followSel = $('follow'), modeBtns = [$('mode-fewest'), $('mode-keep')];
  const phases = $('phases'), check = $('step-check'), trail = $('trail');
  const cards = $('settle-cards'), totals = $('totals-body'), copyBtn = $('plan-copy');
  const stillMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const hover = { key: '', node: '', pinned: false, x: 0, y: 0 };   // what the floating breakdown is about
  const openCards = new Set(), openTotals = new Set(), shown = new Map();
  let group, steps, layout, size, focus = '', speed = 1, firstOf = [];

  // Text and markup are only written when they change. Otherwise the narration would be read aloud again
  // after every edit, and a button with the keyboard focus or under the pointer would be thrown away.
  const put = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  const fill = (el, html) => {
    if (shown.get(el) === html) return;
    shown.set(el, html);
    el.innerHTML = html;
  };
  const mark = (el, on) => {
    el.classList.toggle('is-current', on);
    if (on) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
  };
  // PREVIOUS is off at the first step and NEXT at the last. The one that is switched off while it has the
  // keyboard focus hands the focus to the other, which is switched on first.
  const setEnds = (first, last) => {
    if (!first) prevBtn.disabled = false;
    if (!last) nextBtn.disabled = false;
    if (first && document.activeElement === prevBtn) nextBtn.focus();
    if (last && document.activeElement === nextBtn) prevBtn.focus();
    prevBtn.disabled = first;
    nextBtn.disabled = last;
  };

  const player = createPlayer({ draw, changed: renderStep, still: () => stillMotion.matches, speed: () => speed });

  /* ---------- drawing ---------- */

  const sizeOf = () => (box.clientWidth > 0 && box.clientWidth < NARROW_BELOW ? 'narrow' : 'wide');

  function relayout() {
    layout = layoutFor(group.people.map(p => p.id), size);
    svg.setAttribute('viewBox', `0 0 ${layout.w} ${layout.h}`);
  }

  function draw(t) {
    const step = steps[player.index];
    svg.innerHTML = graphSVG({ group, layout, prev: steps[player.from].g, next: step.g, t, step,
      maxV: steps.maxV, focus, hoverKey: hover.key, hoverNode: hover.node });
  }

  // The picture at rest. While a step is moving, the next frame picks the change up by itself.
  const redraw = () => { if (!player.moving) draw(1); };

  /* ---------- the floating breakdown ---------- */

  function placePanel() {
    const spot = panelSpot(hover.x, hover.y, box.clientWidth, box.clientHeight, panel.offsetWidth, panel.offsetHeight);
    panel.style.left = spot.x + 'px';
    panel.style.top = spot.y + 'px';
  }

  function fillPanel() {
    fill(panel, CLOSE + (hover.key ? arrowBreakdown(steps, group, player.index, hover.key, true) : personDetail(steps, group, hover.node, true)));
  }

  function showPanel(hit, e, pin) {
    const corner = box.getBoundingClientRect();
    Object.assign(hover, hit, { pinned: pin, x: e.clientX - corner.left, y: e.clientY - corner.top });
    panel.classList.toggle('is-pinned', pin);
    fillPanel();
    panel.hidden = false;
    placePanel();
    redraw();
    if (pin) panel.scrollIntoView({ block: 'nearest' });
  }

  function hidePanel() {
    if (panel.hidden) return;
    Object.assign(hover, { key: '', node: '', pinned: false });
    panel.hidden = true;
    redraw();
  }

  // After the step or the data changed: the same arrow or person as it is now, or nothing if it is gone.
  function refreshPanel() {
    if (panel.hidden) return;
    const gone = hover.key ? !steps[player.index].g.has(hover.key) : !store.person(hover.node);
    if (gone) { hidePanel(); return; }
    fillPanel();
    placePanel();
  }

  // The arrow or person an element of the drawing belongs to, or null.
  function hitOf(el) {
    const mine = el && svg.contains(el) ? el.closest('[data-key],[data-node]') : null;
    return mine ? { key: mine.dataset.key || '', node: mine.dataset.node || '' } : null;
  }

  /* ---------- what is written on the page ---------- */

  function markTrail() {
    trail.querySelectorAll('[data-step]').forEach(b => mark(b, +b.dataset.step === player.index));
  }

  function renderTrail() {
    trail.hidden = !focus;
    fill(trail, focus ? trailHTML(steps, group, focus) : '');
    markTrail();
  }

  // Everything that follows the step on screen.
  function renderStep() {
    const i = player.index, last = steps.length - 1, step = steps[i];
    put($('step-count'), i + ' / ' + last);
    put(playBtn, player.playing ? 'Pause' : 'Play');
    setEnds(i === 0, i === last);
    put($('step-phase'), `Step ${i} of ${last} · ${PHASES[step.phase].label}`);
    put($('step-title'), step.title);
    fill($('step-text'), step.text);   // trusted markup from simplify.js
    check.hidden = !(step.phase >= 2 && steps.rawCount);
    [...phases.children].forEach((b, phase) => mark(b, phase === step.phase));
    markTrail();
    refreshPanel();
  }

  // Everything that follows the plan: the statement, the settle cards and the totals table.
  function renderResult() {
    const rows = totalsRows(steps, group), plan = finalPayments(steps);
    const keys = new Set(plan.map(([a, b]) => edgeKey(a, b)));
    openCards.forEach(key => { if (!keys.has(key)) openCards.delete(key); });
    openTotals.forEach(id => { if (!store.person(id)) openTotals.delete(id); });
    put($('graph-summary'), summaryOf(steps));
    put($('statement'), statementOf(steps));
    put($('settle-note'), ratesNote(steps, group));
    put($('totals-note'), totalsNote(group.currency));
    fill(cards, cardsHTML(steps, group, openCards, focus));
    fill(totals, totalsHTML(steps, group, rows, openTotals, focus));
    copyBtn.disabled = !plan.length;
  }

  // The controls that show a setting of this device: mode, speed and who is followed.
  function syncControls() {
    const ui = store.ui;
    focus = ui.focus;
    modeBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === ui.mode)));
    put(modeNote, MODE_NOTES[ui.mode]);
    speedSel.value = String(ui.speed);
    if (speedSel.selectedIndex < 0) speedSel.value = '1';
    speed = Number(speedSel.value);
    fill(followSel, '<option value="">Everyone</option>' + group.people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''));
    followSel.value = focus;
  }

  // New steps (the bills, the group or the mode changed): show the last one, the settled result, at rest.
  function rebuild() {
    group = store.group;
    steps = store.steps;
    player.load(steps);
    syncControls();
    relayout();
    const states = phaseStates(steps);
    firstOf = states.map(s => s.first);
    [...phases.children].forEach((b, phase) => {
      b.classList.toggle('is-empty', !states[phase].moves);
      b.disabled = states[phase].first < 0;
    });
    fill(check, steps.ok ? CHECK_OK : CHECK_BAD);
    draw(1);
    renderStep();
    renderResult();
    renderTrail();
  }

  // Someone else is followed: the picture, the cards and the table dim the rest, and the trail changes.
  function refocus() {
    redraw();
    cards.querySelectorAll('.card').forEach(c => c.classList.toggle('is-dim', dimmed(focus, ...c.dataset.key.split('>'))));
    totals.querySelectorAll('.total').forEach(r => r.classList.toggle('is-dim', dimmed(focus, r.dataset.id)));
    renderTrail();
  }

  /* ---------- copy plan ---------- */

  // Where the browser does not let the page copy, the plan is shown selected, to be copied by hand.
  function showPlan(text) {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal modal--small';
    dialog.setAttribute('aria-labelledby', 'plan-title');
    dialog.innerHTML = '<div class="modal__head"><h2 class="title" id="plan-title">Copy plan</h2><button type="button" class="x" data-close aria-label="Close"></button></div>' +
      '<div class="modal__body share"><p>This browser did not allow copying. The plan is selected, so you can copy it by hand.</p>' +
      '<textarea rows="8" readonly aria-label="The plan"></textarea></div>';
    const field = dialog.querySelector('textarea');
    field.value = text;
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    field.select();
  }

  copyBtn.addEventListener('click', async () => {
    const text = planText(steps, group);
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy plan'; }, 1600);
    } catch {
      showPlan(text);
    }
  });

  /* ---------- the player's buttons and keys ---------- */

  const jump = (n, animate) => { player.play(false); player.goTo(n, animate); };

  prevBtn.addEventListener('click', () => jump(player.index - 1, false));
  nextBtn.addEventListener('click', () => jump(player.index + 1, true));
  playBtn.addEventListener('click', () => player.play(!player.playing));
  speedSel.addEventListener('change', () => store.setUI({ speed: Number(speedSel.value) }));
  followSel.addEventListener('change', () => store.setUI({ focus: followSel.value }));
  modeBtns.forEach(b => b.addEventListener('click', () => store.setUI({ mode: b.dataset.mode })));

  phases.addEventListener('click', e => {
    const b = e.target.closest('[data-phase]');
    if (b) jump(firstOf[+b.dataset.phase], false);
  });

  trail.addEventListener('click', e => {
    const b = e.target.closest('[data-step]');
    if (b) jump(+b.dataset.step, false);
  });

  /* Left and right arrow: one step back or on, while the graph is on screen and the keys are not needed
     for typing or choosing. Home and End: the first and the last step, from the strip and the phase links
     only, because anywhere else they move the page. Escape closes the floating breakdown. */
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') { hidePanel(); return; }
    const at = e.target instanceof Element ? e.target : null;
    if (at && at.closest('input, select, textarea, [contenteditable]')) return;
    const inStrip = !!at && (controls.contains(at) || phases.contains(at));
    const to = e.key === 'ArrowRight' ? player.index + 1 : e.key === 'ArrowLeft' ? player.index - 1
      : inStrip && e.key === 'Home' ? 0 : inStrip && e.key === 'End' ? steps.length - 1 : -1;
    const place = section.getBoundingClientRect();
    if (to < 0 || to >= steps.length || place.bottom <= 0 || place.top >= innerHeight) return;
    e.preventDefault();
    jump(to, e.key === 'ArrowRight');
  });

  /* ---------- pointing at the drawing ---------- */

  svg.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || hover.pinned) return;
    const hit = hitOf(e.target);
    if (!hit) { hidePanel(); return; }
    if (!panel.hidden && hit.key === hover.key && hit.node === hover.node) {
      const corner = box.getBoundingClientRect();
      hover.x = e.clientX - corner.left;
      hover.y = e.clientY - corner.top;
      placePanel();
      return;
    }
    // On a narrow page the panel sits under the drawing, and opening it on hover would make the page jump.
    if (getComputedStyle(panel).position === 'absolute') showPanel(hit, e, false);
  });

  svg.addEventListener('pointerleave', () => { if (!hover.pinned) hidePanel(); });

  /* A click or tap pins the breakdown; a click on nothing closes it. The drawing is replaced on every
     frame, so what was pressed may be gone when the click arrives: then the pointer's place decides. */
  svg.addEventListener('click', e => {
    const hit = hitOf(e.target) || hitOf(document.elementFromPoint(e.clientX, e.clientY));
    if (hit) showPanel(hit, e, true); else hidePanel();
  });

  panel.addEventListener('click', e => { if (e.target.closest('.breakdown__close')) hidePanel(); });

  /* ---------- settle cards and totals rows open and close ---------- */

  cards.addEventListener('click', e => {
    const card = e.target.closest('.card');
    if (!card || e.target.closest('.breakdown')) return;
    const key = card.dataset.key, open = !openCards.has(key);
    if (open) openCards.add(key); else openCards.delete(key);
    card.classList.toggle('is-open', open);
    card.querySelector('.card__toggle').setAttribute('aria-expanded', String(open));
  });

  totals.addEventListener('click', e => {
    const row = e.target.closest('.total');
    if (!row) return;
    const id = row.dataset.id, open = !openTotals.has(id), more = row.nextElementSibling;
    if (open) openTotals.add(id); else openTotals.delete(id);
    row.querySelector('.total__open').setAttribute('aria-expanded', String(open));
    if (open) row.insertAdjacentHTML('afterend', totalsMoreHTML(steps, group, id));
    else if (more && more.classList.contains('total__more')) more.remove();
  });

  /* ---------- start ---------- */

  // The one line that says what the chosen mode means sits under the narration.
  const modeNote = document.createElement('p');
  modeNote.className = 'mute';
  check.after(modeNote);
  modeBtns.forEach(b => { b.title = MODE_NOTES[b.dataset.mode]; });

  phases.innerHTML = PHASES.map((p, i) => `<button type="button" class="phase" data-phase="${i}" data-text="${esc(p.label)}">${esc(p.label)}</button>`).join('');

  size = sizeOf();
  rebuild();

  store.subscribe(rebuild);
  store.subscribeUI(keys => {
    if (keys.includes('mode')) { rebuild(); return; }
    syncControls();
    if (keys.includes('focus')) refocus();
  });

  // The picture for phones is narrower and taller; which one fits depends on the width of the band.
  new ResizeObserver(() => {
    const next = sizeOf();
    if (next !== size) {
      size = next;
      relayout();
      redraw();
    }
    if (!panel.hidden) placePanel();
  }).observe(box);
}
