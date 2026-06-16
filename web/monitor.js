// XMB-styled live input monitor — reimagined hid-capture. Shows the controller render reacting
// to physical input, physical-button chips, the stick, and the raw input report.
import { profileSVG, decodePhysical, PHYS_NAMES, M } from "./controller-render.mjs";
import { hidSupported, grantedControllers, requestControllers, ensureOpen, readProfileRaw } from "./hid-web.mjs";
import { parseProfile } from "../lib/access-protocol.mjs";

const $ = (s) => document.querySelector(s);
let device = null, profile = null;

// ---- build static UI ----
function buildChips() {
  $("#chips").innerHTML = PHYS_NAMES.map((n, i) =>
    `<div class="chip" data-i="${i}">${i < 8 ? n : n.split("-")[0]}<small>${i < 8 ? "button" : (i === 8 ? "center" : "L3")}</small></div>`
  ).join("");
}
function buildRaw() {
  let h = "";
  for (let i = 0; i < 63; i++) h += `<div class="b${i === 15 || i === 16 ? " btn" : ""}" data-i="${i}">00</div>`;
  $("#raw").innerHTML = h;
}

// ---- live update ----
function onReport(e) {
  if (device && e.device !== device) return;
  const d = new Uint8Array(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength));
  const { buttons, axes } = decodePhysical(d);
  $("#dev").classList.add("on");
  $("#dev-name").textContent = device?.productName || "Access Controller";

  // controller render: light physical buttons + move thumb
  for (const el of document.querySelectorAll("#render svg [data-btn]")) {
    el.classList.toggle("on", buttons.has(+el.getAttribute("data-btn")));
  }
  const thumb = $("#render svg .thumb");
  if (thumb) {
    thumb.setAttribute("cx", (+thumb.dataset.bx + axes[0] * M.THUMB_R).toFixed(1));
    thumb.setAttribute("cy", (+thumb.dataset.by + axes[1] * M.THUMB_R).toFixed(1));
  }
  // chips
  for (const c of document.querySelectorAll("#chips .chip")) c.classList.toggle("on", buttons.has(+c.dataset.i));
  // stick crosshair + values
  $("#stickdot").style.left = (50 + axes[0] * 38) + "%";
  $("#stickdot").style.top = (50 + axes[1] * 38) + "%";
  $("#ax").textContent = axes[0].toFixed(2);
  $("#ay").textContent = axes[1].toFixed(2);
  // raw bytes
  const cells = $("#raw").children;
  for (let i = 0; i < d.length && i < cells.length; i++) {
    cells[i].textContent = d[i].toString(16).padStart(2, "0");
    cells[i].classList.toggle("nz", d[i] !== 0);
  }
}

// ---- connect ----
async function connect(viaGesture) {
  try {
    let ds = await grantedControllers();
    if (!ds.length && viaGesture) ds = await requestControllers();
    device = ds[0];
    if (!device) { $("#msg").textContent = "No controller selected."; return; }
    await ensureOpen(device);
    profile = parseProfile(await readProfileRaw(device, 1));
    $("#render").innerHTML = profileSVG(profile);
    device.addEventListener("inputreport", onReport);
    $("#connect-msg").style.display = "none";
    $("#stage").style.display = "grid";
  } catch (e) { $("#msg").textContent = "Error: " + (e.message || e); }
}

// ---- clock ----
function tickClock() { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

// ---- wave background (shared visual language with the XMB view) ----
function startWave() {
  const cv = $("#wave"), ctx = cv.getContext("2d");
  let w, h;
  const resize = () => { w = cv.width = innerWidth * devicePixelRatio; h = cv.height = innerHeight * devicePixelRatio; };
  resize(); addEventListener("resize", resize);
  let t = 0;
  const bands = [
    { amp: 0.10, len: 0.9, sp: 0.6, y: 0.42, hue: 215, a: 0.20 },
    { amp: 0.07, len: 1.4, sp: -0.4, y: 0.55, hue: 200, a: 0.16 },
    { amp: 0.13, len: 0.7, sp: 0.9, y: 0.66, hue: 230, a: 0.13 },
  ];
  const draw = () => {
    t += 0.005; ctx.clearRect(0, 0, w, h);
    const hueShift = 18 * Math.sin(t * 0.05);
    for (const b of bands) {
      ctx.beginPath(); ctx.moveTo(0, h);
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

// ---- init ----
function init() {
  startWave();
  tickClock(); setInterval(tickClock, 15000);
  if (!hidSupported()) { $("#msg").textContent = "WebHID not supported — use Chrome/Edge (desktop)."; $("#connect").style.display = "none"; return; }
  buildChips(); buildRaw();
  $("#connect").onclick = () => connect(true);
  // mark stale if input stops
  setInterval(() => { /* status freshness handled per-report */ }, 1000);
  grantedControllers().then((g) => { if (g.length) connect(false); });
}
init();
