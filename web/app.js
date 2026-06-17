// Multi-controller WebHID configurator for the PlayStation Access Controller.
// Two views: a form editor and an SVG "controller" view with live input (Gamepad API).
import {
  ACTIONS, STICKS, ORIENTATIONS, PROFILE_COUNT,
  STICK_DEFAULT_SENSITIVITY, STICK_DEFAULT_DEADZONE,
  parseProfile, buildProfile,
} from "./access-protocol.mjs";
import {
  hidSupported, grantedControllers, requestControllers, ensureOpen,
  readProfileRaw, writeProfileRaw,
} from "./hid-web.mjs";

const BUTTON_COUNT = 10;
const PORT_COUNT = 5; // port 0 = built-in stick, 1..4 = expansion ports
const SVGNS = "http://www.w3.org/2000/svg";
// Standard Gamepad-API button order → action name (DualSense/standard mapping).
const GAMEPAD_ACTIONS = ["cross", "circle", "square", "triangle", "L1", "R1", "L2", "R2",
  "create", "options", "L3", "R3", "up", "down", "left", "right", "PS", "touchpad"];

// ---- state ----
let nextId = 1;
const controllers = []; // { id, device, name, profiles:[obj|null x3], activeSlot }
let selectedId = null;
let viewMode = localStorage.getItem("ps-access-view") || "controller"; // 'form' | 'controller'
let liveActions = new Set(); // action names currently pressed (gamepad)
let liveAxes = [0, 0];
let liveDetected = false;
let liveMode = false; // when on, WebHID is released so the Gamepad API can read the device

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
};
const svg = (tag, attrs = {}, children = []) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
};
const actionLabel = (code) => (code === 0 ? "—" : ACTIONS[code] ?? `?${code}`);
// Glyphs for actions that have a recognizable symbol (face buttons, d-pad, options, PS, touchpad).
// Others (L1/R1/L2/R2/L3/R3, create) keep their short text. data-action still uses the NAME.
const SYMBOLS = { 1: "○", 2: "✕", 3: "△", 4: "□", 5: "▲", 6: "▼", 7: "◀", 8: "▶", 15: "☰", 18: "▭" };
const symbolLabel = (code) => (code === 0 ? "—" : SYMBOLS[code] ?? ACTIONS[code] ?? `?${code}`);

function status(msg, kind = "info") {
  const s = $("#status");
  s.textContent = msg;
  s.className = "show " + kind;
  if (kind === "ok") setTimeout(() => s.classList.remove("show"), 4000);
}

function nameKey(device) {
  return "ps-access-name:" + (device.productName || "Access Controller");
}

// ---- controller management ----
async function addControllers(devices) {
  for (const device of devices) {
    if (controllers.some((c) => c.device === device)) continue;
    const saved = localStorage.getItem(nameKey(device));
    controllers.push({
      id: nextId++, device, name: saved || `Controller ${controllers.length + 1}`,
      profiles: [null, null, null], activeSlot: 0,
    });
  }
  if (selectedId == null && controllers.length) selectedId = controllers[0].id;
  render();
  for (const c of controllers) {
    if (c.profiles.every((p) => p === null)) await loadController(c).catch((e) => status(e.message, "err"));
  }
}

async function onAdd() {
  if (!hidSupported()) return status("WebHID not supported. Use Chrome/Edge (desktop).", "err");
  try {
    const devices = await requestControllers();
    if (!devices.length) return;
    await addControllers(devices);
    status(`Added ${devices.length} controller(s).`, "ok");
  } catch (e) { status(e.message, "err"); }
}

async function loadController(c) {
  liveMode = false; // re-acquiring the device for HID access
  await ensureOpen(c.device);
  status(`Reading ${c.name}…`, "info");
  for (let slot = 1; slot <= PROFILE_COUNT; slot++) {
    const p = parseProfile(await readProfileRaw(c.device, slot));
    p._physOrient = p.ports[0].kind === "stick" ? p.ports[0].orientation : 3; // device's actual stick position
    c.profiles[slot - 1] = p;
  }
  status(`${c.name}: 3 profiles loaded.`, "ok");
  render();
}

async function saveProfile(c, slotIndex) {
  liveMode = false; // re-acquiring the device for HID access
  await ensureOpen(c.device);
  const bytes = buildProfile(c.profiles[slotIndex], { now: Date.now() });
  status(`Writing ${c.name} profile ${slotIndex + 1}…`, "info");
  await writeProfileRaw(c.device, slotIndex + 1, bytes);
  const reread = parseProfile(await readProfileRaw(c.device, slotIndex + 1));
  reread._physOrient = reread.ports[0].kind === "stick" ? reread.ports[0].orientation : 3;
  c.profiles[slotIndex] = reread;
  status(`${c.name}: profile ${slotIndex + 1} saved.`, "ok");
  render();
}

