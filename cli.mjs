#!/usr/bin/env node
// ps-access — PlayStation Access Controller tool over USB-C (no PS5). Profiles + PC input bridge.
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import {
  parseProfile, buildProfile, describeProfile, PROFILE_SIZE, PROFILE_COUNT,
  ACTION_BY_NAME, ACTIONS, STICKS, STICK_BY_NAME, ORIENTATIONS, ORIENTATION_BY_NAME,
} from "./web/access-protocol.mjs";
import {
  PRESETS, presetById, fromFileText, toPortable, toFileText, applyPortable, decodeShare, shareURL,
} from "./web/profile-library.mjs";

// node-hid is loaded lazily so offline commands (presets/share/show-share/diff/help) work
// without it installed. Device commands call loadHid() first (see the dispatcher).
let _hid = null;
async function loadHid() {
  if (_hid) return _hid;
  let mod;
  try {
    mod = await import("./lib/hid-node.mjs");
    mod.listControllers(); // probe: force node-hid's native binding to load now, so we can explain failures
  } catch (e) {
    const m = String(e.message || e);
    if (e.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(m)) {
      throw new Error(`controller access needs node-hid, which isn't installed. Run "npm install" (or "npm i -g ps-access"). The offline commands (presets, share, show-share, diff) work without it.`);
    }
    if (/libudev|shared object|NODE_MODULE_VERSION|was compiled|dlopen|\.node/.test(m)) {
      throw new Error(`node-hid couldn't load on this system (${m}). On Linux it needs libudev (e.g. apt install libudev1). Offline commands still work.`);
    }
    throw new Error(`controller access unavailable: ${m}`);
  }
  _hid = mod;
  return _hid;
}
const listControllers = (...a) => _hid.listControllers(...a);
const openController = (...a) => _hid.openController(...a);
const readProfileRaw = (...a) => _hid.readProfileRaw(...a);
const writeProfileRaw = (...a) => _hid.writeProfileRaw(...a);
const setActiveProfile = (...a) => _hid.setActiveProfile(...a);

const CAPTURES = new URL("./captures/", import.meta.url).pathname;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--device" || a === "-d") opts.device = argv[++i];
    else if (a === "--out" || a === "-o") opts.out = argv[++i];
    else if (a === "--port" || a === "-p") opts.port = argv[++i];
    else if (a === "--from") opts.from = argv[++i];
    else if (a === "--to") opts.to = argv[++i];
    else if (a === "--all") opts.all = true;
    else if (a === "--dry-run" || a === "--dry") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else opts._.push(a);
  }
  return opts;
}

const hex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function readAllProfiles(device) {
  const out = [];
  for (let n = 1; n <= PROFILE_COUNT; n++) out.push(readProfileRaw(device, n));
  return out;
}

// Auto-backup all profiles before any write, so every change is reversible.
function autoBackup(device, label) {
  mkdirSync(CAPTURES, { recursive: true });
  const file = join(CAPTURES, `autobackup-${label}-${stamp()}.json`);
  saveBackup(file, readAllProfiles(device));
  return file;
}

function saveBackup(file, raws) {
  const payload = {
    device: "PlayStation Access Controller",
    vidpid: "054c:0e5f",
    savedAt: new Date().toISOString(),
    profiles: raws.map((raw, i) => ({ slot: i + 1, rawHex: Buffer.from(raw).toString("hex"), decoded: parseProfile(raw) })),
  };
  writeFileSync(file, JSON.stringify(payload, (k, v) => (k === "_raw" ? undefined : v), 2));
}

function loadRawFromFile(path, slot) {
  const txt = readFileSync(path, "utf8").trim();
  if (txt.startsWith("{")) {
    const obj = JSON.parse(txt);
    const entry = (obj.profiles || []).find((p) => p.slot === slot) || obj.profiles?.[0];
    if (!entry) throw new Error("no matching profile in backup file");
    return Uint8Array.from(Buffer.from(entry.rawHex, "hex"));
  }
  if (/^[0-9a-fA-F\s]+$/.test(txt)) return Uint8Array.from(Buffer.from(txt.replace(/\s+/g, ""), "hex"));
  return Uint8Array.from(readFileSync(path));
}

