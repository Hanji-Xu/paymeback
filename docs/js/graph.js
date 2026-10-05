/* Pay Me Back picture: where each person sits, and the SVG markup for one frame of the debt graph.
   Pure string building, no DOM. Colours and type sizes live in section 20 of css/style.css.
   Every name, title and id is escaped before it goes into the markup. */

import { esc, formatMoney } from './core.js';

/* ---------- layout ---------- */

const WIDE = { w: 720, h: 480, r: 24, rx: 200, ry: 170, pair: 170 };
// For phones: a smaller picture with smaller circles and a tighter ring, so text keeps its size on screen.
const NARROW = { w: 400, h: 440, r: 20, rx: 120, ry: 156, pair: 110 };

const EDGE = 4;        // clear space kept inside the picture's border
const NAME_H = 28;     // height of a name with its balance line under it
const MIN_ROOM = 96;   // width a balance line may need, e.g. "owes $1,234.56"

// People sit on a ring, the first one at the top. (ox, oy) points away from the centre: names go that way.
export function layoutFor(ids, size) {
  const { w, h, r, rx, ry, pair } = size === 'narrow' ? NARROW : WIDE;
  const cx = w / 2, cy = h / 2, n = ids.length, pos = new Map();
  if (n === 1) pos.set(ids[0], { x: cx, y: cy, ox: 0, oy: 1 });
  else if (n === 2) {
    pos.set(ids[0], { x: cx - pair, y: cy, ox: -1, oy: 0 });
    pos.set(ids[1], { x: cx + pair, y: cy, ox: 1, oy: 0 });
  } else {
    ids.forEach((id, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n, ox = Math.cos(a), oy = Math.sin(a);
      pos.set(id, { x: cx + rx * ox, y: cy + ry * oy, ox, oy });
    });
  }
  return { w, h, r, pos };
}

/* ---------- small helpers ---------- */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const f1 = n => n.toFixed(1);