const selected = () => controllers.find((c) => c.id === selectedId) || null;

async function copyProfile(fromC, fromSlot, toC, toSlot, { write = false } = {}) {
  const src = fromC.profiles[fromSlot];
  if (!src) throw new Error("source profile not loaded");
  const clone = structuredClone({ name: src.name, buttons: src.buttons, ports: src.ports });
  const target = toC.profiles[toSlot] || {};
  toC.profiles[toSlot] = { ...target, ...clone, _raw: target._raw };
  if (write) await saveProfile(toC, toSlot);
  render();
}

// ---- shared control builders ----
// Action options grouped like the PS5 picker.
const ACTION_GROUPS = [
  ["Basic controls", [2, 1, 15]],                     // cross, circle, options
  ["Action buttons", [3, 4, 9, 10, 11, 12, 13, 14]],  // triangle, square, L1, R1, L2, R2, L3, R3
  ["D-pad", [5, 6, 7, 8]],                             // up, down, left, right
  ["Other", [16, 17, 18]],                             // create, PS, touchpad
];
// One <option> with an aligned symbol glyph + name (rich content; base-select renders it).
function actionOption(value, sym, name) {
  const o = el("option", { value: String(value) });
  o.append(el("span", { className: "opt-sym", textContent: sym || "" }), el("span", { className: "opt-name", textContent: name }));
  return o;
}
// A non-selectable category header row (optgroup labels aren't reliably stylable in base-select).
function groupHeader(label) {
  const o = el("option", { className: "grp", disabled: true });
  o.append(el("span", { className: "opt-name", textContent: label }));
  return o;
}
function actionSelect(value, { includeSticks = false } = {}) {
  const sel = el("select");
  sel.append(actionOption(0, "—", "Not assigned"));
  if (includeSticks) {
    sel.append(groupHeader("Stick"));
    for (const [code, label] of Object.entries(STICKS)) sel.append(actionOption(100 + Number(code), "", label));
  }
  for (const [label, codes] of ACTION_GROUPS) {
    sel.append(groupHeader(label));
    for (const code of codes) sel.append(actionOption(code, SYMBOLS[code], ACTIONS[code]));
  }
  sel.value = String(value);
  return sel;
}

// Editable stick-tuning block bound to a stick port object.
function stickTuning(port, onChange) {
  const det = el("details", { className: "tuning" });
  det.append(el("summary", { textContent: "Advanced stick tuning (sensitivity / deadzone)" }));
  const sens = port.sensitivity ?? 0;
  const dz = port.deadzone ?? [0, 0, 0, 0, 0, 0];

  const slider = (label, value, max, oninput) => {
    const out = el("span", { textContent: String(value) });
    const r = el("input", { type: "range", min: "0", max: String(max), value: String(value) });
    r.oninput = () => { out.textContent = r.value; oninput(Number(r.value)); };
    return el("div", { className: "trow" }, [el("label", { textContent: label }), r, out]);
  };

  det.append(
    slider("Sensitivity", sens, 10, (v) => { port.sensitivity = v; }),
    slider("Inner deadzone", dz[0], 255, (v) => { port.deadzone = (port.deadzone || [0,0,0,0,0,0]).slice(); port.deadzone[0] = port.deadzone[1] = v; }),
    slider("Curve", dz[2], 255, (v) => { port.deadzone = (port.deadzone || [0,0,0,0,0,0]).slice(); port.deadzone[2] = port.deadzone[3] = v; }),
    slider("Outer deadzone", dz[4], 255, (v) => { port.deadzone = (port.deadzone || [0,0,0,0,0,0]).slice(); port.deadzone[4] = port.deadzone[5] = v; }),
  );
  const presets = el("div", { className: "presets" });
  const ps5 = el("button", { textContent: "PS5 default preset" });
  ps5.onclick = () => { port.sensitivity = STICK_DEFAULT_SENSITIVITY; port.deadzone = STICK_DEFAULT_DEADZONE.slice(); onChange(); };
  const fw = el("button", { textContent: "Firmware default (0)" });
  fw.onclick = () => { port.sensitivity = 0; port.deadzone = [0, 0, 0, 0, 0, 0]; onChange(); };
  presets.append(ps5, fw);
  det.append(presets);
  det.append(el("div", { className: "note", textContent: "Exact value meanings aren't officially documented (the PS5 normally sets these). 0 = firmware default. Adjust experimentally — your config is backed up and recoverable." }));
  return det;
}