function resolveAction(name) {
  const n = String(name).toLowerCase();
  if (n in ACTION_BY_NAME) return { kind: "action", code: ACTION_BY_NAME[n] };
  if (n in STICK_BY_NAME) return { kind: "stick", code: STICK_BY_NAME[n] };
  if (/^\d+$/.test(n)) return { kind: "action", code: Number(n) };
  throw new Error(`unknown action "${name}". Try: ${Object.values(ACTIONS).join(", ")}, left stick, right stick`);
}

// Resolve a portable profile from a preset id, a file path (web export / backup), or a share code/URL.
function resolvePortable(src, slotIdx) {
  const preset = presetById(src);
  if (preset) return preset.portable;
  const code = src.includes("#p=") ? src.split("#p=")[1] : src;
  if (!src.startsWith("{") && !/[\\/]/.test(src) && !src.endsWith(".json")) {
    try { return decodeShare(code); } catch { /* fall through to file */ }
  }
  return fromFileText(readFileSync(src, "utf8"), slotIdx);
}

// ---- controller targeting (mirror the per-controller UI; explicit + stable) ----
const ctrlId = (d) => d.serialNumber ?? `index ${d.index}`;
const fmtList = (list) => list.map((d) => `  ${ctrlId(d).padEnd(20)} ${d.product}`).join("\n");

// Returns the selector(s) to operate on. Writes refuse to guess when several are connected.
function resolveTargets(opts, { write = false } = {}) {
  const list = listControllers();
  if (!list.length) throw new Error("No Access Controller connected (VID 054C / PID 0E5F). Connect it via USB-C.");
  if (opts.all) return list.map((d) => d.path);
  if (opts.device != null) return [opts.device];
  if (list.length === 1) return [list[0].path];
  if (write) throw new Error(`Multiple controllers connected — pick one with --device <serial> (or --all):\n${fmtList(list)}`);
  return [list[0].path];
}
function forEachTarget(opts, write, fn) {
  for (const sel of resolveTargets(opts, { write })) {
    const { device, info } = openController(sel);
    try { fn(device, info); } finally { device.close(); }
  }
}

// ---- profile diffing ----
const actLabel = (b) => (ACTIONS[b.map1] ?? `?${b.map1}`) + (b.map2 ? ` + ${ACTIONS[b.map2] ?? b.map2}` : "") + (b.toggle ? " [toggle]" : "");
const portDesc = (pt) => !pt || pt.kind === "none" ? "—"
  : pt.kind === "stick" ? `${STICKS[pt.stick] ?? "?"} (${ORIENTATIONS[pt.orientation] ?? "?"})`
  : `${ACTIONS[pt.map1] ?? "?"}${pt.map2 ? " + " + (ACTIONS[pt.map2] ?? pt.map2) : ""}${pt.toggle ? " [toggle]" : ""}`;

function diffProfiles(a, b) {
  const out = [];
  if ((a.name || "") !== (b.name || "")) out.push(`name: ${JSON.stringify(a.name || "")} -> ${JSON.stringify(b.name || "")}`);
  const nb = Math.max(a.buttons.length, b.buttons.length);
  for (let i = 0; i < nb; i++) {
    const x = a.buttons[i], y = b.buttons[i];
    if (!x || !y || actLabel(x) !== actLabel(y)) out.push(`button ${i + 1}: ${x ? actLabel(x) : "—"} -> ${y ? actLabel(y) : "—"}`);
  }
  const np = Math.max(a.ports.length, b.ports.length);
  for (let i = 0; i < np; i++) {
    if (portDesc(a.ports[i]) !== portDesc(b.ports[i])) out.push(`port ${i}${i === 0 ? " (stick)" : ""}: ${portDesc(a.ports[i])} -> ${portDesc(b.ports[i])}`);
  }
  return out;
}
function printDiff(cur, next) {
  const d = diffProfiles(cur, next);
  console.log(d.length ? d.map((x) => "  " + x).join("\n") : "  (no change)");
}