// Text cannot be measured without a DOM, so widths are estimated per character, in em.
const charEm = ch => {
  const c = ch.codePointAt(0);
  if (c > 0x2e7f) return 1;                    // Chinese, Japanese, Korean, emoji
  if (c >= 65 && c <= 90) return 0.72;         // capitals
  return /[.,'’\s]/.test(ch) ? 0.3 : 0.58;     // dots, commas and spaces are thin
};
const textWidth = (s, px) => {
  let em = 0;
  for (const ch of s) em += charEm(ch);
  return em * px;
};

// Cuts text to an estimated width and marks the cut with "…".
const fit = (s, max, px) => {
  if (textWidth(s, px) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (textWidth(out + ch + '…', px) > max) break;
    out += ch;
  }
  return out.trimEnd() + '…';
};

export function initials(name) {
  const parts = String(name == null ? '' : name).trim().split(/\s+/).map(p => Array.from(p));
  const two = parts.length > 1 ? [parts[0][0], parts[1][0]] : parts[0].slice(0, 2);
  return two.join('').toUpperCase();
}

const balanceLine = (bal, code) =>
  (bal > 0 ? 'gets ' + formatMoney(bal, code) : bal < 0 ? 'owes ' + formatMoney(-bal, code) : 'even');

// Net position of each person in a graph Map ('a>b' means a owes b): positive = is owed money.
const balances = g => {
  const out = new Map();
  g.forEach((v, key) => {
    const [a, b] = key.split('>');
    out.set(a, (out.get(a) || 0) - v);
    out.set(b, (out.get(b) || 0) + v);
  });
  return out;
};

/* ---------- arrow geometry ---------- */

// A gently bent curve from a to b, stopping short of both circles. Opposite arrows bend opposite ways.
const geom = (layout, a, b) => {
  const pa = layout.pos.get(a), pb = layout.pos.get(b);
  const dx = pb.x - pa.x, dy = pb.y - pa.y, d = Math.hypot(dx, dy) || 1;
  const bend = Math.min(48, d * 0.13);
  const c = { x: (pa.x + pb.x) / 2 - dy / d * bend, y: (pa.y + pb.y) / 2 + dx / d * bend };
  const trim = (p, by) => {
    const vx = c.x - p.x, vy = c.y - p.y, l = Math.hypot(vx, vy) || 1;
    return { x: p.x + vx / l * by, y: p.y + vy / l * by };
  };
  return { p0: trim(pa, layout.r + 2), c, p2: trim(pb, layout.r + 6) };
};

const bez = (G, t) => {
  const u = 1 - t;
  return { x: u * u * G.p0.x + 2 * u * t * G.c.x + t * t * G.p2.x, y: u * u * G.p0.y + 2 * u * t * G.c.y + t * t * G.p2.y };
};

// The first part [0, t] of a curve, for an arrow that is still growing.
const subBez = (G, t) => ({
  p0: G.p0,
  c: { x: G.p0.x + (G.c.x - G.p0.x) * t, y: G.p0.y + (G.c.y - G.p0.y) * t },
  p2: bez(G, t)
});

const pathD = G => `M${f1(G.p0.x)},${f1(G.p0.y)} Q${f1(G.c.x)},${f1(G.c.y)} ${f1(G.p2.x)},${f1(G.p2.y)}`;

// One arrowhead per colour, because a marker cannot take its colour from the line that uses it.
const MARKERS = '<defs>' + ['ink', 'mute'].map(k =>
  `<marker id="g-ah-${k}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="11" markerHeight="11" ` +
  `markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="g-mk-${k}" d="M0,0 L10,5 L0,10 z"></path></marker>`
).join('') + '</defs>';

/* ---------- people ---------- */

// Where a name and its balance line go: outwards from the ring when there is room, otherwise above or
// below the circle, starting at the circle's inner edge so the text stays clear of the arrows.
const nameSpot = (layout, P, need) => {
  const { w, r } = layout, reach = r * 1.5 + 2;
  const lx = P.x + P.ox * reach, ly = P.y + P.oy * reach;
  const side = P.ox > 0.35 ? 1 : P.ox < -0.35 ? -1 : 0;
  const top = P.oy > 0.35 ? ly : P.oy < -0.35 ? ly - NAME_H : ly - NAME_H / 2;
  const room = side > 0 ? w - EDGE - lx : side < 0 ? lx - EDGE : 2 * Math.min(lx - EDGE, w - EDGE - lx);
  if (!side || room >= need) return { x: lx, top, side, room };
  const stackTop = P.oy < 0 ? P.y - r - 5 - NAME_H : P.y + r + 5;
  const x = P.x - side * r, stackRoom = side > 0 ? w - EDGE - x : x - EDGE;
  if (stackRoom >= need) return { x, top: stackTop, side, room: stackRoom };
  return { x: side > 0 ? w - EDGE : EDGE, top: stackTop, side: -side, room: w - 2 * EDGE };   // flush with the border
};

// `f` is everything known about the frame being drawn; graphSVG builds it.
const drawPeople = f => {
  const { layout, code } = f, { pos, r, w } = layout;
  const balFrom = balances(f.from), balTo = balances(f.next);
  const inStep = f.step.phase > 0 && f.step.phase < 6 ? new Set(f.step.people || []) : new Set();
  const touchesFocus = id => f.live.has(id + '>' + f.focus) || f.live.has(f.focus + '>' + id);
  const boxes = [];
  const html = f.people.map(({ id, name }) => {
    const P = pos.get(id), was = balFrom.get(id) || 0, will = balTo.get(id) || 0;
    // The balance moves from its old value to its new one, so it stands still whenever a step only reroutes money.
    const bal = Math.round(was + (will - was) * f.amtT);
    const line = balanceLine(bal, code);
    // Room is judged by both ends of the move, so a label does not jump while the number changes.
    const need = Math.max(MIN_ROOM, textWidth(balanceLine(was, code), 11), textWidth(balanceLine(will, code), 11));
    const spot = nameSpot(layout, P, need);
    const shown = fit(String(name == null ? '' : name), Math.min(spot.room, 0.3 * w), 12);
    const width = Math.max(textWidth(shown, 12), textWidth(line, 11));
    const x0 = spot.side > 0 ? spot.x : spot.side < 0 ? spot.x - width : spot.x - width / 2;
    boxes.push({ x0: P.x - r, x1: P.x + r, y0: P.y - r, y1: P.y + r },
      { x0, x1: x0 + width, y0: spot.top, y1: spot.top + NAME_H });
    const hov = id === f.hoverNode;
    const cls = (bal > 0 ? 'is-get' : bal < 0 ? 'is-owe' : 'is-even') + (inStep.has(id) ? ' is-hl' : '') +
      (hov ? ' is-hov' : '') + (f.focus && id !== f.focus && !touchesFocus(id) ? ' is-dim' : '');
    const at = `x="${f1(spot.x)}" text-anchor="${spot.side > 0 ? 'start' : spot.side < 0 ? 'end' : 'middle'}"`;
    const centre = `cx="${f1(P.x)}" cy="${f1(P.y)}"`;
    return `<g class="g-node ${cls}" data-node="${esc(id)}"><circle class="g-disc" ${centre} r="${r}"></circle>` +
      (inStep.has(id) || hov ? `<circle class="g-ring" ${centre} r="${r - 3}"></circle>` : '') +
      `<text class="g-ini" x="${f1(P.x)}" y="${f1(P.y + 4)}" text-anchor="middle">${esc(initials(name))}</text>` +
      `<text class="g-name" ${at} y="${f1(spot.top + 10)}">${esc(shown)}</text>` +
      `<text class="g-bal" ${at} y="${f1(spot.top + 24)}">${esc(line)}</text></g>`;
  }).join('');
  return { html, boxes };
};

/* ---------- arrows ---------- */

// Every arrow to draw in this frame. Quiet ones come first, so the ones the step is about are painted on top.
const arrowsFor = (from, next, amtT, hlSet, pos) => {
  const list = [];
  new Set([...from.keys(), ...next.keys()]).forEach(key => {
    const [a, b] = key.split('>');
    if (a === b || !pos.has(a) || !pos.has(b)) return;
    const was = from.get(key) || 0, will = next.get(key) || 0;
    const v = Math.round(was + (will - was) * amtT);
    if (v <= 0 && was <= 0) return;
    const state = will > was ? 'on' : will < was ? 'down' : hlSet.has(key) ? 'on' : hlSet.size ? 'off' : 'plain';
    list.push({ key, a, b, v, state, isNew: was === 0 && from !== next });
  });
  const loud = e => (e.state === 'on' || e.state === 'down' ? 1 : 0);
  return list.sort((x, y) => loud(x) - loud(y));
};

const SPOTS = [0.5, 0.4, 0.6, 0.32, 0.68, 0.25, 0.75];

// How much of box p is covered by box q, counting a 2-unit gap around both as covered.
const covered = (p, q) =>
  Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) + 2) * Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0) + 2);

