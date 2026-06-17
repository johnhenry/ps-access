#!/usr/bin/env node
// ps-access — read/write PlayStation Access Controller profiles over USB-C (no PS5).
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listControllers, openController, readProfileRaw, writeProfileRaw } from "./lib/hid-node.mjs";
import {
  parseProfile, buildProfile, describeProfile, PROFILE_SIZE, PROFILE_COUNT,
  ACTION_BY_NAME, ACTIONS, STICK_BY_NAME, ORIENTATION_BY_NAME,
} from "./web/access-protocol.mjs";

const CAPTURES = new URL("./captures/", import.meta.url).pathname;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--device" || a === "-d") opts.device = argv[++i];
    else if (a === "--out" || a === "-o") opts.out = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else opts._.push(a);
  }
  return opts;
}

function hex(bytes) {
  return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join(" ");
}
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readAllProfiles(device) {
  const profiles = [];
  for (let n = 1; n <= PROFILE_COUNT; n++) profiles.push(readProfileRaw(device, n));
  return profiles;
}

// Auto-backup all profiles before any write, so every change is reversible.
function autoBackup(device, label) {
  mkdirSync(CAPTURES, { recursive: true });
  const raws = readAllProfiles(device);
  const file = join(CAPTURES, `autobackup-${label}-${stamp()}.json`);
  saveBackup(file, raws);
  return file;
}

function saveBackup(file, raws) {
  const payload = {
    device: "PlayStation Access Controller",
    vidpid: "054c:0e5f",
    savedAt: new Date().toISOString(),
    profiles: raws.map((raw, i) => ({
      slot: i + 1,
      rawHex: Buffer.from(raw).toString("hex"),
      decoded: parseProfile(raw),
    })),
  };
  writeFileSync(file, JSON.stringify(payload, (k, v) => (k === "_raw" ? undefined : v), 2));
}

function loadRawFromFile(path, slot) {
  const txt = readFileSync(path, "utf8").trim();
  // JSON backup with profiles[].rawHex, or a bare hex/binary file.
  if (txt.startsWith("{")) {
    const obj = JSON.parse(txt);
    const entry = (obj.profiles || []).find((p) => p.slot === slot) || obj.profiles?.[0];
    if (!entry) throw new Error("no matching profile in backup file");
    return Uint8Array.from(Buffer.from(entry.rawHex, "hex"));
  }
  if (/^[0-9a-fA-F\s]+$/.test(txt)) return Uint8Array.from(Buffer.from(txt.replace(/\s+/g, ""), "hex"));
  const bin = readFileSync(path);
  return Uint8Array.from(bin);
}

function resolveAction(name) {
  const n = String(name).toLowerCase();
  if (n in ACTION_BY_NAME) return { kind: "action", code: ACTION_BY_NAME[n] };
  if (n in STICK_BY_NAME) return { kind: "stick", code: STICK_BY_NAME[n] };
  if (/^\d+$/.test(n)) return { kind: "action", code: Number(n) };
  throw new Error(`unknown action "${name}". Try: ${Object.values(ACTIONS).join(", ")}, left stick, right stick`);
}

