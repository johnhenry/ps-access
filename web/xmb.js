// XMB-style full-screen configurator for the PlayStation Access Controller.
import {
  ACTIONS, STICKS, ORIENTATIONS, PROFILE_COUNT,
  STICK_DEFAULT_SENSITIVITY, STICK_DEFAULT_DEADZONE,
  parseProfile, buildProfile,
} from "../lib/access-protocol.mjs";
import {
  hidSupported, grantedControllers, requestControllers, ensureOpen,
  readProfileRaw, writeProfileRaw,
} from "./hid-web.mjs";

// ---- symbols (mirror app.js) ----
const SYMBOLS = { 1: "○", 2: "✕", 3: "△", 4: "□", 5: "▲", 6: "▼", 7: "◀", 8: "▶", 15: "☰", 18: "▭" };
const symLabel = (code) => (code === 0 ? "—" : SYMBOLS[code] ?? ACTIONS[code] ?? `?${code}`);
const nameLabel = (code) => (code === 0 ? "Not assigned" : ACTIONS[code] ?? `?${code}`);

const $ = (s) => document.querySelector(s);

// ============================ state ============================
let controllers = []; // { device, name, profiles:[obj x3] }
let activeCtrl = 0;
// nav: col = blade index, row = vertical item index, drill = { key, index } | null
const nav = { col: 1, row: 0, drill: null };
let soundOn = false;
let liveActions = new Set();
let liveAxes = [0, 0];
let gamepadDetected = false;
let renaming = false;

const BLADES = [
  { key: "controllers", label: "Controllers", kind: "controllers", glyph: "🎮" },
  { key: "p1", label: "Profile 1", kind: "profile", slot: 0 },
  { key: "p2", label: "Profile 2", kind: "profile", slot: 1 },
  { key: "p3", label: "Profile 3", kind: "profile", slot: 2 },
  { key: "save", label: "Save", kind: "save", glyph: "▣" },
];

function activeProfile() {
  const b = BLADES[nav.col];
  if (b?.kind === "profile") return controllers[activeCtrl]?.profiles[b.slot] || null;
  return controllers[activeCtrl]?.profiles[0] || null;
}

// ============================ controller SVG ============================
const M = { CX: 220, CY: 220, RO: 140, RI: 82, RM: 111, CTR: 54, GAP: 3.2, CORNER: 14,
  STICK_DIST: 182, STICK_R: 30, THUMB_R: 14, PORT_R: 17, PORT_ARC: 186 };
const ORIENT_ROT = { 0: 0, 1: 270, 2: 180, 3: 90 };
const rotV = (x, y, t) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
const rad = (d) => d * Math.PI / 180;

function roundedWedge(cx, cy, ri, ro, a0, a1, cr) {
  const pol = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const f = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  cr = Math.min(cr, (ro - ri) / 2 - 1, ((a1 - a0) * ri) / 2 - 1);
  const dO = Math.asin(cr / (ro - cr)), dI = Math.asin(cr / (ri + cr));
  const roS = (ro - cr) * Math.cos(dO), riS = (ri + cr) * Math.cos(dI);
  const P1 = pol(ro, a0 + dO), P2 = pol(ro, a1 - dO), P3 = pol(roS, a1), P4 = pol(riS, a1),
    P5 = pol(ri, a1 - dI), P6 = pol(ri, a0 + dI), P7 = pol(riS, a0), P8 = pol(roS, a0);
  return `M${f(P1)} A${ro},${ro} 0 0 1 ${f(P2)} A${cr},${cr} 0 0 1 ${f(P3)} L${f(P4)} `
    + `A${cr},${cr} 0 0 1 ${f(P5)} A${ri},${ri} 0 0 0 ${f(P6)} A${cr},${cr} 0 0 1 ${f(P7)} `
    + `L${f(P8)} A${cr},${cr} 0 0 1 ${f(P1)} Z`;
}