// ---- rendering ----
function render() {
  renderSidebar();
  renderEditor();
}

function renderSidebar() {
  const list = $("#controller-list");
  list.innerHTML = "";
  $("#no-controllers").style.display = controllers.length ? "none" : "block";
  for (const c of controllers) {
    const card = el("div", { className: "ctrl-card" + (c.id === selectedId ? " active" : "") });
    card.onclick = () => { selectedId = c.id; render(); };
    const dot = el("span", { className: "dot" + (c.device.opened ? "" : " off") });
    const name = el("div", { className: "name" }, [dot, c.name]);
    const rename = el("button", { className: "ghost", textContent: "✎", title: "Rename", style: "padding:1px 6px; margin-left:auto;" });
    rename.onclick = (ev) => {
      ev.stopPropagation();
      const n = prompt("Controller name:", c.name);
      if (n) { c.name = n; localStorage.setItem(nameKey(c.device), n); render(); }
    };
    name.append(rename);
    card.append(name, el("div", { className: "meta" }, `${c.device.productName || "Access Controller"} · USB`));
    list.append(card);
  }
}

function renderEditor() {
  const root = $("#editor");
  root.innerHTML = "";
  const c = selected();
  if (!c) {
    root.append(el("div", { className: "empty", innerHTML: "Add a controller to begin.<br>Each Access Controller stores 3 on-device profiles." }));
    return;
  }

  // top bar: profile tabs + view toggle + live indicator
  const top = el("div", { className: "topbar" });
  const tabs = el("div", { className: "tabs" });
  for (let i = 0; i < PROFILE_COUNT; i++) {
    const t = el("button", { className: "tab" + (i === c.activeSlot ? " active" : ""), textContent: `Profile ${i + 1}` });
    t.onclick = () => { c.activeSlot = i; render(); };
    tabs.append(t);
  }
  const toggle = el("div", { className: "viewtoggle" });
  for (const [mode, label] of [["form", "Form"], ["controller", "Controller"]]) {
    const b = el("button", { className: viewMode === mode ? "active" : "", textContent: label });
    b.onclick = () => { viewMode = mode; localStorage.setItem("ps-access-view", mode); render(); };
    toggle.append(b);
  }
  const live = el("div", { className: "live-indicator" + (liveDetected ? " on" : ""), id: "live-ind" });
  live.append(el("span", { className: "dot" }), liveDetected ? "live input" : "no input");
  top.append(tabs, el("div", { className: "spacer", style: "flex:1" }), toggle, live);
  root.append(top);

  const profile = c.profiles[c.activeSlot];
  const panel = el("div", { className: "profile" });
  if (!profile) {
    const load = el("button", { className: "primary", textContent: "↻ Load from controller" });
    load.onclick = () => loadController(c).catch((e) => status(e.message, "err"));
    panel.append(el("div", { className: "empty", innerHTML: "Profile not loaded yet.<br><br>" }, [load]));
    root.append(panel);
    return;
  }

  if (viewMode === "controller") renderControllerView(panel, c, profile);
  else renderFormView(panel, c, profile);
  root.append(panel, toolbar(c));
  updateLiveHighlight();
}

function toolbar(c) {
  const bar = el("div", { className: "toolbar" });
  const reload = el("button", { textContent: "↻ Load from controller" });
  reload.onclick = () => loadController(c).catch((e) => status(e.message, "err"));
  const save = el("button", { className: "primary", textContent: `💾 Save profile ${c.activeSlot + 1} to controller` });
  save.onclick = () => saveProfile(c, c.activeSlot).catch((e) => status(e.message, "err"));
  bar.append(reload, save);

  const copyGrp = el("div", { className: "grp" });
  copyGrp.append(el("span", { className: "k", textContent: "Copy this profile →" }));
  const destCtrl = el("select");
  for (const t of controllers) destCtrl.append(el("option", { value: String(t.id), textContent: t.name }));
  destCtrl.value = String(c.id);
  const destSlot = el("select");
  for (let i = 0; i < PROFILE_COUNT; i++) destSlot.append(el("option", { value: String(i), textContent: `Profile ${i + 1}` }));
  destSlot.value = String(c.activeSlot);
  const copyBtn = el("button", { textContent: "Copy + save" });
  copyBtn.onclick = async () => {
    const toC = controllers.find((x) => x.id === Number(destCtrl.value));
    try { await copyProfile(c, c.activeSlot, toC, Number(destSlot.value), { write: true }); }
    catch (e) { status(e.message, "err"); }
  };
  const allBtn = el("button", { textContent: "Apply to all controllers" });
  allBtn.onclick = async () => {
    try { for (const toC of controllers) await copyProfile(c, c.activeSlot, toC, c.activeSlot, { write: true }); status("Applied to all controllers.", "ok"); }
    catch (e) { status(e.message, "err"); }
  };
  copyGrp.append(destCtrl, destSlot, copyBtn, allBtn);
  bar.append(copyGrp);
  return bar;
}

