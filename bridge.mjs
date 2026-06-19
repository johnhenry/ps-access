#!/usr/bin/env node
// ps-access bridge — use the PlayStation Access Controller as a PC input device.
//
// Reads the controller's live input over USB and maps it to keyboard/mouse (xdotool)
// or a virtual gamepad (uinput) so it can drive ANY PC software, not just a PS5.
//
//   ps-access bridge --sink xdotool                 # stick -> arrows, buttons -> keys (X11)
//   ps-access bridge --sink uinput                  # virtual gamepad (needs /dev/uinput)
//   ps-access bridge --sink dry-run                 # print events, inject nothing
//   ps-access bridge --config my-map.json           # custom mapping
//   ps-access bridge --simulate frames.json --sink dry-run   # replay (no hardware)
//
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { BridgeEngine, decodeInput, DEFAULT_MAPPING } from "./web/bridge-core.mjs";
import {
  PHYS_LABELS, STICK_MODES, STICK_DIRS, defaultBridgeMap, displayValue, toConfigJSON, keypressToValue,
} from "./web/bridge-map.mjs";
import { makeSink } from "./lib/bridge-sinks.mjs";

// Don't crash if our output is piped into something that closes early (e.g. `| head`).
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });

function parseArgs(argv) {
  const o = { sink: "dry-run", rate: 60, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sink") o.sink = argv[++i];
    else if (a === "--config") o.config = argv[++i];
    else if (a === "--simulate") o.simulate = argv[++i];
    else if (a === "--device" || a === "-d") o.device = argv[++i];
    else if (a === "--display") o.display = argv[++i];
    else if (a === "--rate") o.rate = Number(argv[++i]);
    else if (a === "--out" || a === "-o") o.out = argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
    else o._.push(a);
  }
  return o;
}

function loadMapping(file) {
  if (!file) return DEFAULT_MAPPING;
  const m = JSON.parse(readFileSync(file, "utf8"));
  return m.mapping || m; // accept {mapping:{...}} or a bare mapping
}

const HELP = `ps-access bridge — drive a PC with the Access Controller (USB-C)

Usage:
  ps-access bridge [--sink <name>] [options]      run the bridge (live or --simulate)
  ps-access bridge edit [--config f] [--out f]    interactive press-to-bind key editor
  ps-access bridge set <target=value>... [--out f]   set mappings non-interactively
  ps-access bridge show [--config f]              print the resolved config JSON

edit/set targets: 0..9 (buttons), stick.mode, stick.up/down/left/right, mouse.speed
  e.g.  ps-access bridge set 0=ctrl+s 8=space 2=ctrl+c,ctrl+v stick.mode=mouse --out my-map.json

Sinks:
  dry-run        Print events only (default; no OS input)
  xdotool        Keyboard + mouse via xdotool (X11)
  uinput         Virtual gamepad/keyboard via /dev/uinput (Linux; needs access)

Options:
  --config <file>     JSON mapping (see DEFAULT_MAPPING in web/bridge-core.mjs)
  --simulate <file>   Replay recorded input frames instead of reading hardware
  --device <i|path>   Select controller (default 0)
  --display <:N>      X display for xdotool (default $DISPLAY or :0)
  --rate <hz>         Simulate playback rate (default 60)
  -h, --help          This help

Mapping config example (my-map.json):
  { "buttons": { "8": "space", "0": "mouse1" },
    "stick": { "mode": "mouse" }, "mouse": { "speed": 22 } }`;

