// Shared controller rendering + physical-input decoding for the XMB configurator and the
// input monitor. Pure (no DOM/IO) so any page can build a render and decode reports.
import { ACTIONS } from "./access-protocol.mjs";

// Glyphs for actions with a recognizable symbol; others fall back to short text.
export const SYMBOLS = { 1: "○", 2: "✕", 3: "△", 4: "□", 5: "▲", 6: "▼", 7: "◀", 8: "▶", 15: "☰", 18: "▭" };
export const symLabel = (code) => (code === 0 ? "—" : SYMBOLS[code] ?? ACTIONS[code] ?? `?${code}`);
export const nameLabel = (code) => (code === 0 ? "Not assigned" : ACTIONS[code] ?? `?${code}`);

// geometry
export const M = { CX: 220, CY: 220, RO: 140, RI: 82, RM: 111, CTR: 54, GAP: 3.2, CORNER: 14,
  STICK_DIST: 182, STICK_R: 30, THUMB_R: 14, PORT_R: 17, PORT_ARC: 186 };
export const ORIENT_ROT = { 0: 0, 1: 270, 2: 180, 3: 90 };
export const rotV = (x, y, t) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
export const rad = (d) => d * Math.PI / 180;

export function roundedWedge(cx, cy, ri, ro, a0, a1, cr) {
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

// Build a neutral controller SVG. Live highlight (data-btn → .on) + thumb motion are applied
// by the page. `focus` = {type:'button'|'port'|'stick', index} outlines one input.
export function profileSVG(profile, { focus = null } = {}) {
  if (!profile) return "";
  const stick = profile.ports[0];
  const orient = stick.kind === "stick" ? stick.orientation : 3;
  const oDeg = ORIENT_ROT[orient] ?? 0, theta = rad(oDeg);
  const R = (x, y) => { const [rx, ry] = rotV(x - M.CX, y - M.CY, theta); return [M.CX + rx, M.CY + ry]; };
  const seg = (f) => `seg${f ? " foc" : ""}`;
  let s = `<svg viewBox="0 0 440 440" xmlns="http://www.w3.org/2000/svg">`;
  for (let i = 0; i < 8; i++) {
    const ca = rad(90 - i * 45 + oDeg);
    const d = roundedWedge(M.CX, M.CY, M.RI, M.RO, ca - rad(22.5 - M.GAP), ca + rad(22.5 - M.GAP), M.CORNER);
    const b = profile.buttons[i];
    s += `<path d="${d}" class="${seg(focus?.type === "button" && focus.index === i)}" data-btn="${i}"/>`;
    s += `<text x="${(M.CX + M.RM * Math.cos(ca)).toFixed(1)}" y="${(M.CY + M.RM * Math.sin(ca) + 7).toFixed(1)}" class="lab">${symLabel(b.map1)}</text>`;
  }
  s += `<circle cx="${M.CX}" cy="${M.CY}" r="${M.CTR}" class="${seg(focus?.type === "button" && focus.index === 8)}" data-btn="8"/>`;
  s += `<text x="${M.CX}" y="${M.CY + 8}" class="lab big">${symLabel(profile.buttons[8].map1)}</text>`;
  for (let p = 1; p <= 4; p++) {
    const a = rad(-90 + (p - 2.5) * 24 + oDeg);
    const [x, y] = [M.CX + M.PORT_ARC * Math.cos(a), M.CY + M.PORT_ARC * Math.sin(a)];
    const port = profile.ports[p];
    const lbl = port.kind === "stick" ? "stk" : port.kind === "button" ? symLabel(port.map1) : `E${p}`;
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${M.PORT_R}" class="${seg(focus?.type === "port" && focus.index === p)}"/>`;
    s += `<text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" class="lab sm">${lbl}</text>`;
  }
  const [sx, sy] = R(M.CX, M.CY + M.STICK_DIST);
  const stickFoc = focus?.type === "stick" || (focus?.type === "button" && focus.index === 9);
  s += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${M.STICK_R}" class="stickwell${stickFoc ? " foc" : ""}"/>`;
  s += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${M.STICK_R - 8}" class="thumb${stickFoc ? " foc" : ""}" data-bx="${sx.toFixed(1)}" data-by="${sy.toFixed(1)}" data-btn="9"/>`;
  s += `</svg>`;
  return s;
}

// Physical button names by index (0-7 perimeter 1-8, 8 center, 9 stick-click). Reverse-engineered.
export const PHYS_NAMES = ["1", "2", "3", "4", "5", "6", "7", "8", "Center", "Stick-click"];

// Decode physical button + stick state from a raw input-report data view (report id excluded):
// byte 15 bits 0-7 = perimeter 1-8; byte 16 bit 0 = center, bit 1 = stick-click; bytes 0/1 = stick X/Y;
// byte 16 bit 3 (0x08) = profile-switch button; byte 39 = active on-device profile (1-based).
export function decodePhysical(data) {
  const buttons = new Set();
  for (let bit = 0; bit < 8; bit++) if (data[15] & (1 << bit)) buttons.add(bit);
  if (data[16] & 0x01) buttons.add(8);
  if (data[16] & 0x02) buttons.add(9);
  const dz = (v) => (Math.abs(v) < 0.16 ? 0 : v);
  const profile = data.length > 39 && data[39] >= 1 && data[39] <= 3 ? data[39] : 0; // 0 = unknown
  return { buttons, axes: [dz((data[0] - 128) / 128), dz((data[1] - 128) / 128)], profile };
}