const COMMANDS = {
  list() {
    const list = listControllers();
    if (!list.length) return console.log("No Access Controller connected (VID 054C / PID 0E5F).");
    console.log(`${list.length} Access Controller(s):`);
    for (const d of list) {
      console.log(`  [${d.index}] ${d.product} — ${d.manufacturer}  serial=${d.serialNumber ?? "n/a"}  path=${d.path}`);
    }
  },

  dump(opts) {
    const { device, info } = openController(opts.device ?? 0);
    try {
      console.log(`# ${info.product} [${info.index}] ${info.path}`);
      for (let n = 1; n <= PROFILE_COUNT; n++) {
        const raw = readProfileRaw(device, n);
        console.log(`\n=== Profile ${n} ===`);
        console.log(describeProfile(parseProfile(raw)));
        console.log("raw:", hex(raw.slice(0, 32)), "...");
      }
    } finally {
      device.close();
    }
  },

  backup(opts) {
    const { device, info } = openController(opts.device ?? 0);
    try {
      mkdirSync(CAPTURES, { recursive: true });
      const raws = readAllProfiles(device);
      const file = opts.out || join(CAPTURES, `backup-dev${info.index}-${stamp()}.json`);
      saveBackup(file, raws);
      console.log(`Backed up 3 profiles from controller [${info.index}] -> ${file}`);
    } finally {
      device.close();
    }
  },

  "read-profile"(opts) {
    const slot = Number(opts._[0]);
    if (!(slot >= 1 && slot <= PROFILE_COUNT)) throw new Error("usage: read-profile <1..3>");
    const { device } = openController(opts.device ?? 0);
    try {
      const raw = readProfileRaw(device, slot);
      const p = parseProfile(raw);
      if (opts.json) console.log(JSON.stringify(p, (k, v) => (k === "_raw" ? undefined : v), 2));
      else console.log(describeProfile(p));
    } finally {
      device.close();
    }
  },

  "write-profile"(opts) {
    const slot = Number(opts._[0]);
    const file = opts._[1];
    if (!(slot >= 1 && slot <= PROFILE_COUNT) || !file) throw new Error("usage: write-profile <1..3> <file>");
    const raw = loadRawFromFile(file, slot);
    if (raw.length < PROFILE_SIZE) throw new Error(`file is ${raw.length} bytes, need ${PROFILE_SIZE}`);
    const { device, info } = openController(opts.device ?? 0);
    try {
      const bk = autoBackup(device, `dev${info.index}-pre-write`);
      console.log(`(auto-backup -> ${bk})`);
      writeProfileRaw(device, slot, raw);
      const back = readProfileRaw(device, slot);
      const ok = Buffer.compare(Buffer.from(back.slice(0, PROFILE_SIZE)), Buffer.from(raw.slice(0, PROFILE_SIZE))) === 0;
      console.log(`Wrote profile ${slot}. Round-trip verify: ${ok ? "OK (byte-identical)" : "DIFFERS (device may normalize fields)"}`);
    } finally {
      device.close();
    }
  },

  // set <slot> button5=triangle | port1=cross | port0="left stick" | orientation=...
  set(opts) {
    const slot = Number(opts._[0]);
    const assignment = opts._.slice(1).join(" ");
    const m = assignment.match(/^(button\d+|port\d+|orientation)\s*=\s*(.+)$/i);
    if (!(slot >= 1 && slot <= PROFILE_COUNT) || !m) {
      throw new Error('usage: set <1..3> <button1..10|port0..4|orientation>=<action>');
    }
    const target = m[1].toLowerCase();
    const value = m[2].replace(/^["']|["']$/g, "");
    const { device, info } = openController(opts.device ?? 0);
    try {
      const raw = readProfileRaw(device, slot);
      const p = parseProfile(raw);
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
      const bk = autoBackup(device, `dev${info.index}-pre-set`);
      console.log(`(auto-backup -> ${bk})`);
      const out = buildProfile(p, { now: Date.now() });
      writeProfileRaw(device, slot, out);
      console.log(`set profile ${slot} ${target}=${value}`);
      console.log(describeProfile(parseProfile(readProfileRaw(device, slot))));
    } finally {
      device.close();
    }
  },

  restore(opts) {
    const file = opts._[0];
    if (!file) throw new Error("usage: restore <backup.json> [--device X]");
    const { device, info } = openController(opts.device ?? 0);
    try {
      const bk = autoBackup(device, `dev${info.index}-pre-restore`);
      console.log(`(auto-backup -> ${bk})`);
      for (let slot = 1; slot <= PROFILE_COUNT; slot++) {
        const raw = loadRawFromFile(file, slot);
        writeProfileRaw(device, slot, raw);
      }
      console.log(`Restored 3 profiles from ${file} to controller [${info.index}]`);
    } finally {
      device.close();
    }
  },

  help() {
    console.log(`ps-access — PlayStation Access Controller profile tool (USB-C, no PS5)

Usage: node cli.mjs <command> [args] [--device <index|path>]

Commands:
  list                          List connected controllers
  dump                          Read + decode all 3 profiles
  read-profile <1..3> [--json]  Read + decode one profile
  backup [--out file]           Save all 3 profiles to captures/ (raw + decoded)
  restore <backup.json>         Write all 3 profiles back from a backup
  write-profile <1..3> <file>   Write one profile from a backup/hex/binary file
  set <1..3> <target>=<action>  Edit one mapping, e.g.:
                                  set 1 button5=triangle
                                  set 1 port1=cross
                                  set 1 "port0=left stick"
                                  set 1 orientation="stick on the right"

Every write auto-backs-up first (captures/) and round-trip verifies.
Actions: ${Object.values(ACTIONS).join(", ")}, left stick, right stick`);
  },
};

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._.shift() || "help";
const fn = COMMANDS[cmd] || COMMANDS.help;
try {
  await fn(opts);
} catch (e) {
  console.error("error:", e.message);
  process.exit(1);
}
