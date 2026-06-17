#!/usr/bin/env node
// ps-access bridge — use the PlayStation Access Controller as a PC input device.
//
// Reads the controller's live input over USB and maps it to keyboard/mouse (xdotool)
// or a virtual gamepad (uinput) so it can drive ANY PC software, not just a PS5.
//
//   node bridge.mjs --sink xdotool                 # stick -> arrows, buttons -> keys (X11)
//   node bridge.mjs --sink uinput                  # virtual gamepad (needs /dev/uinput)
//   node bridge.mjs --sink dry-run                 # print events, inject nothing
//   node bridge.mjs --config my-map.json           # custom mapping
//   node bridge.mjs --simulate frames.json --sink dry-run   # replay (no hardware)
//
import { readFileSync } from "node:fs";
import { BridgeEngine, decodeInput, DEFAULT_MAPPING } from "./lib/bridge-core.mjs";
import { makeSink } from "./lib/bridge-sinks.mjs";

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

Usage: node bridge.mjs [--sink <name>] [options]

Sinks:
  dry-run        Print events only (default; no OS input)
  xdotool        Keyboard + mouse via xdotool (X11)
  uinput         Virtual gamepad/keyboard via /dev/uinput (Linux; needs access)

Options:
  --config <file>     JSON mapping (see DEFAULT_MAPPING in lib/bridge-core.mjs)
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
  let HID;
  try { ({ HID } = await import("./lib/hid-node.mjs")); }
  catch (e) { throw new Error("node-hid is required for live mode (run `npm install`). " + (e.message || e)); }
  const { listControllers } = await import("./lib/hid-node.mjs");
  const list = listControllers();
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
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
main();
