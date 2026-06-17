// PlayStation Access Controller profile protocol.
//
// Pure, I/O-free. Works in Node and the browser (operates on Uint8Array / DataView).
// Transcribed and verified against jfedor's web editor (https://www.jfedor.org/ps-access/),
// credited in PROTOCOL.md. No PS5 required.

// ---- Device identity ----
export const VENDOR_ID = 0x054c; // Sony
export const PRODUCT_ID = 0x0e5f; // Access Controller

// ---- Feature reports / transport ----
export const REPORT_ID_CMD = 0x60; // host -> device command channel
export const REPORT_ID_DATA = 0x61; // device -> host data channel
export const BT_ONLY_REPORT_ID = 99; // present only over Bluetooth; absent over USB (profile channel is USB-only)
export const CMD_PAYLOAD_SIZE = 63; // bytes after the report id in a 0x60 packet
export const PROFILE_SIZE = 956; // bytes of a single profile blob
export const PROFILE_COUNT = 3; // on-device profile slots (1..3)
const PACKET_COUNT = 18; // 18 * 56 = 1008 >= 956
const CHUNK = 56; // payload bytes per packet
const READ_PAYLOAD_OFFSET = 4; // payload offset within a 0x61 response (after report id + header)
const WRITE_PAYLOAD_OFFSET = 2; // payload offset within a 0x60 write packet