// ---- form view ----
function renderFormView(panel, c, profile) {
  const nameRow = el("div", { className: "row" });
  const nameInput = el("input", { type: "text", value: profile.name || "" });
  nameInput.style.gridColumn = "2 / span 3";
  nameInput.oninput = () => { profile.name = nameInput.value; };
  nameRow.append(el("label", { className: "k", textContent: "Profile name" }), nameInput);
  panel.append(el("div", { className: "section-title", textContent: "Profile" }), nameRow);

  panel.append(el("div", { className: "section-title", textContent: "Buttons" }));
  for (let b = 0; b < BUTTON_COUNT; b++) {
    const btn = profile.buttons[b];
    const row = el("div", { className: "row" });
    const m1 = actionSelect(btn.map1); m1.onchange = () => { btn.map1 = Number(m1.value); };
    const m2 = actionSelect(btn.map2); m2.onchange = () => { btn.map2 = Number(m2.value); };
    const tg = el("input", { type: "checkbox", checked: btn.toggle }); tg.onchange = () => { btn.toggle = tg.checked; };
    row.append(el("label", { className: "k", textContent: `Button ${b + 1}` }), m1, m2, el("label", {}, [tg, " toggle"]));
    panel.append(row);
  }

  panel.append(el("div", { className: "section-title", textContent: "Built-in stick" }));
  const p0 = profile.ports[0];
  const row = el("div", { className: "row" });
  const stickSel = el("select");
  stickSel.append(el("option", { value: "0", textContent: "nothing" }));
  for (const [code, label] of Object.entries(STICKS)) stickSel.append(el("option", { value: code, textContent: label }));
  stickSel.value = p0.kind === "stick" ? String(p0.stick) : "0";
  const orientSel = el("select");
  for (const [code, label] of Object.entries(ORIENTATIONS)) orientSel.append(el("option", { value: code, textContent: label }));
  orientSel.value = String(p0.kind === "stick" ? p0.orientation : 3);
  const apply = () => {
    const sv = Number(stickSel.value);
    const prev = profile.ports[0];
    if (sv === 0) profile.ports[0] = { kind: "none" };
    else profile.ports[0] = { kind: "stick", stick: sv, orientation: Number(orientSel.value), sensitivity: prev.sensitivity ?? 0, deadzone: prev.deadzone ?? [0,0,0,0,0,0] };
    for (const pt of profile.ports) if (pt.kind === "stick") pt.orientation = Number(orientSel.value);
    render();
  };
  stickSel.onchange = apply; orientSel.onchange = apply;
  row.append(el("label", { className: "k", textContent: "Stick" }), stickSel, orientSel, el("span", { className: "pill", textContent: "orientation" }));
  panel.append(row);
  if (p0.kind === "stick") panel.append(stickTuning(p0, render));

  panel.append(el("div", { className: "section-title", textContent: "Expansion ports (3.5mm)" }));
  for (let p = 1; p < PORT_COUNT; p++) {
    const port = profile.ports[p];
    const r = el("div", { className: "row" });
    const val = port.kind === "stick" ? 100 + port.stick : port.kind === "button" ? port.map1 : 0;
    const m1 = actionSelect(val, { includeSticks: true });
    const m2 = actionSelect(port.kind === "button" ? port.map2 : 0);
    const tg = el("input", { type: "checkbox", checked: port.kind === "button" && port.toggle });
    const sync = () => {
      const v = Number(m1.value);
      if (v === 0) profile.ports[p] = { kind: "none" };
      else if (v > 100) profile.ports[p] = { kind: "stick", stick: v - 100, orientation: profile.ports.find((x) => x.kind === "stick")?.orientation ?? 3 };
      else profile.ports[p] = { kind: "button", analog: false, map1: v, map2: Number(m2.value), toggle: tg.checked };
      const isButton = v > 0 && v < 100;
      m2.style.visibility = isButton ? "visible" : "hidden";
      tg.parentElement.style.visibility = isButton ? "visible" : "hidden";
    };
    m1.onchange = sync; m2.onchange = sync; tg.onchange = sync;
    r.append(el("label", { className: "k", textContent: `Port ${p}` }), m1, m2, el("label", {}, [tg, " toggle"]));
    panel.append(r);
    sync();
  }
}

