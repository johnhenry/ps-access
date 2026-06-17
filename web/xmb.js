// XMB-style full-screen configurator for the PlayStation Access Controller.
import {
  ACTIONS, STICKS, ORIENTATIONS, PROFILE_COUNT,
  STICK_DEFAULT_SENSITIVITY, STICK_DEFAULT_DEADZONE,
  parseProfile, buildProfile,
} from "./access-protocol.mjs";
import {
  hidSupported, grantedControllers, requestControllers, ensureOpen,
  readProfileRaw, writeProfileRaw,
} from "./hid-web.mjs";
import { SYMBOLS, symLabel, nameLabel, M, profileSVG, decodePhysical, PHYS_NAMES } from "./controller-render.mjs";

const $ = (s) => document.querySelector(s);

// ============================ state ============================
let controllers = []; // { device, name, profiles:[obj x3] }
let activeCtrl = 0;
// nav: col = blade index, row = vertical item index, drill = { key, index } | null
const nav = { col: 1, row: 0, drill: null };
let soundOn = false;
let phys = new Set();      // physically-pressed button indices (0-7 perimeter, 8 center, 9 stick-click)
let liveAxes = [0, 0];     // physical stick, -1..1
let lastInputAt = 0;
let renaming = false;
let monitorMode = false;   // full-screen live input monitor open
let monitorArm = false;    // warning/confirm gate shown before entering the monitor
let lastProfileSlot = 0;   // slot of the most recently focused profile blade — what the Save blade acts on
let deviceProfile = null;  // active on-device profile slot (0-based, from input-report byte 39); null until known

const BLADES = [
  { key: "controllers", label: "Controllers", kind: "controllers" },
  { key: "p1", label: "Profile 1", kind: "profile", slot: 0 },
  { key: "p2", label: "Profile 2", kind: "profile", slot: 1 },
  { key: "p3", label: "Profile 3", kind: "profile", slot: 2 },
  { key: "save", label: "Save", kind: "save", glyph: "▣" },
  { key: "monitor", label: "Monitor", kind: "monitor" },
];

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

function activeProfile() {
  const b = BLADES[nav.col];
  if (b?.kind === "profile") return controllers[activeCtrl]?.profiles[b.slot] || null;
  return controllers[activeCtrl]?.profiles[0] || null;
}

// Apply current physical button state to ALL on-screen controller renders (any orientation).
function updateLive() {
  for (const el of document.querySelectorAll("#stage svg [data-btn]")) {
    el.classList.toggle("on", phys.has(+el.getAttribute("data-btn")));
  }
  for (const th of document.querySelectorAll("#stage svg .thumb")) {
    // raw axes — the live thumb always reflects the physical stick, regardless of the
    // displayed orientation (which only relocates where the stick is drawn)
    const bx = +th.dataset.bx, by = +th.dataset.by;
    th.setAttribute("cx", (bx + liveAxes[0] * M.THUMB_R).toFixed(1));
    th.setAttribute("cy", (by + liveAxes[1] * M.THUMB_R).toFixed(1));
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
      { key: "savep", label: `Save Profile ${lastProfileSlot + 1}` + (controllers[activeCtrl]?.profiles[lastProfileSlot]?.name ? ` · ${controllers[activeCtrl].profiles[lastProfileSlot].name}` : ""), action: "save" },
      { key: "saveall", label: "Save all 3 profiles", action: "saveAll" },
      { key: "reload", label: "Reload from controller", action: "reload" },
    ];
  }
  if (blade.kind === "monitor") {
    return [{ key: "openmon", label: "Open live monitor", action: "monitor" }];
  }
  return [];
}

// ============================ rendering ============================
// The profile slot the indicator/monitor reflect: the controller's *active* profile (set with the
// device's profile button, read live from the input report) when known, else the focused UI profile.
function shownProfileSlot() {
  return deviceProfile ?? lastProfileSlot;
}
// Top-bar profile context (under the controller name) — shows the active on-device profile.
function updateProfileTag() {
  const el = $("#mon-prof");
  if (!el) return;
  const slot = shownProfileSlot();
  const prof = controllers[activeCtrl]?.profiles[slot];
  if (!prof) { el.innerHTML = ""; return; }
  const st = prof.ports[0];
  const orient = st.kind === "stick" ? st.orientation : 3;
  el.innerHTML = `<b>Profile ${slot + 1}</b> · ` +
    (prof.name ? `${prof.name} · ` : "") + ORIENTATIONS[orient];
}

