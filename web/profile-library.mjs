// Profile sharing + preset library for the Access Controller — pure, I/O-free.
//
// A "portable" profile is a small, JSON-serializable subset of a decoded profile
// (name + button/port mappings) that can be exported to a file, encoded into a URL,
// or applied on top of an existing on-device profile. Device-specific fields (uuid,
// timestamp, raw bytes) are deliberately NOT carried — applyPortable() merges a
// portable onto a live profile so those fields survive.

export const PORTABLE_VERSION = 1;

// ---- conversion -------------------------------------------------------------

// Decoded profile -> portable spec. Only the user-meaningful mapping is kept.
export function toPortable(profile) {
  return {
    v: PORTABLE_VERSION,
    name: profile.name || "",
    buttons: (profile.buttons || []).map((b) => ({ map1: b.map1 | 0, map2: b.map2 | 0, toggle: !!b.toggle })),
    ports: (profile.ports || []).map(clonePort),
  };
}

// Apply a portable spec onto a live decoded profile, in place. Returns the profile.
// Keeps profile._raw / uuid / timestamp so a subsequent buildProfile() round-trips
// cleanly and only the mappings change.
export function applyPortable(profile, portable) {
  if (!portable || typeof portable !== "object") throw new Error("not a profile");
  if (typeof portable.name === "string") profile.name = portable.name.slice(0, 40);
  if (Array.isArray(portable.buttons)) {
    profile.buttons = profile.buttons.map((b, i) => {
      const src = portable.buttons[i];
      return src ? { map1: src.map1 | 0, map2: src.map2 | 0, toggle: !!src.toggle } : b;
    });
  }
  if (Array.isArray(portable.ports)) {
    profile.ports = profile.ports.map((p, i) => (portable.ports[i] ? clonePort(portable.ports[i]) : p));
  }
  return profile;
}

function clonePort(p) {
  if (!p || p.kind === "none") return { kind: "none" };
  if (p.kind === "stick") {
    return {
      kind: "stick", stick: p.stick | 0, orientation: p.orientation | 0,
      ...(p.sensitivity != null ? { sensitivity: p.sensitivity | 0 } : {}),
      ...(Array.isArray(p.deadzone) ? { deadzone: p.deadzone.slice(0, 6).map((x) => x | 0) } : {}),
    };
  }
  if (p.kind === "button") return { kind: "button", analog: !!p.analog, map1: p.map1 | 0, map2: p.map2 | 0, toggle: !!p.toggle };
  return { kind: "none" };
}

// ---- share encoding (URL-safe, no server) -----------------------------------

export function encodeShare(portable) {
  const json = JSON.stringify(portable);
  return base64urlEncode(json);
}

export function decodeShare(str) {
  const portable = JSON.parse(base64urlDecode(String(str).trim()));
  if (!portable || portable.v !== PORTABLE_VERSION) throw new Error("unsupported or corrupt share code");
  return portable;
}

// Build a shareable URL whose hash carries the profile (e.g. .../#p=<code>).
export function shareURL(portable, base) {
  const origin = base || (typeof location !== "undefined" ? location.origin + location.pathname : "");
  return `${origin}#p=${encodeShare(portable)}`;
}

