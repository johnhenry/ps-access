// XMB-style full-screen configurator for the PlayStation Access Controller.
import {
  ACTIONS, STICKS, ORIENTATIONS, PROFILE_COUNT,
  STICK_DEFAULT_SENSITIVITY, STICK_DEFAULT_DEADZONE,
  parseProfile, buildProfile,
} from "./access-protocol.mjs";
import {
  hidSupported, grantedControllers, requestControllers, ensureOpen,
  readProfileRaw, writeProfileRaw, setActiveProfile,
} from "./hid-web.mjs";
import { SYMBOLS, symLabel, nameLabel, M, profileSVG, decodePhysical, PHYS_NAMES } from "./controller-render.mjs";
import {
  PRESETS, toPortable, applyPortable, shareURL, parseShareHash, toFileText, fromFileText,
} from "./profile-library.mjs";
import {
  PHYS_LABELS, STICK_MODES, STICK_DIRS, defaultBridgeMap, keyEventToValue, displayValue,
  toConfigJSON, runCommand,
} from "./bridge-map.mjs";

const $ = (s) => document.querySelector(s);

// ============================ state ============================
// Each controller carries its own UI state now (no global activeCtrl): _activeProfile = active
// on-device profile slot (0-based, from byte 39); _lastSlot = last profile cell focused in its lane.
let controllers = []; // { device, name, profiles:[x3], _activeProfile:null, _lastSlot:0 }
// nav: a 2D grid. gr/gc = focused cell; inCell = that cell's menu is open; row = item index in the
// menu; drill = { key, index } when inside a profile sub-section (Buttons/Stick/Ports/Tuning).
const nav = { gr: 0, gc: 0, inCell: false, row: 0, drill: null };
let soundOn = false;
let phys = new Set();      // union of physically-pressed buttons across all controllers (0-9)
let liveAxes = [0, 0];     // union physical stick, -1..1
let lastInputAt = 0;
let renaming = false;
let monitorMode = false;   // full-screen live input monitor open
let monitorArm = false;    // warning/confirm gate shown before entering the monitor
let warnSel = 0;           // highlighted option on the confirm gate (0 = Start, 1 = Cancel)
let pendingShare = null;   // a portable profile decoded from the URL hash, awaiting "Apply shared"
let bridgeMap = loadBridgeMap();  // PC input-bridge mapping edited in the Key Bridge blade
let capturing = null;      // { kind:"button", idx } | { kind:"stick", dir } while listening for a key

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The navigable grid, rebuilt from the live controller list: two global tool rows, one lane per
// controller (head · P1 · P2 · P3 · Save · Library · Disconnect), then the Connect row.
function grid() {
  const rows = [
    { cells: [{ kind: "bridge", label: "Key Bridge" }] },
    { cells: [{ kind: "monitor", label: "Monitor" }] },
  ];
  controllers.forEach((c, ci) => rows.push({ ctrl: ci, cells: [
    { kind: "head", ctrl: ci },
    { kind: "profile", ctrl: ci, slot: 0 },
    { kind: "profile", ctrl: ci, slot: 1 },
    { kind: "profile", ctrl: ci, slot: 2 },
    { kind: "save", ctrl: ci },
    { kind: "library", ctrl: ci },
    { kind: "disconnect", ctrl: ci },
  ] }));
  rows.push({ cells: [{ kind: "connect", label: "＋ Connect a controller…" }] });
  return rows;
}
function cellAt(gr, gc) {
  const g = grid();
  const row = g[clamp(gr, 0, g.length - 1)];
  return row.cells[clamp(gc, 0, row.cells.length - 1)];
}
function focusedCell() { return cellAt(nav.gr, nav.gc); }
function cellCtrl(cell = focusedCell()) { return cell.ctrl != null ? controllers[cell.ctrl] : null; }
function cellProfile(cell = focusedCell()) {
  return cell.kind === "profile" ? (controllers[cell.ctrl]?.profiles[cell.slot] || null) : null;
}
// The slot Save/Library act on in a lane: the last profile cell focused there (default 0).
function laneSlot(ci) { return controllers[ci]?._lastSlot ?? 0; }
// Keep focus inside the current grid (after add/remove/disconnect).
function clampNav() {
  const g = grid();
  nav.gr = clamp(nav.gr, 0, g.length - 1);
  nav.gc = clamp(nav.gc, 0, g[nav.gr].cells.length - 1);
}

function loadBridgeMap() {
  try { const s = localStorage.getItem("psaccess.bridgeMap"); if (s) return JSON.parse(s); } catch { /* ignore */ }
  return defaultBridgeMap();
}
function saveBridgeMap() {
  try { localStorage.setItem("psaccess.bridgeMap", JSON.stringify(bridgeMap)); } catch { /* ignore */ }
}

// Stylized, generic gamepad icon for the Controllers blade. Parts use the same `.seg` class
// as the profile controller render, so it inherits the identical segment styling.
const CONTROLLER_ICON = `<svg class="ctrl-icon" viewBox="0 0 120 92" xmlns="http://www.w3.org/2000/svg">
  <path class="seg" d="M45 28 H75 C90 28 95 35 99 47 L107 67 C111 80 98 86 91 75 L83 61 C80 56 77 54 72 54 H48 C43 54 40 56 37 61 L29 75 C22 86 9 80 13 67 L21 47 C25 35 30 28 45 28 Z"/>
  <path class="seg" d="M34.5 33.5 H41.5 V39 H47 V46 H41.5 V51.5 H34.5 V46 H29 V39 H34.5 Z"/>
  <circle class="seg" cx="82" cy="34" r="4.2"/>
  <circle class="seg" cx="91" cy="43" r="4.2"/>
  <circle class="seg" cx="73" cy="43" r="4.2"/>
  <circle class="seg" cx="82" cy="52" r="4.2"/>
</svg>`;

// Stylized "eject / disconnect" icon for the per-lane Disconnect cell — same `.seg` style.
const DISCONNECT_ICON = `<svg class="save-icon" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
  <path class="seg" d="M48 22 L70 50 H26 Z"/>
  <rect class="seg" x="26" y="60" width="44" height="12" rx="3"/>
</svg>`;

// Stylized, generic save (floppy-disk) icon for the Save blade — same `.seg` segment style.
const SAVE_ICON = `<svg class="save-icon" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
  <path class="seg" d="M28 20 H60 L76 36 V68 Q76 76 68 76 H28 Q20 76 20 68 V28 Q20 20 28 20 Z"/>
  <rect class="seg" x="38" y="20" width="18" height="16" rx="2"/>
  <rect class="seg" x="32" y="48" width="32" height="22" rx="3"/>
</svg>`;

// Stylized "live signal" waveform for the Monitor blade (a stroked line, not segments —
// it reads instantly as activity/input).
const MONITOR_ICON = `<svg class="mon-icon" viewBox="0 0 120 92" xmlns="http://www.w3.org/2000/svg">
  <polyline class="wave" points="12,52 30,52 40,30 52,68 64,22 76,52 86,44 108,44"/>
</svg>`;

// Stylized "library / share" icon (stacked cards) for the Library blade — same `.seg` style.
const LIBRARY_ICON = `<svg class="save-icon" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
  <rect class="seg" x="22" y="30" width="40" height="44" rx="5"/>
  <rect class="seg" x="34" y="22" width="40" height="44" rx="5"/>
</svg>`;