// Slides a label along its arrow until it clears the people and the labels placed before it.
// If no spot is clear, it takes the one that hides the least.
const placeLabel = (G, tw, lh, layout, taken) => {
  let best = null, least = Infinity;
  for (const t of SPOTS) {
    const c = bez(G, t);
    const x0 = clamp(c.x - tw / 2, 1, layout.w - 1 - tw), y0 = clamp(c.y - 9, 1, layout.h - 1 - lh);
    const box = { x0, x1: x0 + tw, y0, y1: y0 + lh };
    const hidden = taken.reduce((sum, o) => sum + covered(box, o), 0);
    if (hidden < least) { best = box; least = hidden; }
    if (!hidden) break;
  }
  taken.push(best);
  return best;
};

const drawLabel = (e, G, cap, mods, f, taken) => {
  const amount = formatMoney(e.v, f.code);   // always with its cents, like every other amount on the page
  const tw = Math.min(f.layout.w - 2, Math.max(textWidth(amount, 11), textWidth(cap, 10)) + 12), lh = cap ? 30 : 18;
  const box = placeLabel(G, tw, lh, f.layout, taken), mid = f1((box.x0 + box.x1) / 2);
  return `<g class="g-lbl is-${e.state}${mods}" data-key="${esc(e.key)}">` +
    `<rect x="${f1(box.x0)}" y="${f1(box.y0)}" width="${f1(tw)}" height="${lh}"></rect>` +
    `<text class="g-amt" x="${mid}" y="${f1(box.y0 + 13)}" text-anchor="middle">${esc(amount)}</text>` +
    (cap ? `<text class="g-cap" x="${mid}" y="${f1(box.y0 + 25)}" text-anchor="middle">${esc(cap)}</text>` : '') + '</g>';
};

