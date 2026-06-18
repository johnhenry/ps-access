// PC input bridge — pure, platform-agnostic mapping engine.
//
// Turns the Access Controller's live input (physical buttons + stick) into abstract
// output events (key/button down·up, relative mouse motion, gamepad axes). It does NO
// I/O: a "sink" (xdotool, uinput, dry-run…) turns these events into real OS input.
// This is the reusable heart of the bridge — read once, map anywhere.

// Physical input indices (matches web/controller-render.mjs decodePhysical):
//   0..7 = perimeter buttons, 8 = center, 9 = stick-click.
export const PHYS_BUTTONS = 10;

// Decode a raw input report (report id ALREADY stripped) into { buttons:Set, axes:[x,y] }.
// Mirrors decodePhysical: byte 15 bits 0-7 = perimeter; byte 16 bit0 = center, bit1 = stick-click;
// bytes 0/1 = stick X/Y (0..255, 128 center).
export function decodeInput(data, deadzone = 0.16) {
  const buttons = new Set();
  for (let bit = 0; bit < 8; bit++) if (data[15] & (1 << bit)) buttons.add(bit);
  if (data[16] & 0x01) buttons.add(8);
  if (data[16] & 0x02) buttons.add(9);
  const dz = (v) => (Math.abs(v) < deadzone ? 0 : v);
  return { buttons, axes: [dz((data[0] - 128) / 128), dz((data[1] - 128) / 128)] };
}

// A default, keyboard-oriented mapping: stick drives the arrow keys, the center button
// confirms (Enter), and the perimeter buttons cover space + common keys. Good for general
// PC access / navigation; override per game via a config file.
export const DEFAULT_MAPPING = {
  // physical index -> output key name (sink translates names to OS keysyms/codes)
  buttons: {
    0: "space", 1: "Return", 2: "Escape", 3: "BackSpace",
    4: "Tab", 5: "f", 6: "e", 7: "q",
    8: "Return",      // center
    9: "shift",       // stick-click
  },
  stick: { mode: "keys", up: "Up", down: "Down", left: "Left", right: "Right", threshold: 0.5 },
  mouse: { speed: 18, deadzone: 0.2 }, // used only when stick.mode === "mouse"
};

// The engine diffs successive input states and emits only the changes (edges), so a sink
// can hold keys/buttons down for as long as the physical input is held.
export class BridgeEngine {
  constructor(mapping = DEFAULT_MAPPING) {
    this.mapping = normalizeMapping(mapping);
    this.down = new Set();        // currently-asserted HELD output codes
    this.prevPhys = new Set();    // physical buttons last tick (for press-edge detection)
    // Classify each button's mapping: a held key, a chord ("ctrl+s"), or a macro (array).
    this.btnOut = {};
    for (const [idx, val] of Object.entries(this.mapping.buttons)) this.btnOut[idx] = parseOutput(val);
  }

  // Feed a decoded input state; returns an array of output events:
  //   { type:"key", code, action:"down"|"up" }      keyboard/button
  //   { type:"mouseMove", dx, dy }                   relative pointer motion
  //   { type:"axis", code:"x"|"y", value }           gamepad axis (-1..1)
  update(state) {
    const events = [];
    const want = new Set();          // HELD output codes that should be down this tick
    const m = this.mapping;

    // physical buttons -> output. Held keys stay down; chords/macros fire once on press edge.
    for (const idx of state.buttons) {
      const out = this.btnOut[idx];
      if (!out) continue;
      if (out.type === "hold") want.add(out.code);
      else if (!this.prevPhys.has(idx)) events.push(...expand(out)); // momentary, on press edge only
    }
    this.prevPhys = new Set(state.buttons);

    // stick -> keys / mouse / axis
    const [x, y] = state.axes;
    if (m.stick.mode === "keys") {
      const t = m.stick.threshold;
      if (x <= -t && m.stick.left) want.add(m.stick.left);
      if (x >= t && m.stick.right) want.add(m.stick.right);
      if (y <= -t && m.stick.up) want.add(m.stick.up);
      if (y >= t && m.stick.down) want.add(m.stick.down);
    } else if (m.stick.mode === "mouse") {
      const dz = m.mouse.deadzone, sp = m.mouse.speed;
      const ax = Math.abs(x) < dz ? 0 : x, ay = Math.abs(y) < dz ? 0 : y;
      if (ax || ay) events.push({ type: "mouseMove", dx: Math.round(ax * sp), dy: Math.round(ay * sp) });
    } else if (m.stick.mode === "axis") {
      events.push({ type: "axis", code: "x", value: x }, { type: "axis", code: "y", value: y });
    }

    // diff against what's currently held: emit ups for released, downs for newly pressed
    for (const code of this.down) if (!want.has(code)) { events.push({ type: "key", code, action: "up" }); }
    for (const code of want) if (!this.down.has(code)) { events.push({ type: "key", code, action: "down" }); }
    this.down = want;
    return events;
  }

  // Events to release everything still held (call on shutdown so no key gets "stuck").
  releaseAll() {
    const events = [...this.down].map((code) => ({ type: "key", code, action: "up" }));
    this.down = new Set();
    return events;
  }
}

// Classify a mapping value into how it should fire:
//   "a"           -> held while the button is held            { type:"hold", code:"a" }
//   "ctrl+s"      -> chord, fired once on press               { type:"chord", parts:["ctrl","s"] }
//   ["g","g"]     -> macro (sequence of chords), once on press{ type:"macro", steps:[["g"],["g"]] }
//   ["ctrl+c","ctrl+v"] -> macro of chords
export function parseOutput(value) {
  if (Array.isArray(value)) return { type: "macro", steps: value.map(toParts) };
  if (typeof value === "string" && value.includes("+")) return { type: "chord", parts: toParts(value) };
  return { type: "hold", code: String(value) };
}
function toParts(s) { return String(s).split("+").map((p) => p.trim()).filter(Boolean); }

// Expand a chord/macro into a burst of key down/up events (modifiers held around the key).
function expandChord(parts) {
  const ev = [];
  for (const p of parts) ev.push({ type: "key", code: p, action: "down" });
  for (let i = parts.length - 1; i >= 0; i--) ev.push({ type: "key", code: parts[i], action: "up" });
  return ev;
}
function expand(out) {
  if (out.type === "chord") return expandChord(out.parts);
  if (out.type === "macro") return out.steps.flatMap(expandChord);
  return [];
}

function normalizeMapping(mapping) {
  const m = mapping || {};
  return {
    buttons: { ...DEFAULT_MAPPING.buttons, ...(m.buttons || {}) },
    stick: { ...DEFAULT_MAPPING.stick, ...(m.stick || {}) },
    mouse: { ...DEFAULT_MAPPING.mouse, ...(m.mouse || {}) },
  };
}