// Stylized keyboard icon for the Key Bridge blade — same `.seg` style.
const BRIDGE_ICON = `<svg class="ctrl-icon" viewBox="0 0 120 92" xmlns="http://www.w3.org/2000/svg">
  <rect class="seg" x="12" y="26" width="96" height="48" rx="9"/>
  <rect class="seg" x="24" y="37" width="10" height="10" rx="2"/>
  <rect class="seg" x="40" y="37" width="10" height="10" rx="2"/>
  <rect class="seg" x="56" y="37" width="10" height="10" rx="2"/>
  <rect class="seg" x="72" y="37" width="10" height="10" rx="2"/>
  <rect class="seg" x="88" y="37" width="8" height="10" rx="2"/>
  <rect class="seg" x="40" y="53" width="40" height="10" rx="2"/>
</svg>`;

// Apply live physical state: every controller identity render (focused-row head blade + the dimmed
// row anchors) shows ITS controller's own input; the drill hero shows the focused controller's.
function updateLive() {
  for (const head of document.querySelectorAll("[data-ctrl]")) {
    const ci = +head.dataset.ctrl;
    const st = controllers[ci] && ctrlState.get(controllers[ci].device);
    const btns = st ? st.buttons : new Set();
    const ax = st ? st.axes : [0, 0];
    for (const el of head.querySelectorAll("svg [data-btn]")) el.classList.toggle("on", btns.has(+el.getAttribute("data-btn")));
    const th = head.querySelector("svg .thumb");
    if (th) { th.setAttribute("cx", (+th.dataset.bx + ax[0] * M.THUMB_R).toFixed(1)); th.setAttribute("cy", (+th.dataset.by + ax[1] * M.THUMB_R).toFixed(1)); }
  }
  const hero = $("#hero");
  for (const el of hero.querySelectorAll("svg [data-btn]")) el.classList.toggle("on", phys.has(+el.getAttribute("data-btn")));
  const hth = hero.querySelector("svg .thumb");
  if (hth) { hth.setAttribute("cx", (+hth.dataset.bx + liveAxes[0] * M.THUMB_R).toFixed(1)); hth.setAttribute("cy", (+hth.dataset.by + liveAxes[1] * M.THUMB_R).toFixed(1)); }
  // Key Bridge: light up the menu row for whichever physical button is being pressed.
  for (const row of document.querySelectorAll("#items .item[data-phys]")) row.classList.toggle("physdown", phys.has(+row.dataset.phys));
}

// ============================ value spinners ============================
const BTN_VALUES = Object.keys(ACTIONS).map(Number);                       // 0..18
const PORT_VALUES = [0, 101, 102, ...Object.keys(ACTIONS).map(Number).filter((c) => c !== 0)];
const ORIENT_VALUES = [3, 2, 1, 0];
const STICK_ASSIGN = [0, 1, 2]; // off / left / right

function portLabel(v) {
  if (v === 0) return { sym: "—", name: "Not assigned" };
  if (v > 100) return { sym: "", name: STICKS[v - 100] };
  return { sym: SYMBOLS[v] || "", name: ACTIONS[v] };
}

// Build the list of editable rows for a drill key on a profile.
function drillRows(profile, key) {
  if (key === "buttons") {
    return profile.buttons.map((b, i) => ({
      label: `Button ${i + 1}`, focus: { type: "button", index: i },
      get: () => b.map1, set: (v) => { b.map1 = v; }, values: BTN_VALUES,
      display: (v) => ({ sym: v === 0 ? "—" : (SYMBOLS[v] || ""), name: nameLabel(v) }),
    }));
  }
  if (key === "ports") {
    return [1, 2, 3, 4].map((p) => {
      const port = profile.ports[p];
      return {
        label: `Port ${p}`, focus: { type: "port", index: p },
        get: () => (port.kind === "stick" ? 100 + port.stick : port.kind === "button" ? port.map1 : 0),
        set: (v) => {
          if (v === 0) profile.ports[p] = { kind: "none" };
          else if (v > 100) profile.ports[p] = { kind: "stick", stick: v - 100, orientation: profile.ports.find((x) => x.kind === "stick")?.orientation ?? 3 };
          else profile.ports[p] = { kind: "button", analog: false, map1: v, map2: 0, toggle: false };
        }, values: PORT_VALUES, display: portLabel,
      };
    });
  }
  if (key === "stick") {
    const st = profile.ports[0];
    return [
      {
        label: "Assignment", focus: { type: "stick" },
        get: () => (st.kind === "stick" ? st.stick : 0),
        set: (v) => { if (v === 0) profile.ports[0] = { kind: "none" }; else profile.ports[0] = { kind: "stick", stick: v, orientation: st.kind === "stick" ? st.orientation : 3, sensitivity: st.sensitivity ?? 0, deadzone: st.deadzone ?? [0, 0, 0, 0, 0, 0] }; },
        values: STICK_ASSIGN, display: (v) => ({ sym: "", name: v === 0 ? "Off" : STICKS[v] }),
      },
      {
        label: "Orientation", focus: { type: "stick" },
        get: () => (st.kind === "stick" ? st.orientation : 3),
        set: (v) => { for (const pt of profile.ports) if (pt.kind === "stick") pt.orientation = v; },
        values: ORIENT_VALUES, display: (v) => ({ sym: "", name: ORIENTATIONS[v] }),
      },
    ];
  }
  if (key === "tuning") {
    const st = profile.ports[0];
    const ensure = () => { if (st.kind === "stick") { st.sensitivity ??= 0; st.deadzone ??= [0, 0, 0, 0, 0, 0]; } };
    const dz = (idx) => ({
      label: ["Inner deadzone", "Curve", "Outer deadzone"][idx], focus: { type: "stick" },
      get: () => (st.deadzone ? st.deadzone[idx * 2] : 0),
      set: (v) => { ensure(); st.deadzone = (st.deadzone || [0, 0, 0, 0, 0, 0]).slice(); st.deadzone[idx * 2] = st.deadzone[idx * 2 + 1] = v; },
      values: Array.from({ length: 18 }, (_, i) => i * 15).concat(255), display: (v) => ({ sym: "", name: String(v) }),
    });
    return [
      { label: "Sensitivity", focus: { type: "stick" }, get: () => st.sensitivity ?? 0, set: (v) => { ensure(); st.sensitivity = v; }, values: Array.from({ length: 11 }, (_, i) => i), display: (v) => ({ sym: "", name: v === 0 ? "default" : String(v) }) },
      dz(0), dz(1), dz(2),
    ];
  }
  return [];
}