const drawArrows = (arrows, f, taken) => {
  let strokes = '', hits = '', labels = '';
  arrows.forEach(e => {
    const G = geom(f.layout, e.a, e.b);
    const grow = e.isNew ? Math.max(0.02, f.amtT) : 1;
    const d = pathD(grow < 1 ? subBez(G, grow) : G);
    const hov = e.key === f.hoverKey;
    const mods = (hov ? ' is-hov' : '') + (f.focus && e.a !== f.focus && e.b !== f.focus ? ' is-dim' : '');
    const width = 1 + 5 * Math.sqrt(clamp(e.v / f.maxV, 0, 1)) + (hov ? 2 : e.state === 'on' ? 1 : 0);
    const head = grow >= 0.98 ? ` marker-end="url(#g-ah-${e.state === 'off' && !hov ? 'mute' : 'ink'})"` : '';
    strokes += `<path class="g-edge is-${e.state}${mods}${e.v > 0 ? '' : ' is-gone'}" d="${d}" stroke-width="${width.toFixed(2)}"${head}></path>`;
    if (e.v <= 0) return;
    hits += `<path class="g-hit" data-key="${esc(e.key)}" d="${d}" stroke-width="18"></path>`;
    if (grow >= 0.6) labels += drawLabel(e, G, f.caption && f.hlSet.has(e.key) ? f.caption : '', mods, f, taken);
  });
  return { strokes, hits, labels };
};

// The dot that travels along the path of a "loop" or "middleman" step.
const drawToken = (layout, path, phase) => {
  const segs = path.length - 1, at = phase * segs, i = Math.min(segs - 1, Math.floor(at));
  const p = bez(geom(layout, path[i], path[i + 1]), at - i);
  return `<circle class="g-token" cx="${f1(p.x)}" cy="${f1(p.y)}" r="5"></circle>`;
};

/* ---------- one frame ---------- */

/* opts = { group, layout, prev, next, t, step, maxV, focus, hoverKey, hoverNode }.
   Returns the inner markup of the <svg>. The picture moves from graph `prev` to graph `next` as t goes
   from 0 to 1; t = 1 (or prev === next) is the picture at rest. */
export function graphSVG(opts) {
  const { group, layout } = opts, pos = layout.pos;
  const people = (group.people || []).filter(p => pos.has(p.id));
  if (!people.length) {
    return `<text class="g-empty" x="${layout.w / 2}" y="${layout.h / 2}" text-anchor="middle">Add people to start.</text>`;
  }
  const step = opts.step || {}, hl = step.hl || {};
  const next = opts.next || new Map(), prev = opts.prev || next;
  const animating = prev !== next && opts.t < 1;
  const t = animating ? Math.max(0, opts.t) : 1;
  const from = animating ? prev : next;
  const path = hl.path && hl.path.length > 1 && hl.path.every(id => pos.has(id)) ? hl.path : null;
  // A step that moves money along a path plays in two parts: the dot travels first, then the amounts change.
  const amtT = !animating ? 1 : path ? ease(clamp((t - 0.4) / 0.6, 0, 1)) : ease(t);
  const hlSet = new Set((hl.edges || []).map(e => e[0] + '>' + e[1]));
  const arrows = arrowsFor(from, next, amtT, hlSet, pos);
  const f = {
    layout, people, step, from, next, amtT, hlSet,
    code: group.currency || 'USD',
    live: new Set(arrows.filter(e => e.v > 0).map(e => e.key)),   // keys of the arrows that carry money right now
    maxV: opts.maxV > 0 ? opts.maxV : 1,
    focus: pos.has(opts.focus) ? opts.focus : '',
    hoverKey: opts.hoverKey, hoverNode: opts.hoverNode,
    // While a bill arrives with only a few new arrows, each of them also carries the bill's name.
    caption: hl.kind === 'add' && hlSet.size <= 3 ? fit(String(hl.bill || ''), 100, 10) : ''
  };
  const persons = drawPeople(f);
  const drawn = drawArrows(arrows, f, persons.boxes);
  const token = animating && path && t < 0.5 ? drawToken(layout, path, t / 0.5) : '';
  // The dot goes under the amount labels, so every number stays readable while it passes.
  return MARKERS + drawn.strokes + drawn.hits + persons.html + token + drawn.labels;
}