// Build a neutral controller SVG. Live highlighting (button presses + stick motion) is applied
// separately by updateLive() to every on-screen render, so all instances respond at once.
// `focus` = {type:'button'|'port'|'stick'|'center', index} outlines one input (drill-in).
function profileSVG(profile, { focus = null } = {}) {
  if (!profile) return "";
  const stick = profile.ports[0];
  const orient = stick.kind === "stick" ? stick.orientation : 3;
  const oDeg = ORIENT_ROT[orient] ?? 0, theta = rad(oDeg);
  const pDeg = ORIENT_ROT[profile._physOrient ?? orient] ?? 0; // device's real stick side
  const R = (x, y) => { const [rx, ry] = rotV(x - M.CX, y - M.CY, theta); return [M.CX + rx, M.CY + ry]; };
  const act = (code) => (code && ACTIONS[code]) ? ` data-act="${ACTIONS[code]}"` : "";
  const seg = (f) => `seg${f ? " foc" : ""}`;
  let s = `<svg viewBox="0 0 440 440" xmlns="http://www.w3.org/2000/svg">`;

  // 8 wedge buttons (counter-clockwise, B5 opposite stick)
  for (let i = 0; i < 8; i++) {
    const ca = rad(90 - i * 45 + oDeg);
    const d = roundedWedge(M.CX, M.CY, M.RI, M.RO, ca - rad(22.5 - M.GAP), ca + rad(22.5 - M.GAP), M.CORNER);
    const b = profile.buttons[i];
    s += `<path d="${d}" class="${seg(focus?.type === "button" && focus.index === i)}"${act(b.map1)}/>`;
    s += `<text x="${(M.CX + M.RM * Math.cos(ca)).toFixed(1)}" y="${(M.CY + M.RM * Math.sin(ca) + 7).toFixed(1)}" class="lab">${symLabel(b.map1)}</text>`;
  }
  // center (B9)
  s += `<circle cx="${M.CX}" cy="${M.CY}" r="${M.CTR}" class="${seg(focus?.type === "center")}"${act(profile.buttons[8].map1)}/>`;
  s += `<text x="${M.CX}" y="${M.CY + 8}" class="lab big">${symLabel(profile.buttons[8].map1)}</text>`;
  // ports
  for (let p = 1; p <= 4; p++) {
    const a = rad(-90 + (p - 2.5) * 24 + oDeg);
    const [x, y] = [M.CX + M.PORT_ARC * Math.cos(a), M.CY + M.PORT_ARC * Math.sin(a)];
    const port = profile.ports[p];
    const lbl = port.kind === "stick" ? "stk" : port.kind === "button" ? symLabel(port.map1) : `E${p}`;
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${M.PORT_R}" class="${seg(focus?.type === "port" && focus.index === p)}"${port.kind === "button" ? act(port.map1) : ""}/>`;
    s += `<text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" class="lab sm">${lbl}</text>`;
  }
  // stick — thumb carries the data updateLive() needs to animate it in this render's frame
  const [sx, sy] = R(M.CX, M.CY + M.STICK_DIST);
  s += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${M.STICK_R}" class="stickwell${focus?.type === "stick" ? " foc" : ""}"/>`;
  s += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${M.STICK_R - 8}" class="thumb" data-bx="${sx.toFixed(1)}" data-by="${sy.toFixed(1)}" data-odeg="${oDeg}" data-pdeg="${pDeg}"${act(profile.buttons[9].map1)}/>`;
  s += `</svg>`;
  return s;
}