// vertical items for the focused blade
// Items shown when a cell's menu is opened. `cell` carries its controller (cell.ctrl) and, for
// profiles, the slot — so everything targets the right controller without a global activeCtrl.
function bladeItems(cell) {
  if (cell.kind === "profile") {
    const isActive = cell.slot === controllers[cell.ctrl]?._activeProfile;
    return [
      { key: "buttons", label: "Buttons", drill: true },
      { key: "stick", label: "Built-in stick", drill: true },
      { key: "ports", label: "Expansion ports", drill: true },
      { key: "tuning", label: "Stick tuning", drill: true },
      { key: "rename", label: "Rename profile", action: "rename" },
      { key: "setactive", label: isActive ? "✓ Active on controller" : "Set active on controller", action: "setActive" },
      { key: "save", label: `Save Profile ${cell.slot + 1} to controller`, action: "save" },
    ];
  }
  if (cell.kind === "save") {
    const ci = cell.ctrl;
    return [
      { key: "save0", label: `Save Profile 1${nameSuffix(ci, 0)}`, action: "save", slot: 0 },
      { key: "save1", label: `Save Profile 2${nameSuffix(ci, 1)}`, action: "save", slot: 1 },
      { key: "save2", label: `Save Profile 3${nameSuffix(ci, 2)}`, action: "save", slot: 2 },
      { key: "saveall", label: "Save all 3 profiles", action: "saveAll" },
      { key: "reload", label: "Reload from controller", action: "reload" },
    ];
  }
  if (cell.kind === "library") {
    const slot = laneSlot(cell.ctrl);
    const items = [];
    if (pendingShare) {
      items.push({ key: "applyshared", label: `Apply shared profile${pendingShare.name ? ` · ${pendingShare.name}` : ""} → Profile ${slot + 1}`, action: "applyShared" });
    }
    items.push(
      { key: "export", label: `Export Profile ${slot + 1} (download file)`, action: "export" },
      { key: "copylink", label: `Copy share link for Profile ${slot + 1}`, action: "copylink" },
      { key: "import", label: `Import from file → Profile ${slot + 1}`, action: "import" },
    );
    PRESETS.forEach((p, i) => items.push({ key: "preset" + i, label: `Preset · ${p.name} → Profile ${slot + 1}`, action: "applyPreset", preset: i }));
    return items;
  }
  if (cell.kind === "bridge") {
    const cap = (c) => (capturing && capturing.kind === c.kind && capturing.idx === c.idx && capturing.dir === c.dir);
    const items = [];
    PHYS_LABELS.forEach((lab, i) => {
      const c = { kind: "button", idx: i, dir: undefined };
      items.push({ key: "b" + i, phys: i, action: "capture", cap: c,
        label: `${lab} → ${cap(c) ? "press a key… (Esc)" : displayValue(bridgeMap.buttons[i])}` });
    });
    items.push({ key: "stickmode", action: "cycleStick", label: `Stick mode → ${bridgeMap.stick.mode}` });
    if (bridgeMap.stick.mode === "keys") {
      STICK_DIRS.forEach((dir) => {
        const c = { kind: "stick", idx: undefined, dir };
        items.push({ key: "sd-" + dir, action: "capture", cap: c,
          label: `Stick ${dir} → ${cap(c) ? "press a key… (Esc)" : displayValue(bridgeMap.stick[dir])}` });
      });
    }
    items.push(
      { key: "br-reset", label: "Reset to defaults", action: "bridgeReset" },
      { key: "br-export", label: "Export config for the ps-access CLI (bridge.json)", action: "bridgeExport" },
      { key: "br-json", label: "Copy config JSON", action: "bridgeCopyJson" },
      { key: "br-cmd", label: "Copy CLI run command (npx ps-access-bridge)", action: "bridgeCopyCmd" },
    );
    return items;
  }
  return [];
}
function nameSuffix(ci, slot) {
  const n = controllers[ci]?.profiles[slot]?.name;
  return n ? ` · ${n}` : "";
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function cellLabel(cell) {
  switch (cell.kind) {
    case "bridge": return "Key Bridge";
    case "monitor": return "Monitor";
    case "connect": return "＋ Connect a controller…";
    case "head": return controllers[cell.ctrl]?.name || "Controller";
    case "profile": return `Profile ${cell.slot + 1}`;
    case "save": return "Save";
    case "library": return "Library";
    case "disconnect": return "Disconnect";
  }
  return "";
}
const GLYPHS = { save: SAVE_ICON, monitor: MONITOR_ICON, library: LIBRARY_ICON, bridge: BRIDGE_ICON,
                 connect: CONTROLLER_ICON, disconnect: DISCONNECT_ICON };
// The big blade in the focused row's horizontal ribbon.
function bladeInner(cell) {
  if (cell.kind === "profile") {
    const c = controllers[cell.ctrl];
    const active = c && c._activeProfile === cell.slot;
    const name = c?.profiles[cell.slot]?.name;
    return `<div class="ic">${profileSVG(c?.profiles[cell.slot])}</div>` +
      `<div class="label">${active ? "✓ " : ""}Profile ${cell.slot + 1}${name ? ` · ${esc(name)}` : ""}</div>`;
  }
  if (cell.kind === "head") {
    const c = controllers[cell.ctrl];
    return `<div class="ic">${profileSVG(c?.profiles[c?._activeProfile ?? 0])}</div>` +
      `<div class="label">${esc(c?.name || "Controller")}</div>`;
  }
  return `<div class="ic"><div class="glyph">${GLYPHS[cell.kind] || ""}</div></div><div class="label">${cellLabel(cell)}</div>`;
}
// A row's vertical-axis identity (the dimmed anchor shown for non-focused rows).
function rowName(row) { return cellCtrl(row.cells[0]) ? controllers[row.cells[0].ctrl].name : cellLabel(row.cells[0]); }
function anchorIcon(row) {
  const cell = row.cells[0];
  if (cell.kind === "head") return profileSVG(controllers[cell.ctrl]?.profiles[controllers[cell.ctrl]?._activeProfile ?? 0]);
  return `<div class="glyph">${GLYPHS[cell.kind] || ""}</div>`;
}

// XMB cross: a vertical column of row anchors (controllers + tools); the focused row's blades fan
// out horizontally to the right; neighbors are dimmed and glide vertically.
function render() {
  const fc = focusedCell();
  if (fc.kind === "profile" && controllers[fc.ctrl]) controllers[fc.ctrl]._lastSlot = fc.slot;
  setWaveProfile(cellCtrl(fc)?._activeProfile ?? null); // tint the wave to the focused lane's active profile
  updateDeviceStatus();
  const wrap = $("#blades");
  wrap.innerHTML = "";
  grid().forEach((row, ri) => {
    const off = ri - nav.gr;
    const rowEl = document.createElement("div");
    rowEl.className = "row" + (off === 0 ? " focused" : "");
    rowEl.style.setProperty("--off", off);
    rowEl.style.opacity = off === 0 ? "1" : String(Math.max(0.16, 0.5 - 0.13 * Math.abs(off)));
    if (off === 0) {
      const ribbon = document.createElement("div");
      ribbon.className = "ribbon";
      row.cells.forEach((cell, ci) => {
        const el = document.createElement("div");
        el.className = "blade k-" + cell.kind + (ci === nav.gc ? " focused" : "");
        if (cell.kind === "head") el.dataset.ctrl = cell.ctrl;
        el.innerHTML = bladeInner(cell);
        el.onclick = () => { nav.gc = ci; nav.inCell = false; nav.drill = null; openCell(); };
        ribbon.append(el);
      });
      rowEl.append(ribbon);
    } else {
      const anchor = document.createElement("div");
      anchor.className = "anchor";
      if (row.cells[0].kind === "head") anchor.dataset.ctrl = row.cells[0].ctrl;
      anchor.innerHTML = `<div class="ic">${anchorIcon(row)}</div><div class="label">${esc(rowName(row))}</div>`;
      anchor.onclick = () => { nav.gr = ri; nav.gc = clamp(nav.gc, 0, row.cells.length - 1); nav.inCell = false; nav.drill = null; render(); };
      rowEl.append(anchor);
    }
    wrap.append(rowEl);
  });
  wrap.classList.toggle("incell", nav.inCell || !!nav.drill);
  renderItems();
  renderHero();
  renderCrumb();
  layout();
  updateLive();
  announce(describeNav());
}

function renderItems() {
  const wrap = $("#items");
  wrap.innerHTML = "";
  const open = nav.inCell || nav.drill;
  wrap.classList.toggle("show", !!open);
  if (!open) return;
  const cell = focusedCell();
  wrap.setAttribute("role", "listbox");
  wrap.setAttribute("aria-label", cellLabel(cell) + (nav.drill ? " " + (DRILL_LABELS[nav.drill.key] || "") : "") + " options");
  if (nav.drill) {
    const rows = drillRows(cellProfile(cell), nav.drill.key);
    rows.forEach((r, i) => {
      const disp = r.display(r.get());
      const el = document.createElement("div");
      el.className = "item" + (i === nav.drill.index ? " sel" : "");
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", String(i === nav.drill.index));
      el.setAttribute("aria-label", `${r.label}: ${disp.name}`);
      el.innerHTML = `<span class="lab">${r.label}</span><span class="val"><span class="arrow">◀</span><span class="sym">${disp.sym || ""}</span> ${disp.name}<span class="arrow">▶</span></span>`;
      el.onclick = () => { nav.drill.index = i; render(); };
      wrap.append(el);
    });
  } else {
    bladeItems(cell).forEach((it, i) => {
      const el = document.createElement("div");
      el.className = "item" + (i === nav.row ? " sel" : "");
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", String(i === nav.row));
      if (it.phys != null) el.dataset.phys = it.phys; // Key Bridge: highlight when that button is pressed
      el.innerHTML = `<span class="chev">▸</span><span class="lab">${it.label}</span>`;
      el.onclick = () => { nav.row = i; activateItem(); };
      wrap.append(el);
    });
  }
}

function renderHero() {
  const hero = $("#hero");
  const profile = cellProfile();
  if (!nav.drill || !profile) { hero.style.opacity = "0"; hero.innerHTML = ""; return; }
  const rows = drillRows(profile, nav.drill.key);
  const focus = rows[nav.drill.index]?.focus || null;
  hero.innerHTML = profileSVG(profile, { focus });
  hero.style.opacity = ".97";
}

const DRILL_LABELS = { buttons: "Buttons", stick: "Built-in stick", ports: "Expansion ports", tuning: "Stick tuning" };

function renderCrumb() {
  const cell = focusedCell();
  let txt = cellCtrl(cell) ? `${controllers[cell.ctrl].name} ›  ${cellLabel(cell)}` : cellLabel(cell);
  if (nav.drill) txt += " ›  " + (DRILL_LABELS[nav.drill.key] || "");
  $("#crumb").textContent = txt;
}

// ============================ screen-reader announcer ============================
let lastAnnounce = "";
function announce(msg) {
  const el = $("#sr");
  if (!el || !msg) return;
  // Re-set even when identical so assistive tech re-reads (toggle a trailing marker).
  el.textContent = msg === lastAnnounce ? msg + "​" : msg;
  lastAnnounce = el.textContent;
}

// Concise description of the current focus, spoken by screen readers on every nav change.
function describeNav() {
  if (capturing) return "Listening — press a keyboard key to assign, Delete to clear, or Escape to cancel.";
  if (monitorMode) return "Live input monitor open, showing all connected controllers. Press Escape to exit.";
  if (monitorArm) return `Start the live monitor? ${warnSel === 0 ? "Start monitoring" : "Cancel"}, option ${warnSel + 1} of 2. Up or Down to choose, Enter to confirm.`;
  const cell = focusedCell();
  const where = (cellCtrl(cell) ? controllers[cell.ctrl].name + ", " : "") + cellLabel(cell);
  if (nav.drill) {
    const prof = cellProfile(cell);
    if (!prof) return `${where}, ${DRILL_LABELS[nav.drill.key] || ""}`;
    const rows = drillRows(prof, nav.drill.key);
    const r = rows[nav.drill.index];
    if (!r) return `${where}, ${DRILL_LABELS[nav.drill.key] || ""}`;
    const disp = r.display(r.get());
    return `${where}, ${DRILL_LABELS[nav.drill.key] || ""}. ${r.label}: ${disp.name}. ${nav.drill.index + 1} of ${rows.length}. Left or Right to change, Backspace to go back.`;
  }
  if (nav.inCell) {
    const items = bladeItems(cell);
    const it = items[nav.row];
    const label = it ? it.label.replace(/\s+/g, " ").trim() : "";
    return `${where} menu. ${label}. ${nav.row + 1} of ${items.length}. Enter to choose, Backspace to go back.`;
  }
  const g = grid();
  return `${where}. Row ${nav.gr + 1} of ${g.length}, column ${nav.gc + 1} of ${g[nav.gr].cells.length}. Enter to open.`;
}

// Slide the focused row's ribbon so the focused blade glides to the focal column (XMB-style).
function layout() {
  const ribbon = $("#blades .row.focused .ribbon");
  const fb = $("#blades .blade.focused");
  if (ribbon && fb) {
    const bladesLeft = $("#blades").getBoundingClientRect().left;
    const center = bladesLeft + fb.offsetLeft + fb.offsetWidth / 2; // layout position, ignores current transform
    const focalX = window.innerWidth * 0.30;
    ribbon.style.transform = `translateX(${(focalX - center).toFixed(1)}px)`;
  }
  if (nav.inCell || nav.drill) {
    const sel = $("#items .item.sel");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }
}

// ============================ actions ============================
// Grid-mode confirm: open the focused cell. Drillable cells (profile/save/library/bridge) show
// their menu; the rest act directly.
function openCell() {
  const cell = focusedCell();
  blip(660);
  switch (cell.kind) {
    case "profile":
      if (!cellProfile(cell)) { toast("Connect a controller first"); return; }
      // fallthrough
    case "save": case "library": case "bridge":
      nav.inCell = true; nav.row = 0; nav.drill = null; render(); break;
    case "monitor": armMonitor(); break;
    case "connect": connectOnce(); break;
    case "head": startRenameController(cell.ctrl); break;
    case "disconnect": disconnectController(cell.ctrl); break;
  }
}

// Menu-mode confirm: act on the highlighted item of the open cell (its controller is cell.ctrl).
function activateItem() {
  const cell = focusedCell();
  const ci = cell.ctrl;
  const it = bladeItems(cell)[nav.row];
  if (!it) return;
  blip(660);
  if (it.drill) {
    if (!cellProfile(cell)) { toast("Connect a controller to edit a profile"); return; }
    nav.drill = { key: it.key, index: 0 }; render(); return;
  }
  switch (it.action) {
    case "rename": startRenameProfile(ci, cell.slot); break;
    case "save": saveProfileFor(ci, it.slot ?? cell.slot); break;
    case "saveAll": saveAll(ci); break;
    case "reload": reloadFromDevice(ci); break;
    case "setActive": setActiveFor(ci, cell.slot); break;
    case "export": exportProfile(ci); break;
    case "copylink": copyShareLink(ci); break;
    case "import": importProfile(ci); break;
    case "applyPreset": applyPresetToCurrent(ci, it.preset); break;
    case "applyShared": applySharedToCurrent(ci); break;
    case "capture": startCapture(it.cap); break;
    case "cycleStick": cycleStickMode(); break;
    case "bridgeReset": bridgeMap = defaultBridgeMap(); saveBridgeMap(); render(); toast("Bridge mapping reset to defaults"); break;
    case "bridgeExport": downloadText("ps-access-bridge.json", toConfigJSON(bridgeMap)); toast("Exported bridge.json — run it with: npx ps-access-bridge --config bridge.json", 5000); break;
    case "bridgeCopyJson": copyText(toConfigJSON(bridgeMap)).then((ok) => toast(ok ? "Config JSON copied" : "Copy failed", 2500)); break;
    case "bridgeCopyCmd": copyText(runCommand()).then((ok) => toast(ok ? "Run command copied" : "Copy failed", 2500)); break;
  }
}

// ============================ Key Bridge editor ============================
// Start listening for a keyboard key to assign to a physical button or stick direction.
function startCapture(cap) {
  capturing = cap;
  render();
  toast("Press a keyboard key to assign · Esc cancels · Delete clears", 6000);
}
function finishCapture(value) {
  if (!capturing) return;
  if (capturing.kind === "button") bridgeMap.buttons[capturing.idx] = value;
  else bridgeMap.stick[capturing.dir] = value;
  capturing = null;
  saveBridgeMap();
  render();
  blip(720);
}
function cycleStickMode() {
  const i = STICK_MODES.indexOf(bridgeMap.stick.mode);
  bridgeMap.stick.mode = STICK_MODES[(i + 1) % STICK_MODES.length];
  saveBridgeMap();
  render();
  toast(`Stick mode: ${bridgeMap.stick.mode}`, 1800);
}

// ============================ library / sharing ============================
function libProfile(ci) {
  return controllers[ci]?.profiles[laneSlot(ci)] || null;
}
function libSlotName(ci) { return `Profile ${laneSlot(ci) + 1}`; }

function exportProfile(ci) {
  const p = libProfile(ci);
  if (!p) { toast("Connect a controller first"); return; }
  const base = (p.name || libSlotName(ci)).replace(/[^\w.-]+/g, "_");
  downloadText(`${base}.ps-access.json`, toFileText(toPortable(p)));
  toast(`Exported ${libSlotName(ci)}`, 2500);
}

async function copyShareLink(ci) {
  const p = libProfile(ci);
  if (!p) { toast("Connect a controller first"); return; }
  const url = shareURL(toPortable(p));
  const ok = await copyText(url);
  toast(ok ? "Share link copied to clipboard" : "Couldn't copy — link is now in the address bar", 3500);
  if (!ok) { try { location.hash = url.split("#")[1]; } catch { /* ignore */ } }
}

function importProfile(ci) {
  const p = libProfile(ci);
  if (!p) { toast("Connect a controller first"); return; }
  pickFile(".json,.txt", (text) => {
    try {
      applyPortable(p, fromFileText(text, laneSlot(ci)));
      render();
      toast(`Imported into ${libSlotName(ci)} — Save to write it to the controller`, 4000);
      blip(720);
    } catch (e) { toast("Import failed: " + (e.message || e), 4000); }
  });
}

function applyPresetToCurrent(ci, index) {
  const p = libProfile(ci);
  if (!p) { toast("Connect a controller first"); return; }
  const preset = PRESETS[index];
  if (!preset) return;
  applyPortable(p, preset.portable);
  render();
  toast(`Applied "${preset.name}" to ${libSlotName(ci)} — Save to keep it`, 4000);
  blip(720);
}

function applySharedToCurrent(ci) {
  const p = libProfile(ci);
  if (!p) { toast("Connect a controller first"); return; }
  if (!pendingShare) return;
  applyPortable(p, pendingShare);
  pendingShare = null;
  try { history.replaceState(null, "", location.pathname + location.search); } catch { /* ignore */ }
  render();
  toast(`Applied shared profile to ${libSlotName(ci)} — Save to keep it`, 4000);
  blip(720);
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function pickFile(accept, onText) {
  const input = document.createElement("input");
  input.type = "file"; input.accept = accept;
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => onText(String(reader.result));
    reader.readAsText(f);
  };
  input.click();
}

// Switch a controller's active profile to this slot (like its profile button). The input report
// reflects the change within a frame, so the inline marker and wave update on their own.
async function setActiveFor(ci, slot) {
  const c = controllers[ci];
  if (!c) { toast("Connect a controller first"); return; }
  try {
    await ensureOpen(c.device);
    await setActiveProfile(c.device, slot + 1);
    toast(`Activated Profile ${slot + 1}`, 2000);
  } catch (e) { toast("Couldn't switch profile: " + (e.message || e), 4000); }
}

// Inline text editing, shared by profile-name (in the open menu) and controller-name (lane head).
function inlineEdit(host, value, commit) {
  renaming = true;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = value || "";
  input.maxLength = 40;
  host.innerHTML = "";
  host.append(input);
  input.focus(); input.select();
  const done = (ok) => { renaming = false; if (ok && input.value.trim()) commit(input.value.trim()); render(); };
  input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") done(true); else if (e.key === "Escape") done(false); });
  input.addEventListener("blur", () => done(true));
}
function startRenameProfile(ci, slot) {
  const profile = controllers[ci]?.profiles[slot];
  if (!profile) return;
  const sel = $("#items").querySelector(".item.sel");
  if (sel) inlineEdit(sel, profile.name, (v) => { profile.name = v; });
}
function startRenameController(ci) {
  const c = controllers[ci];
  if (!c) return;
  const lab = $("#blades .cell.focused .lab");
  if (lab) inlineEdit(lab, c.name, (v) => { c.name = v; });
}

// ============================ device ============================
async function load() {
  if (!hidSupported()) { $("#unsupported").classList.add("show"); return; }
  const granted = await grantedControllers();
  if (!granted.length) {
    // No controllers: focus the bottom "＋ Connect a controller…" row.
    const g = grid(); nav.gr = g.length - 1; nav.gc = 0; nav.inCell = false; nav.drill = null; render();
    toast("No controller — choose “＋ Connect a controller…”", 6000);
    return;
  }
  await addDevices(granted);
}
async function connectOnce() {
  try {
    const before = controllers.length;
    await requestControllers();                      // user grants one in the chooser (this gesture)
    await addDevices(await grantedControllers());    // reconcile: add every granted controller not yet present
    const added = controllers.length - before;
    if (added > 0) toast(added > 1 ? `${added} controllers connected` : "Controller connected", 2200);
    else toast("That one's already connected — to add another, pick the *other* “Access Controller” in the chooser.", 5500);
  } catch (e) { toast(String(e.message || e), 4000); }
}

// Serialize addDevices: granting a device in the chooser fires the `connect` event, whose handler
// also calls addDevices — running both concurrently on the same new device interleaves its
// feature-report reads and corrupts the add. Chaining guarantees one batch finishes before the next.
let _addChain = Promise.resolve();
function addDevices(devices) {
  const run = _addChain.then(() => _addDevices(devices));
  _addChain = run.catch(() => {});  // keep the chain alive even if a batch throws
  return run;
}
async function _addDevices(devices) {
  let added = 0;
  for (const device of devices) {
    if (controllers.some((c) => c.device === device)) continue;
    try {
      await ensureOpen(device);
      const profiles = [];
      for (let s = 1; s <= PROFILE_COUNT; s++) {
        const p = parseProfile(await readProfileRaw(device, s));
        p._physOrient = p.ports[0].kind === "stick" ? p.ports[0].orientation : 3;
        profiles.push(p);
      }
      if (controllers.some((c) => c.device === device)) continue; // defensive: added while awaiting
      device.addEventListener("inputreport", onInputReport);       // attach only after a clean read
      controllers.push({ device, name: `Controller ${controllers.length + 1}`, profiles, _activeProfile: null, _lastSlot: 0 });
      added++;
    } catch (e) {
      toast(`Couldn't read a controller: ${e.message || e}`, 4000);
    }
  }
  // first controller(s): land focus on the first lane's Profile 1 rather than a tool row
  if (added && !cellCtrl()) { nav.gr = 2; nav.gc = 1; nav.inCell = false; nav.drill = null; }
  clampNav();
  updateDeviceStatus();
  render();
  return added;
}
function updateDeviceStatus() {
  const c = cellCtrl() || controllers[0];
  $("#dev-name").textContent = c ? c.name : (controllers.length ? "" : "No controller");
  $("#dev-dot").style.background = controllers.length ? "var(--ok)" : "var(--dim)";
  const tag = $("#mon-prof"); if (tag) tag.innerHTML = ""; // top-bar profile indicator retired (now inline per lane)
}

async function saveProfileFor(ci, slot) {
  const c = controllers[ci];
  if (!c) return;
  try {
    toast("Saving…");
    await ensureOpen(c.device);
    await writeProfileRaw(c.device, slot + 1, buildProfile(c.profiles[slot], { now: Date.now() }));
    const reread = parseProfile(await readProfileRaw(c.device, slot + 1));
    reread._physOrient = reread.ports[0].kind === "stick" ? reread.ports[0].orientation : 3;
    c.profiles[slot] = reread;
    render();
    toast(`Saved Profile ${slot + 1}`, 2500);
    blip(880);
  } catch (e) { toast("Save failed: " + (e.message || e), 4000); }
}
async function saveAll(ci) {
  for (let s = 0; s < PROFILE_COUNT; s++) await saveProfileFor(ci, s);
  toast("Saved all profiles", 2500);
}
async function reloadFromDevice(ci) {
  const c = controllers[ci];
  if (!c) return;
  await ensureOpen(c.device);
  for (let s = 1; s <= PROFILE_COUNT; s++) {
    const p = parseProfile(await readProfileRaw(c.device, s));
    p._physOrient = p.ports[0].kind === "stick" ? p.ports[0].orientation : 3;
    c.profiles[s - 1] = p;
  }
  render();
  toast("Reloaded from controller", 2000);
}
// Soft disconnect: stop talking to this controller and drop it (grant stays; replug / Connect re-adds it).
async function disconnectController(ci) {
  const c = controllers[ci];
  if (!c) return;
  try { c.device.removeEventListener("inputreport", onInputReport); ctrlState.delete(c.device); await c.device.close(); } catch { /* ignore */ }
  controllers.splice(ci, 1);
  nav.inCell = false; nav.drill = null;
  clampNav();
  render();
  toast("Disconnected", 1800);
}

// ============================ live input monitor ============================
// Full-screen overlay. The controller is purely observed here (navigation is suspended), so
// every physical button and the stick can be tested freely; exit with Esc or the Done button.
function monChipsHTML() {
  return PHYS_NAMES.map((n, i) =>
    `<div class="chip" data-i="${i}">${i < 8 ? n : n.split("-")[0]}<small>${i < 8 ? "button" : (i === 8 ? "center" : "L3")}</small></div>`).join("");
}
function monRawHTML() {
  let h = "";
  for (let i = 0; i < 63; i++) h += `<div class="b${i === 15 || i === 16 ? " btn" : ""}" data-i="${i}">00</div>`;
  return h;
}
// Active on-device profile slot for a controller (from the last input report's byte 39), else 0.
function monProfileSlot(c) {
  const p = ctrlState.get(c.device)?.profile;
  return (p >= 1 && p <= PROFILE_COUNT) ? p - 1 : 0;
}
function monCardHTML(i, c) {
  return `<div class="mon-card" data-ctrl="${i}" data-pslot="">
    <div class="hd"><span class="nm">${c.name}</span><span class="pf"></span></div>
    <div class="r"></div>
    <div class="chips"></div>
    <div class="stickrow">
      <div class="crosshair"><div class="dot"></div></div>
      <div class="axisvals">X <b class="ax">0.00</b> · Y <b class="ay">0.00</b></div>
    </div>
    <div class="raw"></div>
  </div>`;
}
function renderMonCardProfile(card, c) {
  const slot = monProfileSlot(c);
  card.querySelector(".r").innerHTML = profileSVG(c.profiles[slot] || c.profiles[0]);
  card.querySelector(".pf").innerHTML = `<b>Profile ${slot + 1}</b>`;
  card.dataset.pslot = String(slot);
}
// Step 1: a PS3-style confirm gate warning that the controller can't exit this view (Esc / Done
// only). A navigable two-option list — Start / Cancel — operable by keyboard (↑↓ + Enter / Esc),
// controller (stick = move, confirm = pick, any perimeter = cancel), or mouse.
function renderWarnSel() {
  for (const o of document.querySelectorAll("#mon-warn .warn-opt")) o.classList.toggle("sel", +o.dataset.i === warnSel);
}
function armMonitor() {
  if (!controllers.length) { toast("Connect a controller first"); return; }
  monitorArm = true;
  warnSel = 0; renderWarnSel();
  inputEdge.confirm = true; inputEdge.back = true; inputEdge.armDir = true; // swallow the opening press
  $("#mon-warn").classList.add("show");
  $("#stage").style.display = "none"; $(".footer").style.display = "none"; // clear backdrop -> wave ribbon shows
}
function cancelArm() {
  if (!monitorArm) return;
  monitorArm = false;
  $("#mon-warn").classList.remove("show");
  $("#stage").style.display = ""; $(".footer").style.display = "";
  blip(330);
}
function confirmArm() {
  if (!monitorArm) return;
  monitorArm = false;
  $("#mon-warn").classList.remove("show");
  enterMonitor(); // keeps the stage/footer hidden, shows the monitor
}
// Activate whichever option is highlighted (used by keyboard Enter and controller confirm).
function pickArm() { warnSel === 0 ? confirmArm() : cancelArm(); }
// Step 2: enter the live monitor, rendering the *chosen* profile (so the controller image
// matches that profile's orientation) and showing which profile is on screen.
function enterMonitor() {
  if (!controllers.length) { toast("Connect a controller first"); return; }
  monitorMode = true;
  const wrap = $("#mon-cards");
  wrap.innerHTML = controllers.map((c, i) => monCardHTML(i, c)).join(""); // one card per controller
  for (const card of wrap.querySelectorAll(".mon-card")) {
    const i = +card.dataset.ctrl;
    card.querySelector(".chips").innerHTML = monChipsHTML();
    card.querySelector(".raw").innerHTML = monRawHTML();
    renderMonCardProfile(card, controllers[i]);
  }
  $("#monitor").classList.add("show");
  $("#stage").style.display = "none";
  $(".footer").style.display = "none"; // its nav hints don't apply while observing
}
function exitMonitor() {
  if (!monitorMode) return;
  monitorMode = false;
  $("#monitor").classList.remove("show");
  $("#stage").style.display = "";
  $(".footer").style.display = "";
  blip(330);
  render();
}
// Update the card for the controller that sent this report (every controller updates live).
function updateMonitor(device, buttons, axes, d, profile) {
  const i = controllers.findIndex((c) => c.device === device);
  if (i < 0) return;
  const card = document.querySelector(`#mon-cards .mon-card[data-ctrl="${i}"]`);
  if (!card) return;
  if (profile >= 1 && profile <= PROFILE_COUNT && String(profile - 1) !== card.dataset.pslot) {
    renderMonCardProfile(card, controllers[i]); // active on-device profile changed -> re-render this card
  }
  for (const el of card.querySelectorAll(".r svg [data-btn]"))
    el.classList.toggle("on", buttons.has(+el.getAttribute("data-btn")));
  const thumb = card.querySelector(".r svg .thumb");
  if (thumb) {
    thumb.setAttribute("cx", (+thumb.dataset.bx + axes[0] * M.THUMB_R).toFixed(1));
    thumb.setAttribute("cy", (+thumb.dataset.by + axes[1] * M.THUMB_R).toFixed(1));
  }
  for (const c of card.querySelectorAll(".chips .chip")) c.classList.toggle("on", buttons.has(+c.dataset.i));
  card.querySelector(".dot").style.left = (50 + axes[0] * 38) + "%";
  card.querySelector(".dot").style.top = (50 + axes[1] * 38) + "%";
  card.querySelector(".ax").textContent = axes[0].toFixed(2);
  card.querySelector(".ay").textContent = axes[1].toFixed(2);
  const cells = card.querySelectorAll(".raw .b");
  for (let k = 0; k < d.length && k < cells.length; k++) {
    cells[k].textContent = d[k].toString(16).padStart(2, "0");
    cells[k].classList.toggle("nz", d[k] !== 0);
  }
}

// ============================ input ============================
function move(dx, dy) {
  if (renaming) return;
  if (nav.drill) { // sub-section: up/down picks the row, left/right spins its value
    const rows = drillRows(cellProfile(), nav.drill.key);
    if (dy) { nav.drill.index = clamp(nav.drill.index + dy, 0, rows.length - 1); blip(440); render(); }
    if (dx) {
      const r = rows[nav.drill.index];
      const cur = r.values.indexOf(r.get());
      r.set(r.values[(cur + dx + r.values.length) % r.values.length]); blip(560); render();
    }
    return;
  }
  if (nav.inCell) { // cell menu: up/down through items
    if (dy) { const items = bladeItems(focusedCell()); nav.row = clamp(nav.row + dy, 0, items.length - 1); blip(440); render(); }
    return;
  }
  // grid mode: 2D cell navigation across the ragged grid
  const g = grid();
  if (dy) { nav.gr = clamp(nav.gr + dy, 0, g.length - 1); nav.gc = clamp(nav.gc, 0, g[nav.gr].cells.length - 1); blip(520); render(); }
  if (dx) { nav.gc = clamp(nav.gc + dx, 0, g[nav.gr].cells.length - 1); blip(520); render(); }
}
function confirmNav() { // Enter / center-stick: advance one level in (grid → menu → act)
  if (nav.drill) return; // values are changed with left/right; Enter does nothing deeper
  if (nav.inCell) activateItem(); else openCell();
}
function back() {
  if (renaming) return;
  if (nav.drill) { nav.drill = null; blip(330); render(); return; }
  if (nav.inCell) { nav.inCell = false; blip(330); render(); return; }
}

window.addEventListener("keydown", (e) => {
  if (capturing) {
    e.preventDefault();
    if (e.key === "Escape") { capturing = null; render(); toast("Cancelled", 1200); return; }
    if (e.key === "Delete") { finishCapture("nothing"); return; }
    const v = keyEventToValue(e);
    if (v) finishCapture(v); // null = a modifier on its own; keep listening
    return;
  }
  if (helpOpen) { if (e.key === "Escape" || e.key === "?" || e.key === "Backspace") { closeHelp(); e.preventDefault(); } return; } // Enter falls through to activate the focused button
  if (e.key === "?" || ((e.key === "h" || e.key === "H") && !renaming)) { openHelp(); e.preventDefault(); return; }
  if (monitorArm) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { warnSel = warnSel ? 0 : 1; renderWarnSel(); blip(440); announce(describeNav()); e.preventDefault(); }
    else if (e.key === "Enter") { pickArm(); e.preventDefault(); }
    else if (e.key === "Escape" || e.key === "Backspace") { cancelArm(); e.preventDefault(); }
    return;
  }
  if (monitorMode) { if (e.key === "Escape" || e.key === "Backspace") { exitMonitor(); e.preventDefault(); } return; }
  if (renaming) return;
  const k = e.key;
  if (k === "ArrowLeft") { move(-1, 0); e.preventDefault(); }
  else if (k === "ArrowRight") { move(1, 0); e.preventDefault(); }
  else if (k === "ArrowUp") { move(0, -1); e.preventDefault(); }
  else if (k === "ArrowDown") { move(0, 1); e.preventDefault(); }
  else if (k === "Enter") { confirmNav(); }
  else if (k === "Backspace" || k === "Escape") { back(); e.preventDefault(); }
  else if (k === "m" || k === "M") { soundOn = !soundOn; toast("Sound " + (soundOn ? "on" : "off"), 1200); }
});

