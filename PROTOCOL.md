# PlayStation Access Controller — profile protocol

Protocol for reading and writing the Access Controller's on-device profiles over **USB-C**, with
**no PS5**. Verified end-to-end against real hardware (read, write, round-trip, restore) on macOS
via both node-hid and WebHID.

Credit: this work builds on the prior art of Jacek Fedoryński's client-side web editor
(<https://www.jfedor.org/ps-access/>), which first made PC-side profile editing possible. The
byte offsets and behaviour documented here were confirmed against a live device, and this note
records where this implementation differs (it preserves the UUID/timestamp/stick-tuning bytes on
round-trip).

## Device identity

| | value |
|---|---|
| Vendor ID | `0x054C` (Sony Interactive Entertainment) |
| Product ID | `0x0E5F` |
| USB usage | Generic Desktop (`0x01`) / Game Pad (`0x05`) |
| Product string | `Access Controller` |

Note `0x0E5F` is absent from public USB-ID databases.

## Transport: feature reports

Two HID **feature reports** carry profile data, and are present **only over USB**:

- `0x60` (96) — host → device command/data channel
- `0x61` (97) — device → host data/status channel

Each `0x60` packet is **63 payload bytes** (after the report id). Each `0x61` response is the
full report with the **report id at byte 0**.

**USB vs Bluetooth detection:** over USB the feature-report set includes `0x60` and `0x61`
and does **not** include report `99` (`0x63`). Over Bluetooth, report `99` is present and the
profile channel is not usable. So: *USB-ready ⇔ has `0x60` & `0x61` and not `99`.*

A profile blob is **956 bytes** (`PROFILE_DATA_SIZE`). There are **3 profile slots** (1–3).

### Reading profile N (1–3)

1. Send feature report `0x60` with a 63-byte buffer where `buf[0] = 0x10 + (N-1)` (rest 0).
2. Read feature report `0x61` **18 times**. In each response, payload bytes are at **offset 4**
   (`[0]=0x61, [1]=cmd echo, [2]=remaining-count, [3]=?, [4..59]=56 payload bytes`).
3. Concatenate `18 × 56 = 1008` bytes and keep the first **956**. Byte 0 must be `0x02`.

### Writing profile N (1–3)

1. Build 18 packets. Packet `i` (0–17), 63 bytes:
   - `buf[0] = 0x08 + N`
   - `buf[1] = i`
   - `buf[2 + j] = profile[i*56 + j]` for `j` in 0..55 while `i*56+j < 956`
2. On the **final** packet (`i == 17`), write `crc32(profile, 956)` as **little-endian u32** at
   **offset 6** (the real profile data only occupies offsets 2–5 of the last packet, so there
   is no overlap).
3. Send all 18 packets via feature report `0x60`, in order.
4. **Drain status:** read feature report `0x61` until byte `[2]` (remaining-count) is `0`
   (cap the loop). Skipping this desyncs the next read command.

### CRC

Standard zlib/IEEE CRC-32 (poly `0xEDB88320`, init `0xFFFFFFFF`, final XOR `0xFFFFFFFF`),
computed over the **956 profile bytes** and stored little-endian. Implemented in
`lib/access-protocol.mjs` (`crc32`).

## Profile blob layout (956 bytes)

| offset | size | field |
|---|---|---|
| 0 | 1 | sentinel, always `0x02` |
| 4 | 2×40 | profile name, UTF-16LE, NUL-terminated, ≤40 chars |
| 84 | 16 | UUID (random; PS5/editor regenerate it each save) |
| 100 | 10×5 | button table — see below |
| 150 | 2 | toggle bitfield (u16 LE) — see below |
| 152 | 5×45 | expansion-port records — see below |
| 948 | 8 | timestamp, i64 LE (`Date.now()` ms) |

### Buttons (offset 100, 10 entries × 5 bytes)

Entry `b` (0–9) at `100 + b*5`:

- byte 0 — primary action (`map1`)
- byte 1 — secondary action (`map2`, for combos)
- bytes 2–4 — unused/observed 0

Action codes:

```
0 nothing   1 circle   2 cross   3 triangle  4 square
5 up        6 down     7 left    8 right
9 L1       10 R1      11 L2     12 R2       13 L3   14 R3
15 options 16 create  17 PS     18 touchpad
```

### Toggle bitfield (offset 150, u16 LE)

- bit `b` (0–9) → toggle enabled for button `b+1`
- bit `9 + p` → toggle enabled for expansion port `p` configured as a button
  (the built-in stick is port 0 and is normally a stick, so its bit is not used as a toggle)

### Expansion ports (offset 152, 5 entries × 45 bytes)

Port 0 = built-in stick; ports 1–4 = the four 3.5mm expansion ports. Entry `p` at
`152 + p*45`, byte 0 = **type**:

- `0x00` — disabled / nothing
- `0x01` — **stick**
  - byte 1: stick assignment (`1` = left stick, `2` = right stick)
  - byte 2: orientation (`0` below, `1` right, `2` above, `3` left) — only the built-in
    stick is affected, but every stick port carries the same value
  - byte 5: sensitivity; bytes 8–13: deadzone/curve (3 pairs, X/Y).
    **`0` means "firmware default"** — observed on a live, never-PS5-tuned device, all these
    bytes are `0`. The PS5 only writes non-zero when you change them from default; jfedor's
    editor writes `sensitivity=3` and deadzone `80 80 c4 c4 e1 e1` as its "default" preset.
    The exact value→behaviour mapping is **not publicly documented** (set them experimentally).
- `0x02` — **analog** button; `0x03` — **digital** button
  - byte 2: primary action (`map1`); byte 3: secondary action (`map2`)

A port’s stick assignment is encoded in the UI as `100 + code` (101 = left stick,
102 = right stick) to share one dropdown with the button actions.

## Input report — live button & stick state (report id `0x01`)

The controller streams a DualSense-style **input report** (report id `1`, ~250 Hz, 64 bytes
incl. report id / 63 bytes of data). Sticks are near the front, motion sensors + a timestamp
fill the tail (those bytes are volatile at idle). Reverse-engineered with `web/hid-capture.html`
(connect → idle baseline → press one button at a time, watch which bits flip).

**Key finding:** the report exposes **raw physical button state — independent of the profile
remapping.** Pressing a button lights a fixed physical bit even when that button is mapped to
*Not assigned*. (The standard DualSense face/shoulder bits near bytes 7–8 instead carry the
*mapped action*, so two buttons mapped to the same action are indistinguishable there.)

Byte offsets below are in **`event.data` coordinates** (WebHID `inputreport`, which **excludes**
the report id). For `node-hid`, whose buffer includes the id at `[0]`, add 1.

| data byte | bits | meaning |
|---|---|---|
| 0–1 | — | left stick X / Y (≈`0x80` centered; byte 0 jitters) |
| ~7–8 | — | standard mapped-action bits (reflect the *mapped* action, not the physical button) |
| **15** | **0–7** | **the 8 perimeter buttons** — one bit each (physical) |
| **16** | **0, 1, 3** | **center button** (bit 0), **stick-click** (bit 1), **profile-switch button** (bit 3, `0x08`) |
| **39** | — | **active on-device profile** — `1`, `2`, or `3` (which profile the controller has selected) |

Pinned via an ordered capture: **perimeter button _n_ (1–8) → `byte 15` bit _(n−1)_**
(bit 0 = button 1 … bit 7 = button 8); **`byte 16` bit 0 = center button**; **`byte 16` bit 1 =
stick-click**. So all 10 physical inputs are readable directly from `byte 15` (bits 0–7) and
`byte 16` (bits 0–1).

**Active profile.** `byte 39` holds the profile the controller currently has active (`1`–`3`),
and `byte 16` bit 3 (`0x08`) pulses while the on-device **profile-switch button** is held. This
lets a PC-side tool show, and react to, which profile the user has selected on the controller —
without a PS5. Found by capturing the report while cycling the profile button: `byte 39` stepped
`3 → 1 → 2 → 3` in lockstep with each press, while all other low-cardinality bytes stayed put.

This enables physical-button features regardless of mapping — e.g. navigating a UI with the
controller (perimeter = back, center/stick-click = confirm) and lighting only the button
actually pressed. Note: WebHID `inputreport` and the browser **Gamepad API** can't both read the
device reliably at once, and the Gamepad API only sees mapped actions — so physical-button work
must go through the raw input report.

## Implementation notes

- `buildProfile()` starts from the previously-read raw bytes when available, so fields this
  tool doesn’t model (UUID, stick sensitivity/deadzone) survive a round trip. jfedor’s editor
  instead rebuilds from scratch, randomizing the UUID and resetting stick tuning to defaults.
- A naive read **immediately after** a write returns zeros — always drain `0x61` first.
- `node-hid` `getFeatureReport(id, len)` and WebHID `receiveFeatureReport(id)` both return the
  report id at byte 0, so the payload offset (4 on read) is identical across platforms.