// Apply current live gamepad state to ALL on-screen controller renders (any orientation).
function updateLive() {
  for (const el of document.querySelectorAll("#stage svg [data-act]")) {
    el.classList.toggle("on", liveActions.has(el.getAttribute("data-act")));
  }
  for (const th of document.querySelectorAll("#stage svg .thumb")) {
    const bx = +th.dataset.bx, by = +th.dataset.by;
    const t = rad((+th.dataset.odeg) - (+th.dataset.pdeg)); // rotate relative to the device's real side
    const [vx, vy] = rotV(liveAxes[0], liveAxes[1], t);
    th.setAttribute("cx", (bx + vx * M.THUMB_R).toFixed(1));
    th.setAttribute("cy", (by + vy * M.THUMB_R).toFixed(1));
  }
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
function bladeItems(blade) {
  if (blade.kind === "profile") {
    return [
      { key: "buttons", label: "Buttons", drill: true },
      { key: "stick", label: "Built-in stick", drill: true },
      { key: "ports", label: "Expansion ports", drill: true },
      { key: "tuning", label: "Stick tuning", drill: true },
      { key: "rename", label: "Rename profile", action: "rename" },
      { key: "save", label: "Save to controller", action: "save" },
    ];
  }
  if (blade.kind === "controllers") {
    return controllers.map((c, i) => ({ key: "ctrl" + i, label: c.name + (i === activeCtrl ? "  ✓" : ""), action: "selectCtrl", ctrl: i }));
  }
  if (blade.kind === "save") {
    return [
      { key: "savep", label: "Save this profile", action: "save" },
      { key: "saveall", label: "Save all 3 profiles", action: "saveAll" },
      { key: "reload", label: "Reload from controller", action: "reload" },
    ];
  }
  return [];
}

// ============================ rendering ============================
function render() {
  const bladesEl = $("#blades");
  bladesEl.innerHTML = "";
  BLADES.forEach((b, i) => {
    const el = document.createElement("div");
    el.className = "blade" + (i === nav.col ? " focused" : "");
    const icon = document.createElement("div");
    icon.className = "icon";
    if (b.kind === "profile") icon.innerHTML = profileSVG(controllers[activeCtrl]?.profiles[b.slot], { live: false });
    else { const g = document.createElement("div"); g.className = "glyph"; g.textContent = b.glyph; icon.append(g); }
    const lab = document.createElement("div");
    lab.className = "label";
    lab.textContent = b.label;
    el.append(icon, lab);
    bladesEl.append(el);
  });

  bladesEl.classList.toggle("drilled", !!nav.drill);
  renderItems();
  renderHero();
  renderCrumb();
  layout();
  updateLive(); // re-apply live state to freshly built renders
}

function renderItems() {
  const wrap = $("#items");
  wrap.innerHTML = "";
  const blade = BLADES[nav.col];
  if (nav.drill) {
    const profile = activeProfile();
    const rows = drillRows(profile, nav.drill.key);
    rows.forEach((r, i) => {
      const v = r.get();
      const disp = r.display(v);
      const el = document.createElement("div");
      el.className = "item" + (i === nav.drill.index ? " sel" : "");
      el.innerHTML = `<span class="lab">${r.label}</span><span class="val"><span class="arrow">◀</span><span class="sym">${disp.sym || ""}</span> ${disp.name}<span class="arrow">▶</span></span>`;
      el.onclick = () => { nav.drill.index = i; render(); };
      wrap.append(el);
    });
  } else {
    const items = bladeItems(blade);
    items.forEach((it, i) => {
      const el = document.createElement("div");
      el.className = "item" + (i === nav.row ? " sel" : "");
      el.innerHTML = `<span class="chev">▸</span><span class="lab">${it.label}</span>`;
      el.onclick = () => { nav.row = i; activate(); };
      wrap.append(el);
    });
  }
}

function renderHero() {
  const blade = BLADES[nav.col];
  const hero = $("#hero");
  // The blade itself is the render; the enlarged hero appears only when you drill in.
  const profile = activeProfile();
  if (!nav.drill || !profile) { hero.style.opacity = "0"; hero.innerHTML = ""; return; }
  const rows = drillRows(profile, nav.drill.key);
  const focus = rows[nav.drill.index]?.focus || null;
  hero.innerHTML = profileSVG(profile, { focus });
  hero.style.opacity = ".97";
}

function renderCrumb() {
  const blade = BLADES[nav.col];
  let txt = blade.label;
  if (nav.drill) txt += " ›  " + ({ buttons: "Buttons", stick: "Built-in stick", ports: "Expansion ports", tuning: "Stick tuning" }[nav.drill.key] || "");
  $("#crumb").textContent = txt;
}

// position the ribbon + item list to form the cross
function layout() {
  const bladesEl = $("#blades");
  const focused = bladesEl.children[nav.col];
  if (!focused) return;
  const crossX = window.innerWidth * 0.3;
  const bx = focused.offsetLeft + focused.offsetWidth / 2;
  bladesEl.style.transform = `translateX(${crossX - bx}px)`;

  const items = $("#items");
  const crossY = window.innerHeight * 0.38;
  items.style.left = crossX + "px";
  items.style.top = crossY + 150 + "px"; // list hangs below the blade
  // keep the selected row visible without hiding earlier rows: only scroll once the list
  // grows past a comfortable count
  const selIdx = nav.drill ? nav.drill.index : nav.row;
  const rowH = 42, visible = 9;
  const scroll = Math.max(0, selIdx - (visible - 2)) * rowH;
  items.style.transform = `translateY(${-scroll}px)`;
}

// ============================ actions ============================
function activate() {
  const blade = BLADES[nav.col];
  const items = bladeItems(blade);
  const it = items[nav.row];
  if (!it) return;
  blip(660);
  if (it.drill) { nav.drill = { key: it.key, index: 0 }; render(); return; }
  switch (it.action) {
    case "selectCtrl": activeCtrl = it.ctrl; nav.col = 1; nav.row = 0; render(); toast("Controller " + (it.ctrl + 1)); break;
    case "rename": startRename(); break;
    case "save": saveProfileFor(BLADES[nav.col].kind === "profile" ? BLADES[nav.col].slot : 0); break;
    case "saveAll": saveAll(); break;
    case "reload": reloadFromDevice(); break;
  }
}

function startRename() {
  const blade = BLADES[nav.col];
  if (blade.kind !== "profile") return;
  const profile = controllers[activeCtrl].profiles[blade.slot];
  renaming = true;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = profile.name || "";
  input.maxLength = 40;
  const sel = $("#items").querySelector(".item.sel");
  sel.innerHTML = "";
  sel.append(input);
  input.focus();
  const done = (commit) => { renaming = false; if (commit) profile.name = input.value; render(); };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") done(true);
    else if (e.key === "Escape") done(false);
  });
  input.addEventListener("blur", () => done(true));
}