// ============================ help dialog ============================
let helpOpen = false;
let helpReturnFocus = null;
function openHelp() {
  helpOpen = true;
  helpReturnFocus = document.activeElement;
  const dlg = $("#help");
  dlg.classList.add("show");
  dlg.setAttribute("aria-hidden", "false");
  updateFocusBtn();
  $("#help-close")?.focus();
  blip(660);
}

// ---- high-visibility focus ring (opt-in, off by default, persisted) ----
function focusRingOn() { return document.body.classList.contains("hi-focus"); }
function updateFocusBtn() {
  const b = $("#help-focus");
  if (!b) return;
  const on = focusRingOn();
  b.textContent = `High-visibility focus ring: ${on ? "On" : "Off"}`;
  b.setAttribute("aria-pressed", String(on));
}
function toggleFocusRing() {
  const on = document.body.classList.toggle("hi-focus");
  try { localStorage.setItem("psaccess.hiFocus", on ? "1" : "0"); } catch { /* ignore */ }
  updateFocusBtn();
  toast(`High-visibility focus ring ${on ? "on" : "off"}`, 1500);
  announce(`Focus ring ${on ? "on" : "off"}`);
}
function closeHelp() {
  helpOpen = false;
  const dlg = $("#help");
  dlg.classList.remove("show");
  dlg.setAttribute("aria-hidden", "true");
  try { helpReturnFocus?.focus?.(); } catch { /* ignore */ }
  blip(330);
}