// Pull a portable out of a URL hash, or null if none. Accepts "#p=..." or "p=...".
export function parseShareHash(hash) {
  if (!hash) return null;
  const m = String(hash).replace(/^#/, "").match(/(?:^|&)p=([^&]+)/);
  if (!m) return null;
  try { return decodeShare(decodeURIComponent(m[1])); } catch { return null; }
}

// ---- file import/export -----------------------------------------------------

// Serialize a portable to file text (pretty JSON, with a type tag for sniffing).
export function toFileText(portable) {
  return JSON.stringify({ type: "ps-access-profile", ...portable }, null, 2);
}

// Parse uploaded text. Accepts: a portable file (this app), a raw portable object,
// a share code, or a CLI backup ({ profiles:[{ decoded }] }) — picking a slot.
export function fromFileText(text, slot = 0) {
  const s = String(text).trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return decodeShare(s); // bare share code
  const obj = JSON.parse(s);
  if (Array.isArray(obj.profiles)) {
    const entry = obj.profiles.find((p) => p.slot === slot + 1) || obj.profiles[0];
    if (!entry?.decoded) throw new Error("backup file has no decoded profile");
    return toPortable(entry.decoded);
  }
  if (Array.isArray(obj.buttons) || Array.isArray(obj.ports)) {
    return { v: PORTABLE_VERSION, name: obj.name || "", buttons: obj.buttons || [], ports: obj.ports || [] };
  }
  throw new Error("unrecognized profile file");
}

// ---- preset library ---------------------------------------------------------
//
// Curated STARTING POINTS, not prescriptions — every body and game is different, so
// these are meant to be applied and then customized. Codes match access-protocol ACTIONS:
//   0 nothing 1 circle 2 cross 3 triangle 4 square 5 up 6 down 7 left 8 right
//   9 L1 10 R1 11 L2 12 R2 13 L3 14 R3 15 options 16 create 17 PS 18 touchpad
// Ports: index 0 = built-in stick; 1..4 = expansion jacks (external switches).

const btn = (map1, opts = {}) => ({ map1, map2: opts.map2 || 0, toggle: !!opts.toggle });
const portBtn = (map1, opts = {}) => ({ kind: "button", analog: false, map1, map2: 0, toggle: !!opts.toggle });
const stickPort = (stick, orientation) => ({ kind: "stick", stick, orientation });

export const PRESETS = [
  {
    id: "reset-neutral",
    name: "Neutral reset",
    description: "Clears expansion ports and sets a left stick. A clean baseline to build on.",
    tags: ["baseline"],
    portable: {
      v: PORTABLE_VERSION, name: "Neutral",
      buttons: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => btn(c)),
      ports: [stickPort(1, 3), { kind: "none" }, { kind: "none" }, { kind: "none" }, { kind: "none" }],
    },
  },
  {
    id: "toggle-triggers",
    name: "Toggle triggers & sprint",
    description: "Makes L2/R2 and L3 (sprint/aim) toggle instead of hold — press once on, once off. Reduces sustained-hold fatigue.",
    tags: ["fatigue", "low-force"],
    portable: {
      v: PORTABLE_VERSION, name: "Toggles",
      buttons: [btn(1), btn(2), btn(3), btn(4), btn(5), btn(6), btn(11, { toggle: true }), btn(12, { toggle: true }), btn(13, { toggle: true }), btn(10)],
      ports: [stickPort(1, 3), { kind: "none" }, { kind: "none" }, { kind: "none" }, { kind: "none" }],
    },
  },
  {
    id: "one-handed-right",
    name: "One-handed (stick on right)",
    description: "Built-in stick on the right side; the four expansion ports become Cross, Circle, Square, Triangle for external switches placed within reach.",
    tags: ["one-handed", "switch-access"],
    portable: {
      v: PORTABLE_VERSION, name: "One-hand R",
      buttons: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => btn(c)),
      ports: [stickPort(1, 1), portBtn(2), portBtn(1), portBtn(4), portBtn(3)],
    },
  },
  {
    id: "external-dpad",
    name: "External switches → D-pad",
    description: "Maps the four expansion ports to Up, Down, Left, Right for menu/navigation control with separate adaptive switches.",
    tags: ["switch-access", "navigation"],
    portable: {
      v: PORTABLE_VERSION, name: "Switch D-pad",
      buttons: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => btn(c)),
      ports: [stickPort(1, 3), portBtn(5), portBtn(6), portBtn(7), portBtn(8)],
    },
  },
];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

// ---- base64url helpers (work in browser and Node) ---------------------------

function base64urlEncode(str) {
  const b64 = typeof btoa === "function"
    ? btoa(unescape(encodeURIComponent(str)))
    : Buffer.from(str, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  if (typeof atob === "function") return decodeURIComponent(escape(atob(b64)));
  return Buffer.from(b64, "base64").toString("utf8");
}
