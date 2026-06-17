// WebHID transport for the Access Controller, mirroring lib/hid-node.mjs.
import {
  VENDOR_ID, PRODUCT_ID, REPORT_ID_CMD, REPORT_ID_DATA, BT_ONLY_REPORT_ID,
  PROFILE_SIZE, PACKETS_PER_PROFILE, buildReadCommand, assembleProfile, buildWritePackets,
} from "./access-protocol.mjs";

export function hidSupported() {
  return "hid" in navigator;
}

// Already-granted Access Controllers.
export async function grantedControllers() {
  const devices = await navigator.hid.getDevices();
  return devices.filter((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
}

// Prompt the user to grant access to one or more controllers.
export async function requestControllers() {
  const devices = await navigator.hid.requestDevice({
    filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
  });
  return devices.filter((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
}

export async function ensureOpen(device) {
  if (!device.opened) await device.open();
  const ids = device.collections?.[0]?.featureReports?.map((r) => r.reportId) ?? [];
  // The profile channel (0x60/0x61) is only exposed over USB. Report 99 marks the
  // Bluetooth collection, where profile read/write isn't available.
  const usbReady = ids.includes(REPORT_ID_CMD) && ids.includes(REPORT_ID_DATA) && !ids.includes(BT_ONLY_REPORT_ID);
  if (!usbReady) throw new Error("Connect the Access controller with a USB-C cable — profiles can't be read/written over Bluetooth.");
  return device;
}

function dvToU8(dv) {
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}

export async function readProfileRaw(device, profileNumber) {
  const cmd = buildReadCommand(profileNumber);
  await device.sendFeatureReport(REPORT_ID_CMD, cmd);
  const packets = [];
  for (let i = 0; i < PACKETS_PER_PROFILE; i++) {
    const dv = await device.receiveFeatureReport(REPORT_ID_DATA);
    packets.push(dvToU8(dv));
  }
  return assembleProfile(packets);
}

export async function writeProfileRaw(device, profileNumber, profileBytes) {
  if (profileBytes.length < PROFILE_SIZE) throw new Error(`profile must be ${PROFILE_SIZE} bytes`);
  const packets = buildWritePackets(profileNumber, profileBytes);
  for (const pkt of packets) await device.sendFeatureReport(REPORT_ID_CMD, pkt);
  // Drain post-write status until "remaining" byte (offset 2) is zero.
  for (let i = 0; i < 32; i++) {
    const dv = await device.receiveFeatureReport(REPORT_ID_DATA);
    if (dvToU8(dv)[2] === 0) break;
  }
}