// ---- physical input via the raw HID input report ----
// Physical buttons: byte 15 bits 0-7 = perimeter 1-8; byte 16 bit 0 = center (9), bit 1 = stick-click (10).
// Nav scheme (per design): center/stick-click = confirm; any perimeter button = back; stick = directions.
const inputEdge = {};
let dirRepeatAt = 0;
// Latest decoded physical state per connected controller. Navigation/highlighting is driven by the
// *union* of all of them (either controller can move the cursor, confirm, back), while the
// active-profile indicator, wave tint and monitor follow the controller being edited (activeCtrl).
const ctrlState = new Map(); // device -> { buttons:Set, axes:[x,y] }
function mergedInput() {
  const buttons = new Set();
  let axes = [0, 0], best = 0;
  for (const c of controllers) {
    const st = ctrlState.get(c.device);
    if (!st) continue;
    for (const b of st.buttons) buttons.add(b);
    const mag = Math.abs(st.axes[0]) + Math.abs(st.axes[1]); // whichever stick is pushed furthest steers
    if (mag > best) { best = mag; axes = st.axes; }
  }
  return { buttons, axes };
}
function onInputReport(e) {
  if (!controllers.some((c) => c.device === e.device)) return; // ignore reports from a device mid-add
  const d = new Uint8Array(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength));
  lastInputAt = performance.now();
  waveConnected = true; // a report is streaming -> the wave is visible
  const { buttons, axes, profile } = decodePhysical(d);
  ctrlState.set(e.device, { buttons, axes, profile });
  // Per-controller active-profile tracking: update THIS controller's _activeProfile; when it
  // changes, re-render so its lane's inline "✓ Active" marker (and the wave, if it's the focused
  // lane) refresh — wherever it sits in the grid.
  const ci = controllers.findIndex((c) => c.device === e.device);
  if (ci >= 0 && profile && profile - 1 !== controllers[ci]._activeProfile) {
    controllers[ci]._activeProfile = profile - 1;
    if (!monitorMode && !monitorArm && !nav.drill) render(); // monitor cards re-render themselves
  }
  // Unified live input (union of every connected controller) drives highlighting + navigation.
  const m = mergedInput();
  liveAxes = m.axes;
  phys = m.buttons;
  setGpStatus(true);
  if (monitorMode) { updateMonitor(e.device, buttons, axes, d, profile); return; } // every controller updates its card
  if (monitorArm) { handleArmInput(m.buttons, m.axes); return; }
  handlePhysInput(m.buttons, m.axes);
  updateLive();
}