async function runSimulate(opts, engine, sink) {
  // Frames file: JSON array of byte arrays (report id already stripped), each one input report.
  const frames = JSON.parse(readFileSync(opts.simulate, "utf8"));
  const delay = Math.max(0, Math.round(1000 / (opts.rate || 60)));
  console.log(`simulate: ${frames.length} frames -> ${opts.sink}`);
  for (const f of frames) {
    sink.apply(engine.update(decodeInput(Uint8Array.from(f))));
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
  sink.apply(engine.releaseAll());
}

async function runLive(opts, engine, sink) {
  let HID, listControllers, list;
  try {
    const mod = await import("./lib/hid-node.mjs");
    HID = mod.HID; listControllers = mod.listControllers;
    list = listControllers(); // also forces node-hid's native binding to load
  } catch (e) {
    const m = String(e.message || e);
    if (e.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(m)) {
      throw new Error("live mode needs node-hid — run `npm install` (or `npm i -g ps-access`). `edit`/`set`/`show` work without it.");
    }
    if (/libudev|shared object|NODE_MODULE_VERSION|was compiled|dlopen|\.node/.test(m)) {
      throw new Error(`node-hid couldn't load on this system (${m}). On Linux it needs libudev. \`edit\`/\`set\`/\`show\` work without it.`);
    }
    throw new Error(`live mode unavailable: ${m}`);
  }
  if (!list.length) throw new Error("No Access Controller connected (VID 054C / PID 0E5F). Connect it via USB-C.");
  const sel = opts.device ?? 0;
  const entry = (typeof sel === "string" && sel.startsWith("/")) ? list.find((d) => d.path === sel) : list[Number(sel)];
  if (!entry) throw new Error(`No controller for --device ${sel}`);
  const device = new HID.HID(entry.path);
  console.log(`bridge: ${entry.product} [${entry.index}] -> ${opts.sink}.  Ctrl-C to stop.`);
  device.on("data", (buf) => {
    // node-hid prefixes the report id for numbered reports; the decoder expects it stripped.
    const d = buf[0] === 0x01 ? buf.subarray(1) : buf;
    try { sink.apply(engine.update(decodeInput(d))); } catch (e) { console.error("map error:", e.message); }
  });
  device.on("error", (e) => { console.error("device error:", e.message); shutdown(); });
  function shutdown() {
    try { sink.apply(engine.releaseAll()); sink.close(); device.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {}); // run until signal
}

// ---- config editing (no controller / node-hid needed) ----

// Load a saved config into a full editable map (fills unset buttons, merges stick/mouse).
function loadEditMap(file) {
  const base = defaultBridgeMap();
  if (!file) return base;
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const m = j.mapping || j;
    if (m.buttons) for (const k of Object.keys(base.buttons)) if (m.buttons[k] != null) base.buttons[k] = m.buttons[k];
    if (m.stick) base.stick = { ...base.stick, ...m.stick };
    if (m.mouse) base.mouse = { ...base.mouse, ...m.mouse };
  } catch { /* treat as a new file */ }
  return base;
}

function applySet(map, target, value) {
  const val = value.includes(",") ? value.split(",").map((s) => s.trim()) : value; // comma -> macro
  if (/^\d+$/.test(target)) { map.buttons[target] = val; return; }                  // 0..9 -> button
  if (target === "stick.mode") { map.stick.mode = value; return; }
  if (target.startsWith("stick.")) { map.stick[target.slice(6)] = val; return; }
  if (target.startsWith("mouse.")) { map.mouse[target.slice(6)] = isNaN(+value) ? value : +value; return; }
  throw new Error(`unknown target "${target}" (use 0..9, stick.mode, stick.up.., mouse.speed)`);
}

function showConfig(opts) {
  console.log(toConfigJSON(loadEditMap(opts.config)));
}

function setConfig(opts) {
  const assigns = opts._.slice(1);
  if (!assigns.length) throw new Error('usage: set <target=value>...  e.g. set 0=ctrl+s 8=space stick.mode=mouse');
  const map = loadEditMap(opts.config);
  for (const a of assigns) {
    const m = a.match(/^([^=]+)=(.*)$/);
    if (!m) throw new Error(`bad assignment "${a}" (want target=value)`);
    applySet(map, m[1].trim(), m[2].trim());
  }
  const out = opts.out || opts.config || "ps-access-bridge.json";
  writeFileSync(out, toConfigJSON(map));
  console.log(`wrote ${out}\n`);
  console.log(toConfigJSON(map));
}

// Interactive press-to-bind editor — the CLI twin of the web Key Bridge blade.
function editConfig(opts) {
  if (!process.stdin.isTTY) throw new Error("`edit` needs an interactive terminal — use `set`/`show` for scripting.");
  const map = loadEditMap(opts.config);
  const out = opts.out || opts.config || "ps-access-bridge.json";
  let sel = 0, capturing = false, note = "";

  const targets = () => {
    const t = PHYS_LABELS.map((label, i) => ({ type: "button", i, label, get: () => map.buttons[i] }));
    t.push({ type: "stickmode", label: "Stick mode", get: () => map.stick.mode });
    if (map.stick.mode === "keys") for (const dir of STICK_DIRS) t.push({ type: "stick", dir, label: "Stick " + dir, get: () => map.stick[dir] });
    return t;
  };
  const assign = (t, v) => { if (t.type === "button") map.buttons[t.i] = v; else if (t.type === "stick") map.stick[t.dir] = v; };
  const render = () => {
    const list = targets();
    let s = "\x1b[2J\x1b[H\n  ps-access bridge — key editor\n";
    s += "  ↑/↓ select · Enter bind (or cycle stick mode) · Del clear · s save · q quit\n\n";
    list.forEach((t, idx) => { s += `  ${idx === sel ? "\x1b[36m▸" : " "} ${t.label.padEnd(13)} ${displayValue(t.get())}\x1b[0m\n`; });
    s += capturing ? "\n  \x1b[33m▶ press a key to bind…  (Esc cancels)\x1b[0m\n" : `\n  saving to: ${out}${note ? "   " + note : ""}\n`;
    process.stdout.write(s);
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  render();
  return new Promise((resolve) => {
    const quit = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); resolve(); };
    process.stdin.on("keypress", (_str, key) => {
      const list = targets();
      const t = list[Math.min(sel, list.length - 1)];
      if (capturing) {
        if (key.name === "escape") { capturing = false; note = "cancelled"; }
        else if (key.name === "delete") { assign(t, "nothing"); capturing = false; writeFileSync(out, toConfigJSON(map)); note = "cleared + saved"; }
        else { const v = keypressToValue(key); if (v) { assign(t, v); capturing = false; writeFileSync(out, toConfigJSON(map)); note = "bound + saved"; } else return; }
        render(); return;
      }
      if (key.name === "up") { sel = Math.max(0, sel - 1); note = ""; render(); }
      else if (key.name === "down") { sel = Math.min(list.length - 1, sel + 1); note = ""; render(); }
      else if (key.name === "return") {
        if (t.type === "stickmode") { map.stick.mode = STICK_MODES[(STICK_MODES.indexOf(map.stick.mode) + 1) % STICK_MODES.length]; writeFileSync(out, toConfigJSON(map)); note = "saved"; }
        else { capturing = true; note = ""; }
        render();
      }
      else if (key.name === "s") { writeFileSync(out, toConfigJSON(map)); note = "saved " + out; render(); }
      else if (key.name === "q" || (key.ctrl && key.name === "c")) quit();
    });
  });
}

export async function runBridge(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); return; }
  const sub = opts._[0];
  try {
    if (sub === "edit") return await editConfig(opts);
    if (sub === "set") return setConfig(opts);
    if (sub === "show") return showConfig(opts);
  } catch (e) { console.error("error:", e.message); process.exit(1); }

  // default: run the bridge
  const engine = new BridgeEngine(loadMapping(opts.config));
  const sink = makeSink(opts.sink, { display: opts.display });
  try {
    if (opts.simulate) { await runSimulate(opts, engine, sink); sink.close(); }
    else await runLive(opts, engine, sink);
  } catch (e) {
    console.error("error:", e.message);
    try { sink.close(); } catch { /* ignore */ }
    process.exit(1);
  }
}

// Allow `node bridge.mjs …` directly (dev), while also being importable as `ps-access bridge`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBridge(process.argv.slice(2));
}