// ---- controller (SVG) view ----
const CX = 480, CY = 430;
const RING_OUTER = 216, RING_INNER = 122, RING_MID = 169; // donut ring of 8 wedge buttons
const BODY_R = RING_OUTER;            // alias used for stick/port distance math
const CENTER_R = 76;                  // B9 center button radius
// STICK_DIST sets the gap between the body and the stick (edge-to-edge ≈ STICK_DIST - BODY_R - STICK_R)
const STICK_DIST = BODY_R + 100, STICK_R = 40, THUMB_R = 24, PORT_R = 27, PORT_ARC_R = 322;
const WEDGE_GAP_DEG = 3;              // gap between adjacent wedge segments
const WEDGE_CORNER = 22;             // corner radius of each wedge segment
const ORIENT_ROT = { 0: 0, 1: 270, 2: 180, 3: 90 }; // stick orientation -> layout rotation (deg)
let stickTheta = 0; // current layout rotation (radians); used by live thumb updates
const rotV = (x, y, t) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
const rotAround = (x, y, cx, cy, t) => { const [rx, ry] = rotV(x - cx, y - cy, t); return [cx + rx, cy + ry]; };

async function setLiveMode(c, on) {
  liveMode = on;
  try { if (on && c.device.opened) await c.device.close(); } catch { /* ignore */ }
  status(on
    ? "Live input ON — press buttons / move the stick to see them light up. Editing still works; Load/Save will re-acquire the controller."
    : "Live input off.", "info");
  render();
}

function renderControllerView(panel, c, profile) {
  const stick = profile.ports[0];
  const orient = stick.kind === "stick" ? stick.orientation : 3;
  const orientDeg = ORIENT_ROT[orient] ?? 0;
  const theta = orientDeg * Math.PI / 180;
  const R = (x, y) => rotAround(x, y, CX, CY, theta);
  // Live thumb rotates relative to the device's ACTUAL stick position (what the gamepad axes
  // are reported in), not relative to canonical — so it's exact at the real orientation and
  // only rotates when you preview a different stick side.
  const physOrient = profile._physOrient ?? orient;
  const thumbTheta = (orientDeg - (ORIENT_ROT[physOrient] ?? 0)) * Math.PI / 180;
  stickTheta = thumbTheta;

  const head = el("div", { className: "section-title", style: "display:flex; align-items:center; gap:12px;" });
  head.append(el("span", { textContent: "Controller layout", style: "flex:1" }));
  // direct stick-position control
  head.append(el("span", { className: "k", textContent: "Stick side:" }));
  const orientSel = el("select");
  for (const [code, label] of Object.entries(ORIENTATIONS)) orientSel.append(el("option", { value: code, textContent: label }));
  orientSel.value = String(orient);
  orientSel.onchange = () => { setStickOrientation(profile, Number(orientSel.value)); render(); };
  head.append(orientSel);
  const liveBtn = el("button", { className: liveMode ? "primary" : "", textContent: liveMode ? "■ Stop live input" : "▶ Live input" });
  liveBtn.onclick = () => setLiveMode(c, !liveMode).catch((e) => status(e.message, "err"));
  head.append(liveBtn);
  panel.append(head);
  if (liveMode) panel.append(el("div", { className: "empty", style: "padding:6px; color:var(--ok); text-align:left;", textContent: "Live: press a physical button — it lights up the action it's mapped to (Chrome may need one button press to start)." }));

  const wrap = el("div", { className: "svgwrap" });
  const s = svg("svg", { viewBox: "0 0 960 880" });

  // expansion ports — E1..E4 callout circles on an arc opposite the stick
  for (let p = 1; p <= 4; p++) {
    const a = (-90 + (p - 2.5) * 24) * Math.PI / 180; // canonical: arc above, centered opposite the stick
    const [x, y] = R(CX + PORT_ARC_R * Math.cos(a), CY + PORT_ARC_R * Math.sin(a));
    s.append(makePortSlot(x, y, p, profile.ports[p], c, profile));
  }

  // stick module — canonically below the body, rotated to its mounted side
  const [sx, sy] = R(CX, CY + STICK_DIST);
  s.append(makeStickGroup(sx, sy, stick, c, profile, theta, thumbTheta));

  // 8 perimeter buttons as a ring of rotationally-symmetric wedge segments,
  // numbered counter-clockwise (B5 opposite the stick), rotating rigidly with the stick
  for (let i = 0; i < 8; i++) {
    s.append(makeWedgeSlot(90 - i * 45 + orientDeg, i, profile.buttons[i], c, profile));
  }
  // B9 = center button; B10 (stick-click / L3) is merged into the stick
  s.append(makeButtonSlot(CX, CY, CENTER_R, 8, profile.buttons[8], c, profile));

  s.append(svg("text", { x: CX, y: 868, "text-anchor": "middle", class: "svg-hint" },
    ["Click any element to edit. Layout rotates to match stick side; use Live input to confirm positions."]));

  wrap.append(s);
  panel.append(wrap);
}