function handlePhysInput(buttons, axes) {
  if (renaming || capturing) return; // suspend controller nav while binding a key
  const now = lastInputAt;
  const dir = { left: axes[0] < -0.5, right: axes[0] > 0.5, up: axes[1] < -0.5, down: axes[1] > 0.5 };
  const heldDir = dir.left || dir.right || dir.up || dir.down;
  const fire = (k) => { if (k === "left") move(-1, 0); else if (k === "right") move(1, 0); else if (k === "up") move(0, -1); else move(0, 1); };
  let edged = false;
  for (const k of ["left", "right", "up", "down"]) {
    if (dir[k] && !inputEdge[k]) { fire(k); dirRepeatAt = now + 380; edged = true; }
    inputEdge[k] = dir[k];
  }
  if (!edged && heldDir && now >= dirRepeatAt) {
    fire(dir.left ? "left" : dir.right ? "right" : dir.up ? "up" : "down");
    dirRepeatAt = now + 130;
  }
  const wantConfirm = buttons.has(8) || buttons.has(9);          // center or stick-click
  const wantBack = [0, 1, 2, 3, 4, 5, 6, 7].some((i) => buttons.has(i)); // any perimeter
  if (wantConfirm && !inputEdge.confirm) confirmNav();
  inputEdge.confirm = wantConfirm;
  if (wantBack && !inputEdge.back) back();
  inputEdge.back = wantBack;
}