function render() {
  if (BLADES[nav.col]?.kind === "profile") lastProfileSlot = BLADES[nav.col].slot;
  updateProfileTag();
  const bladesEl = $("#blades");
  bladesEl.innerHTML = "";
  BLADES.forEach((b, i) => {
    const el = document.createElement("div");
    el.className = "blade" + (i === nav.col ? " focused" : "");
    const icon = document.createElement("div");
    icon.className = "icon";
    if (b.kind === "profile") icon.innerHTML = profileSVG(controllers[activeCtrl]?.profiles[b.slot]);
    else {
      const g = document.createElement("div"); g.className = "glyph";
      if (b.kind === "controllers") g.innerHTML = CONTROLLER_ICON;
      else if (b.kind === "save") g.innerHTML = SAVE_ICON;
      else if (b.kind === "monitor") g.innerHTML = MONITOR_ICON;
      else g.textContent = b.glyph;
      icon.append(g);
    }
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
    case "save": saveProfileFor(BLADES[nav.col].kind === "profile" ? BLADES[nav.col].slot : lastProfileSlot); break;
    case "saveAll": saveAll(); break;
    case "reload": reloadFromDevice(); break;
    case "monitor": armMonitor(); break;
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
    device.addEventListener("inputreport", onInputReport); // physical buttons + stick, live
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

// ============================ live input monitor ============================
// Full-screen overlay. The controller is purely observed here (navigation is suspended), so
// every physical button and the stick can be tested freely; exit with Esc or the Done button.
function buildMonChips() {
  $("#mon-chips").innerHTML = PHYS_NAMES.map((n, i) =>
    `<div class="chip" data-i="${i}">${i < 8 ? n : n.split("-")[0]}<small>${i < 8 ? "button" : (i === 8 ? "center" : "L3")}</small></div>`).join("");
}
function buildMonRaw() {
  let h = "";
  for (let i = 0; i < 63; i++) h += `<div class="b${i === 15 || i === 16 ? " btn" : ""}" data-i="${i}">00</div>`;
  $("#mon-raw").innerHTML = h;
}
// Step 1: warn the user that the controller can't exit this view (Esc / Done only),
// and let them back out. Operable by keyboard (Enter/Esc), controller (confirm/back), or mouse.
function armMonitor() {
  if (!controllers[activeCtrl]) { toast("Connect a controller first"); return; }
  monitorArm = true;
  inputEdge.confirm = true; inputEdge.back = true; // swallow the press that opened this gate
  $("#mon-warn").classList.add("show");
}
function cancelArm() {
  if (!monitorArm) return;
  monitorArm = false;
  $("#mon-warn").classList.remove("show");
  blip(330);
}
function confirmArm() {
  if (!monitorArm) return;
  monitorArm = false;
  $("#mon-warn").classList.remove("show");
  enterMonitor();
}
// Step 2: enter the live monitor, rendering the *chosen* profile (so the controller image
// matches that profile's orientation) and showing which profile is on screen.
function enterMonitor() {
  if (!controllers[activeCtrl]) { toast("Connect a controller first"); return; }
  const prof = controllers[activeCtrl].profiles[shownProfileSlot()]; // the active on-device profile
  monitorMode = true;
  $("#mon-render").innerHTML = profileSVG(prof);                 // profileSVG bakes in the orientation
  updateProfileTag();                                            // top-bar already shows it, keep in sync
  if (!$("#mon-chips").children.length) buildMonChips();
  if (!$("#mon-raw").children.length) buildMonRaw();
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
function updateMonitor(buttons, axes, d) {
  for (const el of document.querySelectorAll("#mon-render svg [data-btn]"))
    el.classList.toggle("on", buttons.has(+el.getAttribute("data-btn")));
  const thumb = $("#mon-render svg .thumb");
  if (thumb) {
    thumb.setAttribute("cx", (+thumb.dataset.bx + axes[0] * M.THUMB_R).toFixed(1));
    thumb.setAttribute("cy", (+thumb.dataset.by + axes[1] * M.THUMB_R).toFixed(1));
  }
  for (const c of $("#mon-chips").children) c.classList.toggle("on", buttons.has(+c.dataset.i));
  $("#mon-stickdot").style.left = (50 + axes[0] * 38) + "%";
  $("#mon-stickdot").style.top = (50 + axes[1] * 38) + "%";
  $("#mon-ax").textContent = axes[0].toFixed(2);
  $("#mon-ay").textContent = axes[1].toFixed(2);
  const cells = $("#mon-raw").children;
  for (let i = 0; i < d.length && i < cells.length; i++) {
    cells[i].textContent = d[i].toString(16).padStart(2, "0");
    cells[i].classList.toggle("nz", d[i] !== 0);
  }
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
  if (monitorArm) {
    if (e.key === "Enter") { confirmArm(); e.preventDefault(); }
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
  else if (k === "Enter") { if (!nav.drill) activate(); }
  else if (k === "Backspace" || k === "Escape") { back(); e.preventDefault(); }
  else if (k === "m" || k === "M") { soundOn = !soundOn; toast("Sound " + (soundOn ? "on" : "off"), 1200); }
});

// ---- physical input via the raw HID input report ----
// Physical buttons: byte 15 bits 0-7 = perimeter 1-8; byte 16 bit 0 = center (9), bit 1 = stick-click (10).
// Nav scheme (per design): center/stick-click = confirm; any perimeter button = back; stick = directions.
const inputEdge = {};
let dirRepeatAt = 0;
function onInputReport(e) {
  if (e.device !== controllers[activeCtrl]?.device) return;
  const d = new Uint8Array(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength));
  lastInputAt = performance.now();
  const { buttons, axes, profile } = decodePhysical(d);
  liveAxes = axes;
  phys = buttons;
  // Track the controller's *active* profile (changed with the device's profile button). When it
  // changes, refresh the top-bar indicator and, if the monitor is open, re-render it for that profile.
  if (profile && profile - 1 !== deviceProfile) {
    deviceProfile = profile - 1;
    updateProfileTag();
    if (monitorMode) $("#mon-render").innerHTML = profileSVG(controllers[activeCtrl].profiles[deviceProfile]);
  }
  if (monitorMode) { updateMonitor(buttons, axes, d); setGpStatus(true); return; }
  if (monitorArm) { handleArmInput(buttons); setGpStatus(true); return; }
  handlePhysInput(buttons, axes);
  updateLive();
  setGpStatus(true);
}

function handlePhysInput(buttons, axes) {
  if (renaming) return;
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
  const confirm = buttons.has(8) || buttons.has(9);           // center or stick-click
  const wantBack = [0, 1, 2, 3, 4, 5, 6, 7].some((i) => buttons.has(i)); // any perimeter
  if (confirm && !inputEdge.confirm && !nav.drill) activate();
  inputEdge.confirm = confirm;
  if (wantBack && !inputEdge.back) back();
  inputEdge.back = wantBack;
}

// On the warning gate, confirm (center/stick-click) starts; back (any perimeter) cancels.
function handleArmInput(buttons) {
  const confirm = buttons.has(8) || buttons.has(9);
  const wantBack = [0, 1, 2, 3, 4, 5, 6, 7].some((i) => buttons.has(i));
  if (confirm && !inputEdge.confirm) confirmArm();
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
  // mark the controller disconnected if no input report has arrived recently
  setInterval(() => { if (performance.now() - lastInputAt > 1500) setGpStatus(false); }, 800);
  if (navigator.hid) {
    navigator.hid.addEventListener("disconnect", () => { /* keep simple: status refresh */ updateDeviceStatus(); });
  }
  $("#mon-done").onclick = exitMonitor;
  $("#warn-start").onclick = confirmArm;
  $("#warn-cancel").onclick = cancelArm;
  render();
  load();
}
init();