// ---- CRC-32 (standard zlib/IEEE, port of crc.js) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, length = bytes.length) {
  let c = 0xffffffff;
  for (let n = 0; n < length; n++) c = CRC_TABLE[(c ^ bytes[n]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- Enum tables (from index.html dropdowns) ----
// Button action codes (used for physical buttons and expansion-port-as-button).
export const ACTIONS = {
  0: "nothing", 1: "circle", 2: "cross", 3: "triangle", 4: "square",
  5: "up", 6: "down", 7: "left", 8: "right", 9: "L1", 10: "R1",
  11: "L2", 12: "R2", 13: "L3", 14: "R3", 15: "options", 16: "create",
  17: "PS", 18: "touchpad",
};
// Stick assignment for ports configured as a stick (stored value = code - 100).
export const STICKS = { 1: "left stick", 2: "right stick" };
// Built-in stick orientation.
export const ORIENTATIONS = {
  0: "stick below", 1: "stick on the right", 2: "stick above", 3: "stick on the left",
};
// Stick tuning. The device stores 0 for "firmware default"; these are the values jfedor's
// editor writes as the PS5 "default" preset. Exact value semantics are not publicly
// documented, so the UI exposes these as adjustable/experimental.
export const STICK_DEFAULT_SENSITIVITY = 3;
export const STICK_DEFAULT_DEADZONE = [0x80, 0x80, 0xc4, 0xc4, 0xe1, 0xe1];

export const ACTION_BY_NAME = invert(ACTIONS);
export const STICK_BY_NAME = invert(STICKS);
export const ORIENTATION_BY_NAME = invert(ORIENTATIONS);
function invert(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) r[v.toLowerCase()] = Number(k);
  return r;
}

// ---- Profile layout offsets ----
const OFF = {
  sentinel: 0, // u8 == 0x02
  name: 4, // UTF-16LE, up to 40 chars
  uuid: 84, // 16 bytes
  buttons: 100, // 10 * 5 bytes: [map1, map2, ...]
  toggle: 150, // u16 LE bitfield: bits 0..9 buttons, bits 9+port ports
  ports: 152, // 5 * 45 bytes
  timestamp: 948, // i64 LE
};
const BUTTON_COUNT = 10;
const BUTTON_STRIDE = 5;
const PORT_COUNT = 5;
const PORT_STRIDE = 45;
const NAME_MAX = 40;

// Decode a 956-byte profile blob into an editable object. Keeps the raw bytes so a
// write can preserve fields we don't model (stick sensitivity/deadzone, uuid, etc.).
export function parseProfile(bytes) {
  const u8 = u8of(bytes);
  if (u8.length < PROFILE_SIZE) throw new Error(`profile too short: ${u8.length}`);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint8(OFF.sentinel) !== 0x02) {
    throw new Error(`expected byte 0 == 0x02, got 0x${dv.getUint8(0).toString(16)}`);
  }

  let name = "";
  for (let i = 0; i < NAME_MAX; i++) {
    const c = dv.getUint16(OFF.name + 2 * i, true);
    if (c === 0) break;
    name += String.fromCharCode(c);
  }

  const toggleBits = dv.getUint16(OFF.toggle, true);
  const buttons = [];
  for (let b = 0; b < BUTTON_COUNT; b++) {
    const base = OFF.buttons + b * BUTTON_STRIDE;
    buttons.push({
      map1: dv.getUint8(base),
      map2: dv.getUint8(base + 1),
      toggle: (toggleBits & (1 << b)) !== 0,
    });
  }

  const ports = [];
  for (let p = 0; p < PORT_COUNT; p++) {
    const base = OFF.ports + p * PORT_STRIDE;
    const type = dv.getUint8(base);
    if (type === 0x00) {
      ports.push({ kind: "none" });
    } else if (type === 0x01) {
      ports.push({
        kind: "stick",
        stick: dv.getUint8(base + 1), // 1=left, 2=right
        orientation: dv.getUint8(base + 2),
        sensitivity: dv.getUint8(base + 5), // 0 = firmware default
        deadzone: [...u8.slice(base + 8, base + 14)], // 6 bytes, 0 = firmware default
      });
    } else if (type === 0x02 || type === 0x03) {
      ports.push({
        kind: "button",
        analog: type === 0x02,
        map1: dv.getUint8(base + 2),
        map2: dv.getUint8(base + 3),
        toggle: (toggleBits & (1 << (9 + p))) !== 0,
      });
    } else {
      throw new Error(`unexpected expansion-port type 0x${type.toString(16)} on port ${p}`);
    }
  }

  const uuid = [...u8.slice(OFF.uuid, OFF.uuid + 16)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const timestamp = Number(dv.getBigInt64(OFF.timestamp, true));

  return { name, uuid, timestamp, buttons, ports, _raw: u8.slice(0, PROFILE_SIZE) };
}

// Build a 956-byte profile blob from an object. Starts from `_raw` when present so
// unmodeled fields (stick sensitivity/deadzone) survive a round trip. Pass a Date.now()
// value as `now` to refresh the timestamp (caller supplies it; the lib stays pure).
export function buildProfile(profile, { now = null, regenerateUuid = false, randomBytes = null } = {}) {
  const out = profile._raw ? u8of(profile._raw).slice(0, PROFILE_SIZE) : new Uint8Array(PROFILE_SIZE);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[OFF.sentinel] = 0x02;

  if (profile.name != null) {
    for (let i = 0; i < NAME_MAX; i++) {
      dv.setUint16(OFF.name + 2 * i, i < profile.name.length ? profile.name.charCodeAt(i) : 0, true);
    }
  }

  if (regenerateUuid) {
    const rnd = randomBytes || defaultRandom(16);
    out.set(rnd.slice(0, 16), OFF.uuid);
  }

  let toggleBits = 0;
  const buttons = profile.buttons || [];
  for (let b = 0; b < BUTTON_COUNT; b++) {
    const base = OFF.buttons + b * BUTTON_STRIDE;
    const btn = buttons[b];
    if (btn) {
      dv.setUint8(base, btn.map1 & 0xff);
      dv.setUint8(base + 1, btn.map2 & 0xff);
      if (btn.toggle) toggleBits |= 1 << b;
    }
  }

  const ports = profile.ports || [];
  for (let p = 0; p < PORT_COUNT; p++) {
    const base = OFF.ports + p * PORT_STRIDE;
    const port = ports[p];
    if (!port) continue;
    if (port.kind === "none") {
      dv.setUint8(base, 0x00);
    } else if (port.kind === "stick") {
      dv.setUint8(base, 0x01);
      dv.setUint8(base + 1, port.stick & 0xff);
      dv.setUint8(base + 2, port.orientation & 0xff);
      // Stick tuning. 0 = firmware default. Written explicitly when the model carries them
      // (so edits persist); otherwise the bytes from _raw are kept as-is.
      if (port.sensitivity != null) dv.setUint8(base + 5, port.sensitivity & 0xff);
      if (Array.isArray(port.deadzone)) {
        for (let i = 0; i < 6; i++) dv.setUint8(base + 8 + i, port.deadzone[i] & 0xff);
      }
    } else if (port.kind === "button") {
      dv.setUint8(base, port.analog ? 0x02 : 0x03);
      dv.setUint8(base + 2, port.map1 & 0xff);
      dv.setUint8(base + 3, port.map2 & 0xff);
      if (port.toggle) toggleBits |= 1 << (9 + p);
    }
  }

  dv.setUint16(OFF.toggle, toggleBits, true);
  if (now != null) dv.setBigInt64(OFF.timestamp, BigInt(now), true);
  return out;
}

// ---- Transport packet builders (platform-agnostic) ----

// 0x60 command requesting profile N (1..3) be streamed back on 0x61.
export function buildReadCommand(profileNumber) {
  checkProfileNumber(profileNumber);
  const buf = new Uint8Array(CMD_PAYLOAD_SIZE);
  buf[0] = 0x10 + (profileNumber - 1);
  return buf;
}

// Reassemble a 956-byte profile from the 18 raw 0x61 responses. Each response is the
// full report (report id at [0]); payload starts at READ_PAYLOAD_OFFSET.
export function assembleProfile(packets) {
  const out = new Uint8Array(PROFILE_SIZE);
  for (let i = 0; i < PACKET_COUNT; i++) {
    const pkt = u8of(packets[i]);
    for (let j = 0; j < CHUNK; j++) {
      const idx = i * CHUNK + j;
      if (idx < PROFILE_SIZE) out[idx] = pkt[READ_PAYLOAD_OFFSET + j] ?? 0;
    }
  }
  return out;
}

// Build the 18 0x60 write packets for profile N from a 956-byte blob. CRC32 (LE) of the
// whole blob is embedded at offset 6 of the final packet. Returns CMD_PAYLOAD_SIZE buffers
// (no report id prefix — the transport adds 0x60).
export function buildWritePackets(profileNumber, profileBytes) {
  checkProfileNumber(profileNumber);
  const data = u8of(profileBytes);
  if (data.length < PROFILE_SIZE) throw new Error(`profile too short: ${data.length}`);
  const crc = crc32(data, PROFILE_SIZE);
  const packets = [];
  for (let i = 0; i < PACKET_COUNT; i++) {
    const buf = new Uint8Array(CMD_PAYLOAD_SIZE);
    const dv = new DataView(buf.buffer);
    buf[0] = 0x08 + profileNumber;
    buf[1] = i;
    for (let j = 0; j < CHUNK; j++) {
      const idx = i * CHUNK + j;
      if (idx < PROFILE_SIZE) buf[WRITE_PAYLOAD_OFFSET + j] = data[idx];
    }
    if (i === PACKET_COUNT - 1) dv.setUint32(6, crc, true);
    packets.push(buf);
  }
  return packets;
}

export const PACKETS_PER_PROFILE = PACKET_COUNT;

// ---- helpers ----
function checkProfileNumber(n) {
  if (!Number.isInteger(n) || n < 1 || n > PROFILE_COUNT) {
    throw new Error(`profile number must be 1..${PROFILE_COUNT}, got ${n}`);
  }
}
function u8of(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (Array.isArray(x)) return Uint8Array.from(x);
  throw new Error("expected bytes");
}
function defaultRandom(n) {
  const a = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(a);
  return a;
}

// Human-readable summary used by the CLI and (optionally) the UI.
export function describeProfile(p) {
  const lines = [`name: ${JSON.stringify(p.name)}`, `uuid: ${p.uuid}`];
  p.buttons.forEach((b, i) => {
    const m = ACTIONS[b.map1] ?? `?${b.map1}`;
    const m2 = b.map2 ? ` + ${ACTIONS[b.map2] ?? b.map2}` : "";
    lines.push(`  button ${i + 1}: ${m}${m2}${b.toggle ? " [toggle]" : ""}`);
  });
  p.ports.forEach((pt, i) => {
    let desc;
    if (pt.kind === "none") desc = "—";
    else if (pt.kind === "stick") {
      const tuned = pt.sensitivity || (pt.deadzone || []).some((x) => x);
      desc = `${STICKS[pt.stick] ?? "?"} (${ORIENTATIONS[pt.orientation] ?? "?"})` +
        (tuned ? ` [sens=${pt.sensitivity}, deadzone=${(pt.deadzone || []).map((x) => x.toString(16)).join(" ")}]` : "");
    }
    else desc = `${ACTIONS[pt.map1] ?? "?"}${pt.map2 ? " + " + (ACTIONS[pt.map2] ?? pt.map2) : ""}${pt.analog ? " [analog]" : ""}${pt.toggle ? " [toggle]" : ""}`;
    lines.push(`  port ${i}${i === 0 ? " (built-in stick)" : ""}: ${desc}`);
  });
  return lines.join("\n");
}