// On the gate: stick up/down moves the highlight, confirm (center/stick-click) picks it,
// any perimeter button cancels outright.
function handleArmInput(buttons, axes) {
  const dir = axes[1] < -0.5 ? -1 : axes[1] > 0.5 ? 1 : 0;       // up/down on the list
  if (dir && !inputEdge.armDir) { warnSel = warnSel ? 0 : 1; renderWarnSel(); blip(440); }
  inputEdge.armDir = dir !== 0;
  const confirm = buttons.has(8) || buttons.has(9);
  const wantBack = [0, 1, 2, 3, 4, 5, 6, 7].some((i) => buttons.has(i));
  if (confirm && !inputEdge.confirm) pickArm();
  inputEdge.confirm = confirm;
  if (wantBack && !inputEdge.back) cancelArm();
  inputEdge.back = wantBack;
}

function setGpStatus(on) {
  const gs = $("#gp-status");
  if (gs) { gs.textContent = on ? "controller: connected" : "controller: not detected"; gs.classList.toggle("on", on); }
}

// ============================ sound ============================
let actx = null;
function blip(freq) {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "sine"; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.05, actx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.12);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.13);
  } catch { /* ignore */ }
}

// ============================ toast + clock ============================
let toastT = 0;
function toast(msg, ms = 3000) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms);
}
function tickClock() {
  const d = new Date();
  $("#clock").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ============================ wave background ============================
// Keep the original blue palette; vary only per-curve transparency by the active profile.
// A curve fades when its index is below the active profile slot, so the active profile's curve
// (and the ones after it) stay at full opacity:
//   profile 1 -> all original; profile 2 -> curve 1 faded; profile 3 -> curves 1 & 2 faded.
// When no controller is streaming, every curve fades fully out (transparent).
let waveConnected = false;   // false -> all curves transparent
let waveSlot = 0;            // active profile slot (0-2) driving the fade pattern
const WAVE_FADED = 0.25;     // alpha multiplier for the "more transparent" leading curves
const bandLevel = [0, 0, 0]; // eased per-curve alpha multiplier (0 = transparent, 1 = original)
function setWaveProfile(slot) { waveSlot = (slot >= 0 && slot <= 2) ? slot : 0; }

function startWave() {
  // Honor "reduce motion": skip the animated background entirely (CSS also hides #wave).
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    window.addEventListener("resize", layout);
    return;
  }
  const cv = $("#wave"), ctx = cv.getContext("2d");
  let w, h;
  const resize = () => { w = cv.width = innerWidth * devicePixelRatio; h = cv.height = innerHeight * devicePixelRatio; };
  resize(); window.addEventListener("resize", () => { resize(); layout(); });
  let t = 0;
  const bands = [
    { amp: 0.10, len: 0.9, sp: 0.6, y: 0.42, hue: 215, a: 0.20 },
    { amp: 0.07, len: 1.4, sp: -0.4, y: 0.55, hue: 200, a: 0.16 },
    { amp: 0.13, len: 0.7, sp: 0.9, y: 0.66, hue: 230, a: 0.13 },
  ];
  const draw = () => {
    t += 0.005;
    ctx.clearRect(0, 0, w, h);
    const hueShift = 18 * Math.sin(t * 0.05);
    bands.forEach((b, i) => {
      const target = !waveConnected ? 0 : (i < waveSlot ? WAVE_FADED : 1); // fade leading curves
      bandLevel[i] += (target - bandLevel[i]) * 0.06;                       // ease the change
      const lvl = bandLevel[i];
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 16 * devicePixelRatio) {
        const y = h * b.y + Math.sin(x / w * Math.PI * 2 * b.len + t * b.sp) * h * b.amp
          + Math.sin(x / w * Math.PI * 5 * b.len - t * b.sp * 1.7) * h * b.amp * 0.3;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h); ctx.closePath();
      const g = ctx.createLinearGradient(0, h * b.y - h * 0.2, 0, h);
      g.addColorStop(0, `hsla(${b.hue + hueShift},70%,55%,${(b.a * lvl).toFixed(3)})`); // original color, eased alpha
      g.addColorStop(1, `hsla(${b.hue + hueShift},70%,30%,0)`);
      ctx.fillStyle = g; ctx.fill();
    });
    requestAnimationFrame(draw);
  };
  draw();
}

