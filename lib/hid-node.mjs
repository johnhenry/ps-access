// node-hid transport for the Access Controller. Wraps the platform-agnostic protocol
// in lib/access-protocol.mjs with actual feature-report I/O.
import HID from "node-hid";
import {
  VENDOR_ID, PRODUCT_ID, REPORT_ID_CMD, REPORT_ID_DATA, CMD_PAYLOAD_SIZE,
  PROFILE_SIZE, PACKETS_PER_PROFILE, buildReadCommand, assembleProfile, buildWritePackets,
  buildSetActiveCommand,
} from "../web/access-protocol.mjs";

// All connected Access Controllers, in a stable order, with index labels.
export function listControllers() {
  const devices = HID.devices().filter((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
  return devices.map((d, i) => ({
    index: i,
    path: d.path,
    serialNumber: d.serialNumber || null,
    product: d.product || "Access Controller",
    manufacturer: d.manufacturer || "Sony",
    release: d.release,
    interface: d.interface,
  }));
}

// Open a controller by index (default 0) or by HID path.
export function openController(selector = 0) {
  const list = listControllers();
  if (list.length === 0) throw new Error("No Access Controller found (VID 054C / PID 0E5F). Connect it via USB-C.");
  let entry;
  if (typeof selector === "string" && selector.startsWith("/")) entry = list.find((d) => d.path === selector);
  else entry = list[Number(selector)];
  if (!entry) throw new Error(`No controller for selector ${JSON.stringify(selector)}. ${list.length} connected.`);
  const device = new HID.HID(entry.path);
  return { device, info: entry };
}

// Read raw 956 bytes for profile N (1..3).
export function readProfileRaw(device, profileNumber) {
  const cmd = buildReadCommand(profileNumber);
  device.sendFeatureReport([REPORT_ID_CMD, ...cmd]);
  const packets = [];
  for (let i = 0; i < PACKETS_PER_PROFILE; i++) {
    // node-hid returns the report data with the report id as the first byte.
    const resp = device.getFeatureReport(REPORT_ID_DATA, CMD_PAYLOAD_SIZE + 1);
    packets.push(resp);
  }
  return assembleProfile(packets);
}

// Switch the controller's active profile (1..3) — like pressing its profile button.
export function setActiveProfile(device, profileNumber) {
  device.sendFeatureReport([REPORT_ID_CMD, ...buildSetActiveCommand(profileNumber)]);
}

// Write raw 956 bytes to profile N (1..3). CRC handled by buildWritePackets.
export function writeProfileRaw(device, profileNumber, profileBytes) {
  if (profileBytes.length < PROFILE_SIZE) throw new Error(`profile must be ${PROFILE_SIZE} bytes`);
  const packets = buildWritePackets(profileNumber, profileBytes);
  for (const pkt of packets) device.sendFeatureReport([REPORT_ID_CMD, ...pkt]);
  // The device streams 0x61 status after a write; drain until byte 2 (remaining) is 0,
  // otherwise the next read command desyncs and returns empty data.
  for (let i = 0; i < 32; i++) {
    const resp = device.getFeatureReport(REPORT_ID_DATA, CMD_PAYLOAD_SIZE + 1);
    if (!resp || resp[2] === 0) break;
  }
}

export { HID };