// Apply one "target=value" assignment to a decoded profile (in place).
function applyAssignment(p, assignment) {
  const m = assignment.match(/^(button\d+|port\d+|orientation)\s*=\s*(.+)$/i);
  if (!m) throw new Error(`bad assignment "${assignment}" (use button1..10|port0..4|orientation=value)`);
  const target = m[1].toLowerCase();
  const value = m[2].replace(/^["']|["']$/g, "");
  if (target === "orientation") {
    const code = value.toLowerCase() in ORIENTATION_BY_NAME ? ORIENTATION_BY_NAME[value.toLowerCase()] : Number(value);
    for (const port of p.ports) if (port.kind === "stick") port.orientation = code;
  } else if (target.startsWith("button")) {
    const i = Number(target.slice(6)) - 1;
    if (!(i >= 0 && i < 10)) throw new Error("button must be 1..10");
    p.buttons[i].map1 = resolveAction(value).code;
  } else {
    const i = Number(target.slice(4));
    if (!(i >= 0 && i < 5)) throw new Error("port must be 0..4");
    const a = resolveAction(value);
    if (a.kind === "stick") p.ports[i] = { kind: "stick", stick: a.code, orientation: p.ports.find((x) => x.kind === "stick")?.orientation ?? 3 };
    else if (a.code === 0) p.ports[i] = { kind: "none" };
    else p.ports[i] = { kind: "button", analog: false, map1: a.code, map2: 0, toggle: false };
  }
}

const COMMANDS = {
  list(opts) {
    const list = listControllers();
    if (opts.json) return console.log(JSON.stringify(list, null, 2));
    if (!list.length) return console.log("No Access Controller connected (VID 054C / PID 0E5F).");
    console.log(`${list.length} Access Controller(s):`);
    for (const d of list) console.log(`  ${ctrlId(d).padEnd(20)} ${d.product} — ${d.manufacturer}  index=${d.index}  serial=${d.serialNumber ?? "n/a"}  path=${d.path}`);
  },

  dump(opts) {
    forEachTarget(opts, false, (device, info) => {
      if (opts.json) {
        const profiles = [];
        for (let n = 1; n <= PROFILE_COUNT; n++) profiles.push(parseProfile(readProfileRaw(device, n)));
        console.log(JSON.stringify({ controller: { index: info.index, serial: info.serialNumber, product: info.product }, profiles }, (k, v) => (k === "_raw" ? undefined : v), 2));
        return;
      }
      console.log(`# ${info.product} [${info.index}] serial=${info.serialNumber ?? "n/a"}`);
      for (let n = 1; n <= PROFILE_COUNT; n++) {
        const raw = readProfileRaw(device, n);
        console.log(`\n=== Profile ${n} ===`);
        console.log(describeProfile(parseProfile(raw)));
        console.log("raw:", hex(raw.slice(0, 32)), "...");
      }
    });
  },

  "read-profile"(opts) {
    const slot = Number(opts._[0]);
    if (!(slot >= 1 && slot <= PROFILE_COUNT)) throw new Error("usage: read-profile <1..3> [--json]");
    forEachTarget(opts, false, (device) => {
      const p = parseProfile(readProfileRaw(device, slot));
      console.log(opts.json ? JSON.stringify(p, (k, v) => (k === "_raw" ? undefined : v), 2) : describeProfile(p));
    });
  },

  backup(opts) {
    const targets = resolveTargets(opts, { write: false });
    for (const sel of targets) {
      const { device, info } = openController(sel);
      try {
        mkdirSync(CAPTURES, { recursive: true });
        const file = (opts.out && targets.length === 1) ? opts.out : join(CAPTURES, `backup-${info.serialNumber ?? "dev" + info.index}-${stamp()}.json`);
        saveBackup(file, readAllProfiles(device));
        console.log(`Backed up 3 profiles from [${info.index}] ${ctrlId(info)} -> ${file}`);
      } finally { device.close(); }
    }
  },

  "set-active"(opts) {
    const slot = Number(opts._[0]);
    if (!(slot >= 1 && slot <= PROFILE_COUNT)) throw new Error("usage: set-active <1..3> [--all]");
    forEachTarget(opts, true, (device, info) => { setActiveProfile(device, slot); console.log(`Switched [${info.index}] to active Profile ${slot}.`); });
  },

  "write-profile"(opts) {
    const slot = Number(opts._[0]); const file = opts._[1];
    if (!(slot >= 1 && slot <= PROFILE_COUNT) || !file) throw new Error("usage: write-profile <1..3> <file> [--dry-run]");
    const raw = loadRawFromFile(file, slot);
    if (raw.length < PROFILE_SIZE) throw new Error(`file is ${raw.length} bytes, need ${PROFILE_SIZE}`);
    forEachTarget(opts, true, (device, info) => {
      if (opts.dryRun) { console.log(`[dry-run] [${info.index}] profile ${slot}:`); return printDiff(parseProfile(readProfileRaw(device, slot)), parseProfile(raw)); }
      console.log(`(auto-backup -> ${autoBackup(device, `dev${info.index}-pre-write`)})`);
      writeProfileRaw(device, slot, raw);
      const back = readProfileRaw(device, slot);
      const ok = Buffer.compare(Buffer.from(back.slice(0, PROFILE_SIZE)), Buffer.from(raw.slice(0, PROFILE_SIZE))) === 0;
      console.log(`Wrote profile ${slot} on [${info.index}]. Round-trip verify: ${ok ? "OK (byte-identical)" : "DIFFERS (device may normalize fields)"}`);
    });
  },

  // set <slot> <target=value>...  (multiple assignments -> one read/backup/write)
  set(opts) {
    const slot = Number(opts._[0]);
    const assigns = opts._.slice(1);
    if (!(slot >= 1 && slot <= PROFILE_COUNT) || !assigns.length) {
      throw new Error('usage: set <1..3> <target=value>...   e.g. set 1 button5=triangle port1=cross orientation="stick on the right"');
    }
    forEachTarget(opts, true, (device, info) => {
      const cur = parseProfile(readProfileRaw(device, slot));
      const p = parseProfile(readProfileRaw(device, slot));
      for (const a of assigns) applyAssignment(p, a);
      const next = buildProfile(p, { now: Date.now() });
      if (opts.dryRun) { console.log(`[dry-run] [${info.index}] profile ${slot}:`); return printDiff(cur, parseProfile(next)); }
      console.log(`(auto-backup -> ${autoBackup(device, `dev${info.index}-pre-set`)})`);
      writeProfileRaw(device, slot, next);
      console.log(`set profile ${slot} on [${info.index}]: ${assigns.join(", ")}`);
      printDiff(cur, parseProfile(readProfileRaw(device, slot)));
    });
  },

  restore(opts) {
    const file = opts._[0];
    if (!file) throw new Error("usage: restore <backup.json> [--device X] [--dry-run]");
    forEachTarget(opts, true, (device, info) => {
      if (opts.dryRun) {
        for (let slot = 1; slot <= PROFILE_COUNT; slot++) { console.log(`[dry-run] [${info.index}] profile ${slot}:`); printDiff(parseProfile(readProfileRaw(device, slot)), parseProfile(loadRawFromFile(file, slot))); }
        return;
      }
      console.log(`(auto-backup -> ${autoBackup(device, `dev${info.index}-pre-restore`)})`);
      for (let slot = 1; slot <= PROFILE_COUNT; slot++) writeProfileRaw(device, slot, loadRawFromFile(file, slot));
      console.log(`Restored 3 profiles from ${file} to [${info.index}]`);
    });
  },

  // Apply a portable profile (web export / share code / URL / preset id) onto a slot.
  apply(opts) {
    const src = opts._[0]; const slot = Number(opts._[1]);
    if (!src || !(slot >= 1 && slot <= PROFILE_COUNT)) throw new Error("usage: apply <file.json | share-code | url | preset-id> <1..3> [--all] [--dry-run]");
    const portable = resolvePortable(src, slot - 1);
    forEachTarget(opts, true, (device, info) => {
      const cur = parseProfile(readProfileRaw(device, slot));
      const next = buildProfile(applyPortable(parseProfile(readProfileRaw(device, slot)), portable), { now: Date.now() });
      if (opts.dryRun) { console.log(`[dry-run] [${info.index}] profile ${slot}:`); return printDiff(cur, parseProfile(next)); }
      console.log(`(auto-backup -> ${autoBackup(device, `dev${info.index}-pre-apply`)})`);
      writeProfileRaw(device, slot, next);
      console.log(`Applied ${portable.name ? `"${portable.name}"` : "profile"} to slot ${slot} on [${info.index}].`);
      printDiff(cur, parseProfile(readProfileRaw(device, slot)));
    });
  },

  // Export a slot as a portable .ps-access.json (the import side is `apply`).
  export(opts) {
    const slot = Number(opts._[0]); const file = opts._[1];
    if (!(slot >= 1 && slot <= PROFILE_COUNT) || !file) throw new Error("usage: export <1..3> <file.json>");
    forEachTarget(opts, false, (device, info) => {
      writeFileSync(file, toFileText(toPortable(parseProfile(readProfileRaw(device, slot)))));
      console.log(`Exported profile ${slot} from [${info.index}] -> ${file}`);
    });
  },

  rename(opts) {
    const slot = Number(opts._[0]); const name = opts._.slice(1).join(" ");
    if (!(slot >= 1 && slot <= PROFILE_COUNT) || !name) throw new Error('usage: rename <1..3> <name>');
    forEachTarget(opts, true, (device, info) => {
      const cur = parseProfile(readProfileRaw(device, slot));
      const p = parseProfile(readProfileRaw(device, slot)); p.name = name.slice(0, 40);
      const next = buildProfile(p, { now: Date.now() });
      if (opts.dryRun) { console.log(`[dry-run] [${info.index}] profile ${slot}:`); return printDiff(cur, parseProfile(next)); }
      console.log(`(auto-backup -> ${autoBackup(device, `dev${info.index}-pre-rename`)})`);
      writeProfileRaw(device, slot, next);
      console.log(`Renamed profile ${slot} on [${info.index}] to "${p.name}"`);
    });
  },

  // copy <srcSlot> <dstSlot> [--from <id> --to <id>] — within a controller, or across two.
  copy(opts) {
    const src = Number(opts._[0]); const dst = Number(opts._[1]);
    if (!(src >= 1 && src <= PROFILE_COUNT) || !(dst >= 1 && dst <= PROFILE_COUNT)) {
      throw new Error("usage: copy <srcSlot 1..3> <dstSlot 1..3> [--from <id> --to <id>]");
    }
    if (opts.from || opts.to) {
      const a = openController(opts.from ?? opts.device ?? 0);
      let raw; try { raw = readProfileRaw(a.device, src); } finally { a.device.close(); }
      const b = openController(opts.to ?? opts.device ?? 0);
      try {
        if (opts.dryRun) { console.log(`[dry-run] copy [${a.info.index}] profile ${src} -> [${b.info.index}] profile ${dst}:`); return printDiff(parseProfile(readProfileRaw(b.device, dst)), parseProfile(raw)); }
        console.log(`(auto-backup -> ${autoBackup(b.device, `dev${b.info.index}-pre-copy`)})`);
        writeProfileRaw(b.device, dst, raw);
        console.log(`Copied [${a.info.index}] profile ${src} -> [${b.info.index}] profile ${dst}`);
      } finally { b.device.close(); }
      return;
    }
    forEachTarget(opts, true, (device, info) => {
      const raw = readProfileRaw(device, src);
      if (opts.dryRun) { console.log(`[dry-run] [${info.index}] profile ${src} -> ${dst}:`); return printDiff(parseProfile(readProfileRaw(device, dst)), parseProfile(raw)); }
      console.log(`(auto-backup -> ${autoBackup(device, `dev${info.index}-pre-copy`)})`);
      writeProfileRaw(device, dst, raw);
      console.log(`Copied profile ${src} -> ${dst} on [${info.index}]`);
    });
  },

  // Compare two profiles. Each operand is a slot (1..3, from the device) or a file/share/preset.
  async diff(opts) {
    const [aSpec, bSpec] = opts._;
    if (!aSpec || !bSpec) throw new Error("usage: diff <a> <b>   (each: a slot 1..3, or a file / share-code / preset-id)");
    const needDevice = [aSpec, bSpec].some((s) => /^[1-3]$/.test(s));
    let device;
    if (needDevice) { await loadHid(); ({ device } = openController(resolveTargets(opts, { write: false })[0])); }
    try {
      const load = (s) => /^[1-3]$/.test(s) ? parseProfile(readProfileRaw(device, Number(s))) : resolvePortable(s, 0);
      printDiff(load(aSpec), load(bSpec));
    } finally { device?.close(); }
  },

  // Terminal live input view — the CLI parallel to the Monitor blade.
  async monitor(opts) {
    const { decodeInput } = await import("./web/bridge-core.mjs");
    if (!process.stdout.isTTY) throw new Error("monitor needs an interactive terminal.");
    const devs = resolveTargets(opts, { write: false }).map((sel) => openController(sel));
    const states = new Map();
    let lines = 0;
    const redraw = () => {
      if (lines) process.stdout.write(`\x1b[${lines}A`);
      const rows = devs.map(({ info }) => {
        const s = states.get(info.index) || { buttons: [], axes: [0, 0] };
        return `[${info.index}] ${info.product.padEnd(20)} btns: ${(s.buttons.join(",") || "-").padEnd(20)} stick: ${s.axes[0].toFixed(2)},${s.axes[1].toFixed(2)}\x1b[K`;
      });
      lines = rows.length;
      process.stdout.write(rows.join("\n") + "\n");
    };
    console.log(`Live monitor — ${devs.length} controller(s). Ctrl-C to exit.\n`);
    for (const { device, info } of devs) {
      device.on("data", (buf) => {
        const d = buf[0] === 0x01 ? buf.subarray(1) : buf;
        const { buttons, axes } = decodeInput(d);
        states.set(info.index, { buttons: [...buttons].sort((x, y) => x - y), axes });
        redraw();
      });
    }
    await new Promise((resolve) => {
      const quit = () => { for (const { device } of devs) { try { device.close(); } catch { /* ignore */ } } process.stdout.write("\n"); resolve(); };
      process.on("SIGINT", quit);
    });
  },

  // Serve the bundled web configurator locally. http://localhost is a valid WebHID secure
  // context, so no HTTPS needed. No dependency — a tiny built-in static file server.
  async serve(opts) {
    const { createServer } = await import("node:http");
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(fileURLToPath(new URL("./web/", import.meta.url)));
    const port = Number(opts.port ?? opts._[0]) || 3000;
    const sep = process.platform === "win32" ? "\\" : "/";
    const MIME = {
      ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
      ".mjs": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
      ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
    };
    const server = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent((req.url || "/").split("?")[0]);
        if (p.endsWith("/")) p += "index.html";
        const filePath = resolve(join(root, p));
        if (filePath !== root && !filePath.startsWith(root + sep)) { res.writeHead(403); return res.end("forbidden"); }
        const body = await readFile(filePath);
        res.writeHead(200, { "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" });
        res.end(body);
      } catch { res.writeHead(404); res.end("not found"); }
    });
    await new Promise((done, reject) => {
      server.on("error", (e) => reject(e.code === "EADDRINUSE" ? new Error(`port ${port} is in use — try: ps-access serve <port>`) : e));
      server.listen(port, () => {
        console.log(`ps-access — web configurator at  http://localhost:${port}/`);
        console.log("Open it in Chrome or Edge (WebHID). Press Ctrl-C to stop.");
      });
      process.on("SIGINT", () => { server.close(); process.stdout.write("\n"); done(); });
    });
  },

  presets() {
    console.log("Presets — apply as a starting point, then customize:");
    for (const p of PRESETS) console.log(`  ${p.id.padEnd(18)} ${p.name}\n    ${p.description}`);
    console.log(`\nApply one:  ps-access apply <preset-id> <slot>`);
  },

  share(opts) {
    const file = opts._[0];
    if (!file) throw new Error("usage: share <backup.json> [slot 1..3]");
    const slot = opts._[1] ? Number(opts._[1]) - 1 : 0;
    console.log(shareURL(fromFileText(readFileSync(file, "utf8"), slot), "https://ps-access.johnhenry.me/"));
  },

  "show-share"(opts) {
    const arg = opts._[0];
    if (!arg) throw new Error("usage: show-share <code|url>");
    const portable = decodeShare(arg.includes("#p=") ? arg.split("#p=")[1] : arg);
    console.log(describeProfile({ uuid: "(shared profile)", buttons: portable.buttons, ports: portable.ports, name: portable.name }));
  },

  help() {
    console.log(`ps-access — PlayStation Access Controller tool (USB-C, no PS5)

Usage: ps-access <command> [args] [--device <serial|index|path>] [--all]
       (no install: npx ps-access <command> …)

Per-controller (use --device <serial> to target one; --all for every connected controller;
multiple connected + a write + no --device = refused):
  list [--json]                 List connected controllers
  dump [--all --json]           Read + decode all 3 profiles
  read-profile <1..3> [--json]  Read + decode one profile
  set-active <1..3> [--all]     Switch the active profile (like the profile button)
  backup [--all --out file]     Save all 3 profiles to captures/ (raw + decoded)
  restore <backup.json> [--dry-run]   Write all 3 profiles back from a backup
  write-profile <1..3> <file> [--dry-run]   Write one profile from a backup/hex/binary file
  set <1..3> <target=value>... [--dry-run]  Edit mappings (one write), e.g.:
                                  set 1 button5=triangle port1=cross
                                  set 1 "port0=left stick" orientation="stick on the right"
  apply <src> <1..3> [--all --dry-run]   Apply a web export / share code / url / preset id
  export <1..3> <file.json>     Save a slot as a portable profile (the import side is apply)
  rename <1..3> <name>          Rename a profile
  copy <src> <dst> [--from id --to id]   Clone a profile between slots / controllers
  diff <a> <b>                  Compare two profiles (slot 1..3, file, share-code, or preset)
  monitor [--all]               Live terminal view of physical buttons + stick

Global:
  presets                       List built-in starting-point presets
  share <backup.json> [slot]    Print a shareable link/code (offline)
  show-share <code|url>         Decode + describe a share link/code (offline)
  bridge [run|edit|set|show]    Use the controller as a PC input device (ps-access bridge --help)
  serve [port]                  Serve the web configurator locally (http://localhost:3000)

Every write auto-backs-up first (captures/) and round-trip verifies.  Add --dry-run to preview.
Actions: ${Object.values(ACTIONS).join(", ")}, left stick, right stick`);
  },
};

// Commands that never touch the controller — usable without node-hid installed.
const OFFLINE = new Set(["presets", "share", "show-share", "diff", "serve", "help"]);

const rawArgv = process.argv.slice(2);
try {
  if (rawArgv[0] === "bridge") {
    const { runBridge } = await import("./bridge.mjs");
    await runBridge(rawArgv.slice(1));
  } else {
    const opts = parseArgs(rawArgv);
    const cmd = opts._.shift() || "help";
    const fn = COMMANDS[cmd] || COMMANDS.help;
    if (!OFFLINE.has(cmd) && COMMANDS[cmd]) await loadHid();
    await fn(opts);
  }
} catch (e) {
  console.error("error:", e.message);
  process.exit(1);
}