// ============================ init ============================
function init() {
  // Register the (network-first) service worker for offline use + installability.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => { /* non-fatal */ });
  }
  // Restore the opt-in focus-ring preference (default off).
  try { if (localStorage.getItem("psaccess.hiFocus") === "1") document.body.classList.add("hi-focus"); } catch { /* ignore */ }
  startWave();
  tickClock(); setInterval(tickClock, 15000);
  // mark the controller disconnected if no input report has arrived recently (also fades the wave out)
  setInterval(() => { if (performance.now() - lastInputAt > 1500) { setGpStatus(false); waveConnected = false; } }, 800);
  if (navigator.hid) {
    // Auto-recover on unplug/replug without a page refresh.
    navigator.hid.addEventListener("disconnect", (e) => {
      waveConnected = false;
      const idx = controllers.findIndex((c) => c.device === e.device);
      if (idx !== -1) {
        e.device.removeEventListener("inputreport", onInputReport);
        ctrlState.delete(e.device);
        controllers.splice(idx, 1);
        nav.inCell = false; nav.drill = null;
        clampNav();
      }
      updateDeviceStatus(); render();
    });
    let reconnecting = false;
    navigator.hid.addEventListener("connect", async () => {
      if (reconnecting) return;
      reconnecting = true;
      try {
        const before = controllers.length;
        for (let attempt = 0; attempt < 3; attempt++) {            // device may need a moment to expose its USB collection
          try { await addDevices(await grantedControllers()); break; }
          catch (err) { if (attempt === 2) throw err; await new Promise((r) => setTimeout(r, 300)); }
        }
        if (controllers.length > before) toast("Controller reconnected", 1800);
      } catch (err) { toast("Reconnect failed: " + (err.message || err), 3500); }
      finally { reconnecting = false; }
    });
  }
  $("#mon-done").onclick = exitMonitor;
  $("#warn-start").onclick = confirmArm;
  $("#warn-cancel").onclick = cancelArm;
  $("#help-close").onclick = closeHelp;
  $("#help-focus").onclick = toggleFocusRing;
  $("#help").addEventListener("click", (e) => { if (e.target.id === "help") closeHelp(); });
  try {
    pendingShare = parseShareHash(location.hash);
    if (pendingShare) toast(`Shared profile "${pendingShare.name || "(unnamed)"}" detected — open Library ▸ to apply`, 6000);
  } catch { /* ignore bad hash */ }
  render();
  load();
}
init();
