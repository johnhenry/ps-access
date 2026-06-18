// Helpers for the in-app Key Bridge editor — pure, I/O-free, testable.
//
// The editor lets you assign a keyboard key / chord to each physical input and the stick,
// then export a config the local `bridge.mjs` process runs. The browser can author and
// preview this, but cannot inject input into other apps (that's the local bridge's job).

import { DEFAULT_MAPPING } from "./bridge-core.mjs";

// Physical input labels (index 0..9), matching controller-render PHYS layout.
export const PHYS_LABELS = [
  "Button 1", "Button 2", "Button 3", "Button 4", "Button 5", "Button 6", "Button 7", "Button 8",
  "Center", "Stick-click",
];
export const STICK_MODES = ["keys", "mouse", "axis"];
export const STICK_DIRS = ["up", "down", "left", "right"];

// A fresh, editable copy of the default mapping with buttons keyed 0..9.
export function defaultBridgeMap() {
  const m = JSON.parse(JSON.stringify(DEFAULT_MAPPING));
  const buttons = {};
  for (let i = 0; i < PHYS_LABELS.length; i++) buttons[i] = m.buttons[i] ?? "nothing";
  return { buttons, stick: m.stick, mouse: m.mouse };
}

// Translate a browser keyboard event into a bridge value ("a", "ctrl+s", …) or null if the
// event is a modifier on its own (caller should keep listening for the real key).
export function keyEventToValue(e) {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const base = keysym(e.key);
  if (!base) return null;
  const parts = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && base !== "shift") parts.push("shift");
  if (e.metaKey) parts.push("super");
  parts.push(base);
  return parts.join("+");
}

// Translate a Node readline "keypress" event (terminal) into a bridge value — the CLI
// equivalent of keyEventToValue. key = { name, ctrl, meta, shift, sequence }.
export function keypressToValue(key) {
  if (!key) return null;
  let base = TERM_NAME[key.name];
  if (!base) {
    if (key.name && /^f\d+$/.test(key.name)) base = key.name.toUpperCase();
    else if (key.name && key.name.length === 1) base = key.name.toLowerCase();
    else if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") base = key.sequence.toLowerCase();
  }
  if (!base) return null;
  const parts = [];
  if (key.ctrl) parts.push("ctrl");
  if (key.meta) parts.push("alt");
  if (key.shift && base !== "shift") parts.push("shift");
  parts.push(base);
  return parts.join("+");
}
const TERM_NAME = {
  return: "Return", enter: "Return", space: "space", tab: "Tab", backspace: "BackSpace",
  escape: "Escape", up: "Up", down: "Down", left: "Left", right: "Right",
  delete: "Delete", home: "Home", end: "End", pageup: "Prior", pagedown: "Next",
};

const KEYSYM = {
  " ": "space", "Spacebar": "space", "Enter": "Return", "Tab": "Tab", "Backspace": "BackSpace",
  "ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left", "ArrowRight": "Right",
  "Delete": "Delete", "Home": "Home", "End": "End", "PageUp": "Prior", "PageDown": "Next",
  "Escape": "Escape", "Control": "ctrl", "Shift": "shift", "Alt": "alt", "Meta": "super",
};
function keysym(k) {
  if (KEYSYM[k]) return KEYSYM[k];
  if (k.length === 1) return k.toLowerCase();
  if (/^F\d+$/.test(k)) return k;
  return k;
}

// Human-readable value for the UI.
export function displayValue(v) {
  if (v == null || v === "" || v === "nothing") return "—";
  if (Array.isArray(v)) return v.join(" , ");
  return v;
}

// Reduce an editable map to a clean config object (drops unassigned buttons; mouse only in mouse mode).
export function toConfig(map) {
  const buttons = {};
  for (const [i, val] of Object.entries(map.buttons)) {
    if (val && val !== "nothing") buttons[i] = val;
  }
  const cfg = { buttons, stick: { ...map.stick } };
  if (map.stick.mode === "mouse") cfg.mouse = { ...map.mouse };
  return cfg;
}

export function toConfigJSON(map) {
  return JSON.stringify(toConfig(map), null, 2);
}

// A ready-to-run command for the exported config.
export function runCommand(filename = "ps-access-bridge.json", sink = "xdotool") {
  return `node bridge.mjs --config ${filename} --sink ${sink}`;
}