// ============================ device ============================
async function load() {
  if (!hidSupported()) { $("#unsupported").classList.add("show"); return; }
  const granted = await grantedControllers();
  if (!granted.length) {
    // need a user gesture to request; show a prompt overlay
    toast("Click anywhere to connect your controller", 6000);
    document.body.addEventListener("click", connectOnce, { once: true });
    return;
  }
  await addDevices(granted);
}
async function connectOnce() {
  try { const ds = await requestControllers(); await addDevices(ds); } catch (e) { toast(String(e.message || e)); }
}
async function addDevices(devices) {
  for (const device of devices) {
    if (controllers.some((c) => c.device === device)) continue;
    await ensureOpen(device);
    const profiles = [];
    for (let s = 1; s <= PROFILE_COUNT; s++) {
      const p = parseProfile(await readProfileRaw(device, s));
      p._physOrient = p.ports[0].kind === "stick" ? p.ports[0].orientation : 3;
      profiles.push(p);
    }
    controllers.push({ device, name: `Controller ${controllers.length + 1}`, profiles });
  }
  updateDeviceStatus();
  render();
}
function updateDeviceStatus() {
  const c = controllers[activeCtrl];
  $("#dev-name").textContent = c ? c.name : "No controller";
  $("#dev-dot").style.background = c ? "var(--ok)" : "var(--dim)";
}