function setStickOrientation(profile, o) {
  for (const pt of profile.ports) if (pt.kind === "stick") pt.orientation = o;
  // if the built-in stick is off, enable it so the position control has an effect
  if (profile.ports[0].kind !== "stick") profile.ports[0] = { kind: "stick", stick: 1, orientation: o, sensitivity: 0, deadzone: [0, 0, 0, 0, 0, 0] };
}

function makeButtonSlot(x, y, r, idx, btn, c, profile) {
  const g = svg("g", { class: "slot" + (btn.map1 === 0 ? " empty" : ""), "data-action": actionLabel(btn.map1) });
  g.append(svg("circle", { cx: x, cy: y, r, class: "slot-bg" }));
  g.append(svg("text", { x, y: y - r + 16, "text-anchor": "middle", class: "slot-idx" }, [`B${idx + 1}`]));
  g.append(svg("text", { x, y: y + 6, "text-anchor": "middle", class: "slot-label sym" }, [symbolLabel(btn.map1)]));
  g.onclick = (ev) => openButtonEditor(ev, btn, c, profile);
  return g;
}

// SVG path for a donut segment (annular sector) with all four corners rounded by a true
// tangent arc of radius `cr` — outer & inner edges are arcs, the two sides are radial.
function roundedWedgePath(cx, cy, ri, ro, a0, a1, cr) {
  const pol = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const f = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  cr = Math.min(cr, (ro - ri) / 2 - 1, ((a1 - a0) * ri) / 2 - 1);
  // angular inset where each rounding arc meets the outer / inner edge
  const dO = Math.asin(cr / (ro - cr));
  const dI = Math.asin(cr / (ri + cr));
  // radius at which each rounding arc meets the radial side edge
  const roS = (ro - cr) * Math.cos(dO);
  const riS = (ri + cr) * Math.cos(dI);
  const P1 = pol(ro, a0 + dO), P2 = pol(ro, a1 - dO), P3 = pol(roS, a1), P4 = pol(riS, a1),
    P5 = pol(ri, a1 - dI), P6 = pol(ri, a0 + dI), P7 = pol(riS, a0), P8 = pol(roS, a0);
  return `M${f(P1)} A${ro},${ro} 0 0 1 ${f(P2)} A${cr},${cr} 0 0 1 ${f(P3)} L${f(P4)} `
    + `A${cr},${cr} 0 0 1 ${f(P5)} A${ri},${ri} 0 0 0 ${f(P6)} A${cr},${cr} 0 0 1 ${f(P7)} `
    + `L${f(P8)} A${cr},${cr} 0 0 1 ${f(P1)} Z`;
}

// One of the 8 ring buttons, drawn as a rotationally-symmetric rounded wedge segment.
function makeWedgeSlot(centerDeg, idx, btn, c, profile) {
  const ca = centerDeg * Math.PI / 180;
  const half = (22.5 - WEDGE_GAP_DEG) * Math.PI / 180;
  const g = svg("g", { class: "slot" + (btn.map1 === 0 ? " empty" : ""), "data-action": actionLabel(btn.map1) });
  g.append(svg("path", { d: roundedWedgePath(CX, CY, RING_INNER, RING_OUTER, ca - half, ca + half, WEDGE_CORNER), class: "slot-bg wedge" }));
  g.append(svg("text", { x: CX + RING_MID * Math.cos(ca), y: CY + RING_MID * Math.sin(ca) + 6, "text-anchor": "middle", class: "slot-label sym" }, [symbolLabel(btn.map1)]));
  g.append(svg("text", { x: CX + (RING_INNER + 13) * Math.cos(ca), y: CY + (RING_INNER + 13) * Math.sin(ca) + 3, "text-anchor": "middle", class: "slot-idx" }, [String(idx + 1)]));
  g.onclick = (ev) => openButtonEditor(ev, btn, c, profile);
  return g;
}

