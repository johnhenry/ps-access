// Output sinks for the PC input bridge. A sink turns the abstract events from
// BridgeEngine (key/button down·up, mouse motion, axes) into real OS input.
//
// Sinks expose:  apply(events) -> void|Promise   and   close() -> void|Promise
//
//   DryRunSink   — prints events; no OS input. Works everywhere (default for --dry-run).
//   XdotoolSink  — keyboard + mouse via the `xdotool` CLI (X11). No native deps.
//   UinputSink   — virtual gamepad/keyboard via /dev/uinput, driven by a stdlib-only
//                  Python helper (no extra packages). Needs access to /dev/uinput
//                  (run as root or add a udev rule). Lowest latency.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- dry run
export class DryRunSink {
  constructor({ log = (s) => console.log(s) } = {}) { this.log = log; this.count = 0; }
  apply(events) {
    for (const e of events) {
      this.count++;
      if (e.type === "key") this.log(`  ${e.action === "down" ? "▼" : "▲"} ${e.code}`);
      else if (e.type === "mouseMove") this.log(`  ↔ mouse ${e.dx >= 0 ? "+" : ""}${e.dx},${e.dy >= 0 ? "+" : ""}${e.dy}`);
      else if (e.type === "axis") this.log(`  ⊹ axis ${e.code}=${e.value.toFixed(2)}`);
    }
  }
  close() { this.log(`dry-run: ${this.count} events`); }
}

// ---------------------------------------------------------------- xdotool (X11)
const XDO_MOUSE = { mouse1: 1, mouse2: 2, mouse3: 3 };

export class XdotoolSink {
  constructor({ display = process.env.DISPLAY || ":0" } = {}) {
    this.env = { ...process.env, DISPLAY: display };
    const probe = spawnSync("xdotool", ["version"], { env: this.env });
    if (probe.error) throw new Error("xdotool not found — install it (NixOS: nix-install xdotool)");
    if (probe.status !== 0) throw new Error(`xdotool can't reach DISPLAY=${display}. Set --display.`);
  }
  apply(events) {
    const args = [];
    for (const e of events) {
      if (e.type === "key") {
        const mb = XDO_MOUSE[e.code];
        if (mb) args.push(e.action === "down" ? "mousedown" : "mouseup", String(mb));
        else args.push(e.action === "down" ? "keydown" : "keyup", e.code);
      } else if (e.type === "mouseMove") {
        args.push("mousemove_relative", "--", String(e.dx), String(e.dy));
      }
    }
    if (args.length) spawnSync("xdotool", args, { env: this.env });
  }
  close() { /* nothing persistent */ }
}

// ---------------------------------------------------------------- uinput (Linux)
// Spawns the Python helper and streams it one JSON event per line.
export class UinputSink {
  constructor({ kind = "gamepad", python = "python3" } = {}) {
    const helper = join(HERE, "uinput-helper.py");
    this.proc = spawn(python, [helper, kind], { stdio: ["pipe", "inherit", "inherit"] });
    this.proc.on("error", (e) => { throw new Error(`couldn't start uinput helper: ${e.message}`); });
  }
  apply(events) {
    if (!this.proc?.stdin.writable) return;
    for (const e of events) this.proc.stdin.write(JSON.stringify(e) + "\n");
  }
  close() { try { this.proc.stdin.end(); this.proc.kill(); } catch { /* ignore */ } }
}

// Factory used by the CLI.
export function makeSink(name, opts = {}) {
  switch (name) {
    case "dry-run": case "dryrun": case "dry": return new DryRunSink(opts);
    case "xdotool": case "keyboard": return new XdotoolSink(opts);
    case "uinput": case "gamepad": return new UinputSink({ kind: "gamepad", ...opts });
    default: throw new Error(`unknown sink "${name}" (use: dry-run, xdotool, uinput)`);
  }
}