async function saveProfileFor(slot) {
  const c = controllers[activeCtrl];
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
async function saveAll() {
  for (let s = 0; s < PROFILE_COUNT; s++) await saveProfileFor(s);
  toast("Saved all profiles", 2500);
}
async function reloadFromDevice() {
  const c = controllers[activeCtrl];
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

// ============================ input ============================
function move(dx, dy) {
  if (renaming) return;
  if (nav.drill) {
    const profile = activeProfile();
    const rows = drillRows(profile, nav.drill.key);
    if (dy) { nav.drill.index = clamp(nav.drill.index + dy, 0, rows.length - 1); blip(440); render(); }
    if (dx) { // spinner: cycle the focused row's value
      const r = rows[nav.drill.index];
      const cur = r.values.indexOf(r.get());
      const next = r.values[(cur + dx + r.values.length) % r.values.length];
      r.set(next); blip(560); render();
    }
    return;
  }
  if (dx) {
    nav.col = clamp(nav.col + dx, 0, BLADES.length - 1);
    nav.row = 0; blip(520); render();
  }
  if (dy) {
    const items = bladeItems(BLADES[nav.col]);
    nav.row = clamp(nav.row + dy, 0, items.length - 1); blip(440); render();
  }
}
function back() {
  if (renaming) return;
  if (nav.drill) { nav.drill = null; blip(330); render(); }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

window.addEventListener("keydown", (e) => {
  if (renaming) return;
  const k = e.key;
  if (k === "ArrowLeft") { move(-1, 0); e.preventDefault(); }
  else if (k === "ArrowRight") { move(1, 0); e.preventDefault(); }
  else if (k === "ArrowUp") { move(0, -1); e.preventDefault(); }
  else if (k === "ArrowDown") { move(0, 1); e.preventDefault(); }
  else if (k === "Enter") { if (!nav.drill) activate(); }
  else if (k === "Backspace" || k === "Escape") { back(); e.preventDefault(); }
  else if (k === "m" || k === "M") { soundOn = !soundOn; toast("Sound " + (soundOn ? "on" : "off"), 1200); }
});

// ---- gamepad polling (navigation + live highlight) ----
const gpPrev = {};
let gpRepeat = 0;
function pollGamepad() {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  const pad = pads.find((g) => /0e5f|access/i.test(g.id)) || pads.find((g) => g.mapping === "standard");
  gamepadDetected = !!pad;
  const gs = $("#gp-status");
  if (gs) { gs.textContent = pad ? "controller: connected" : "controller: not detected"; gs.classList.toggle("on", !!pad); }
  if (pad) {
    // live highlight set (by action name) + axes
    const next = new Set();
    pad.buttons.forEach((b, i) => { if (b.pressed && GP_ACTION[i]) next.add(GP_ACTION[i]); });
    liveActions = next;
    liveAxes = [pad.axes[0] || 0, pad.axes[1] || 0];
    updateLive(); // all renders respond, every frame

    // navigation: dpad (12-15) + left stick, with debounce/repeat
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    const left = pad.buttons[14]?.pressed || ax < -0.5;
    const right = pad.buttons[15]?.pressed || ax > 0.5;
    const up = pad.buttons[12]?.pressed || ay < -0.5;
    const down = pad.buttons[13]?.pressed || ay > 0.5;
    const sel = pad.buttons[0]?.pressed; // cross
    const bk = pad.buttons[1]?.pressed;   // circle
    gpRepeat = gpRepeat > 0 ? gpRepeat - 1 : 0;
    const edge = (name, val) => { const was = gpPrev[name]; gpPrev[name] = val; return val && !was; };
    const heldDir = left || right || up || down;
    if (edge("left", left) || edge("right", right) || edge("up", up) || edge("down", down)) {
      if (left) move(-1, 0); else if (right) move(1, 0); else if (up) move(0, -1); else if (down) move(0, 1);
      gpRepeat = 22;
    } else if (heldDir && gpRepeat === 0) {
      if (left) move(-1, 0); else if (right) move(1, 0); else if (up) move(0, -1); else if (down) move(0, 1);
      gpRepeat = 9;
    }
    if (edge("sel", sel) && !nav.drill) activate();
    if (edge("bk", bk)) back();
  }
  requestAnimationFrame(pollGamepad);
}
const GP_ACTION = ["cross", "circle", "square", "triangle", "L1", "R1", "L2", "R2", "create", "options", "L3", "R3", "up", "down", "left", "right", "PS", "touchpad"];

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
function startWave() {
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
    for (const b of bands) {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 16 * devicePixelRatio) {
        const y = h * b.y + Math.sin(x / w * Math.PI * 2 * b.len + t * b.sp) * h * b.amp
          + Math.sin(x / w * Math.PI * 5 * b.len - t * b.sp * 1.7) * h * b.amp * 0.3;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h); ctx.closePath();
      const g = ctx.createLinearGradient(0, h * b.y - h * 0.2, 0, h);
      g.addColorStop(0, `hsla(${b.hue + hueShift},70%,55%,${b.a})`);
      g.addColorStop(1, `hsla(${b.hue + hueShift},70%,30%,0)`);
      ctx.fillStyle = g; ctx.fill();
    }
    requestAnimationFrame(draw);
  };
  draw();
}

// ============================ init ============================
function init() {
  startWave();
  tickClock(); setInterval(tickClock, 15000);
  requestAnimationFrame(pollGamepad);
  if (navigator.hid) {
    navigator.hid.addEventListener("disconnect", () => { /* keep simple: status refresh */ updateDeviceStatus(); });
  }
  render();
  load();
}
init();