function makePortSlot(x, y, p, port, c, profile) {
  const label = port.kind === "stick" ? (STICKS[port.stick] ?? "stick") : port.kind === "button" ? symbolLabel(port.map1) : "—";
  const g = svg("g", { class: "slot" + (port.kind === "none" ? " empty" : ""), "data-action": port.kind === "button" ? actionLabel(port.map1) : "" });
  g.append(svg("circle", { cx: x, cy: y, r: PORT_R, class: "slot-bg" }));
  g.append(svg("text", { x, y: y + 5, "text-anchor": "middle", class: "slot-idx" }, [`E${p}`]));
  g.append(svg("text", { x, y: y + PORT_R + 16, "text-anchor": "middle", class: "slot-label" }, [label]));
  g.onclick = (ev) => openPortEditor(ev, p, port, c, profile);
  return g;
}

function makeStickGroup(x, y, stick, c, profile, theta = 0, thumbTheta = 0) {
  // The stick element also represents B10 — the stick-click (L3). It highlights blue (via
  // data-action) only when that mapped action is pressed.
  const clickAction = actionLabel(profile.buttons[9].map1);
  const g = svg("g", { class: "slot", "data-stick": "1", "data-action": clickAction });
  // the stick itself — no surrounding rings; it moves with the analog stick, rotated relative
  // to the device's actual position. data-cx/cy hold the rest position for live updates.
  const [tx, ty] = rotV(liveAxes[0], liveAxes[1], thumbTheta);
  g.append(svg("circle", { cx: x + tx * THUMB_R, cy: y + ty * THUMB_R, r: STICK_R, class: "stick-thumb", id: "stick-thumb", "data-cx": x, "data-cy": y }));
  const name = stick.kind === "stick" ? (STICKS[stick.stick] ?? "stick") : "off";
  // labels radially outward, clear of the stick's full deflection
  const [ox, oy] = rotV(0, 1, theta);
  const off = STICK_R + THUMB_R + 14;
  const lx = x + ox * off, ly = y + oy * off + 4;
  g.append(svg("text", { x: lx, y: ly, "text-anchor": "middle", class: "slot-label" }, [name]));
  g.append(svg("text", { x: lx, y: ly + 16, "text-anchor": "middle", class: "slot-idx" }, [`click: ${clickAction}`]));
  g.onclick = (ev) => openStickEditor(ev, stick, c, profile);
  return g;
}

// ---- popover editors ----
function openPopover(ev, title, fields, onSave) {
  closePopover();
  const backdrop = el("div", { className: "backdrop", id: "popover-backdrop" });
  backdrop.onclick = closePopover;
  const pop = el("div", { className: "popover", id: "popover" });
  pop.append(el("h4", { textContent: title }));
  for (const f of fields) pop.append(f);
  const save = el("button", { className: "primary", textContent: "Apply", style: "margin-top:8px;" });
  save.onclick = () => { onSave(); closePopover(); render(); };
  pop.append(save);
  document.body.append(backdrop, pop);
  const px = Math.min(ev.clientX, window.innerWidth - 280);
  const py = Math.min(ev.clientY, window.innerHeight - 240);
  pop.style.left = px + "px"; pop.style.top = py + "px";
}
function closePopover() { $("#popover")?.remove(); $("#popover-backdrop")?.remove(); }

function field(label, control) {
  return el("div", { className: "field" }, [el("label", { textContent: label }), control]);
}

function openButtonEditor(ev, btn, c, profile) {
  ev.stopPropagation();
  const m1 = actionSelect(btn.map1), m2 = actionSelect(btn.map2);
  const tg = el("input", { type: "checkbox", checked: btn.toggle });
  openPopover(ev, "Button mapping", [field("Action", m1), field("Secondary", m2), field("Toggle", tg)], () => {
    btn.map1 = Number(m1.value); btn.map2 = Number(m2.value); btn.toggle = tg.checked;
  });
}

function openPortEditor(ev, p, port, c, profile) {
  ev.stopPropagation();
  const val = port.kind === "stick" ? 100 + port.stick : port.kind === "button" ? port.map1 : 0;
  const m1 = actionSelect(val, { includeSticks: true });
  const m2 = actionSelect(port.kind === "button" ? port.map2 : 0);
  const tg = el("input", { type: "checkbox", checked: port.kind === "button" && port.toggle });
  openPopover(ev, `Expansion port ${p}`, [field("Mapping", m1), field("Secondary", m2), field("Toggle", tg)], () => {
    const v = Number(m1.value);
    if (v === 0) profile.ports[p] = { kind: "none" };
    else if (v > 100) profile.ports[p] = { kind: "stick", stick: v - 100, orientation: profile.ports.find((x) => x.kind === "stick")?.orientation ?? 3 };
    else profile.ports[p] = { kind: "button", analog: false, map1: v, map2: Number(m2.value), toggle: tg.checked };
  });
}

function openStickEditor(ev, stick, c, profile) {
  ev.stopPropagation();
  const stickSel = el("select");
  stickSel.append(el("option", { value: "0", textContent: "nothing" }));
  for (const [code, label] of Object.entries(STICKS)) stickSel.append(el("option", { value: code, textContent: label }));
  stickSel.value = stick.kind === "stick" ? String(stick.stick) : "0";
  const orientSel = el("select");
  for (const [code, label] of Object.entries(ORIENTATIONS)) orientSel.append(el("option", { value: code, textContent: label }));
  orientSel.value = String(stick.kind === "stick" ? stick.orientation : 3);
  // stick-click (B10 / L3) mapping — merged into this editor
  const clickSel = actionSelect(profile.buttons[9].map1);
  // work on a copy so tuning edits apply on Apply
  const draft = stick.kind === "stick" ? { ...stick, deadzone: (stick.deadzone || [0,0,0,0,0,0]).slice() } : { kind: "stick", stick: 1, orientation: 3, sensitivity: 0, deadzone: [0,0,0,0,0,0] };
  const fields = [field("Stick", stickSel), field("Orientation", orientSel), field("Click (B10)", clickSel), stickTuning(draft, () => {})];
  openPopover(ev, "Built-in stick + click", fields, () => {
    const sv = Number(stickSel.value);
    if (sv === 0) profile.ports[0] = { kind: "none" };
    else profile.ports[0] = { kind: "stick", stick: sv, orientation: Number(orientSel.value), sensitivity: draft.sensitivity ?? 0, deadzone: draft.deadzone };
    for (const pt of profile.ports) if (pt.kind === "stick") pt.orientation = Number(orientSel.value);
    profile.buttons[9].map1 = Number(clickSel.value);
  });
}

// ---- live input (Gamepad API) ----
function pollGamepads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = [...pads].find((g) => g && (/0e5f/i.test(g.id) || /access/i.test(g.id))) || [...pads].find((g) => g && g.mapping === "standard");
  const wasDetected = liveDetected;
  liveDetected = !!pad;
  const next = new Set();
  if (pad) {
    pad.buttons.forEach((b, i) => { if (b.pressed && GAMEPAD_ACTIONS[i]) next.add(GAMEPAD_ACTIONS[i]); });
    liveAxes = [pad.axes[0] || 0, pad.axes[1] || 0];
  } else {
    liveAxes = [0, 0];
  }
  // update only if changed (avoid churn)
  const changed = next.size !== liveActions.size || [...next].some((a) => !liveActions.has(a));
  liveActions = next;
  if (wasDetected !== liveDetected) {
    const ind = $("#live-ind");
    if (ind) { ind.className = "live-indicator" + (liveDetected ? " on" : ""); ind.lastChild.textContent = liveDetected ? "live input" : "no input"; }
  }
  if (viewMode === "controller") updateLiveHighlight();
  requestAnimationFrame(pollGamepads);
}

function updateLiveHighlight() {
  for (const g of document.querySelectorAll(".slot[data-action]")) {
    const a = g.getAttribute("data-action");
    g.classList.toggle("active", !!a && liveActions.has(a));
  }
  // move stick thumb relative to its base, in the layout's rotated frame
  const thumb = document.getElementById("stick-thumb");
  if (thumb) {
    const bx = parseFloat(thumb.getAttribute("data-cx")), by = parseFloat(thumb.getAttribute("data-cy"));
    const [tx, ty] = rotV(liveAxes[0], liveAxes[1], stickTheta);
    thumb.setAttribute("cx", bx + tx * THUMB_R);
    thumb.setAttribute("cy", by + ty * THUMB_R);
  }
}

// ---- init ----
async function init() {
  if (!hidSupported()) { status("WebHID not supported. Use Chrome/Edge (desktop).", "err"); return; }
  $("#add").onclick = onAdd;
  navigator.hid.addEventListener("connect", async (e) => {
    if (e.device.vendorId === 0x054c && e.device.productId === 0x0e5f) await addControllers([e.device]);
  });
  navigator.hid.addEventListener("disconnect", (e) => {
    const i = controllers.findIndex((c) => c.device === e.device);
    if (i >= 0) {
      const removed = controllers.splice(i, 1)[0];
      if (selectedId === removed.id) selectedId = controllers[0]?.id ?? null;
      render();
      status(`${removed.name} disconnected.`, "info");
    }
  });
  window.addEventListener("gamepadconnected", () => { liveDetected = true; });
  const granted = await grantedControllers();
  if (granted.length) await addControllers(granted);
  render();
  requestAnimationFrame(pollGamepads);
}
init();
