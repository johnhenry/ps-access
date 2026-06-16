# ps-access

Read and write **PlayStation Access Controller** profiles from a PC over **USB-C — no PS5
required**. Includes a command-line tool and a multi-controller browser (WebHID) configurator,
plus a documented protocol.

The Access Controller normally can only be customized by plugging it into a PS5. This project
talks the same on-device profile protocol directly, so you can read, edit, back up, restore,
and clone the 3 on-device profiles (button remapping, the built-in stick, expansion ports)
yourself.

> Verified end-to-end against real hardware (read / write / round-trip / restore) on macOS.
> See [PROTOCOL.md](PROTOCOL.md) for the protocol. Credit to jfedor’s web editor
> (<https://www.jfedor.org/ps-access/>), from which the protocol was recovered.

## Requirements

- The controller connected by **USB-C** (the profile channel isn’t available over Bluetooth).
- CLI: Node.js (tested on v26) with `node-hid` (`npm install`).
- Web tool: Chrome or Edge (desktop) for WebHID.
- macOS may prompt for **Input Monitoring** permission for the terminal/Chrome on first use.

## CLI

```bash
npm install

node cli.mjs list                       # list connected controllers
node cli.mjs dump                        # decode all 3 profiles
node cli.mjs backup                      # save all 3 profiles to captures/
node cli.mjs read-profile 1 --json       # decode one profile as JSON
node cli.mjs set 1 button5=triangle      # remap button 5
node cli.mjs set 1 port1=cross           # expansion port 1 -> cross
node cli.mjs set 1 "port0=left stick"    # built-in stick assignment
node cli.mjs set 1 orientation="stick on the right"
node cli.mjs write-profile 2 captures/backup-....json
node cli.mjs restore captures/backup-....json
```

- `--device <index|path>` targets a specific controller when several are connected.
- **Every write auto-backs-up first** to `captures/` and round-trip re-reads to verify.

## Web tool (multiple controllers)

```bash
npm start            # serves the project at http://localhost:3000
```

Open **<http://localhost:3000/web/>** in Chrome/Edge. Click **Add controller**, pick your
Access Controller(s), and edit. You can switch between connected controllers, rename them,
load/save each profile, and **copy a profile to another controller** or **apply to all**.

### Two views

- **Form** — the dropdown editor for every button, the built-in stick, and the 4 expansion
  ports, including an **Advanced stick tuning** panel (sensitivity / deadzone). Value meanings
  aren't officially documented (`0` = firmware default); a **PS5 default preset** is provided.
- **Controller** — an SVG of the Access Controller showing each input's current mapping. The
  whole layout **rotates to match the stick orientation** (below/right/above/left), with B10
  shown beside the stick and the expansion ports opposite it.
  Click any element to edit it in a popover. Toggle **▶ Live input** to release the device to
  the browser Gamepad API and **simulate the real controller**: press a physical button and
  the action it's mapped to lights up; move the stick and the on-screen stick follows. Load or
  Save re-acquires the device for HID access.

> Note: WebHID and the Gamepad API can't read the same device at once, so live input runs only
> while the device is released (the **Live input** toggle handles this). Chrome also needs one
> physical button press before it exposes a gamepad.

## Layout

```
lib/access-protocol.mjs   shared, I/O-free protocol (parse/build/CRC/enums) — used by both tools
lib/hid-node.mjs          node-hid transport
cli.mjs                   command-line tool
web/                      WebHID configurator (index.html, app.js, hid-web.mjs)
captures/                 profile backups (created on backup/auto-backup)
reference/                upstream code.js / crc.js / index.html (source of the protocol)
PROTOCOL.md               protocol documentation
```

## Safety

Profiles live in 3 on-device slots and are fully recoverable: take a `backup` first, and note
that writes auto-back-up. Connecting the controller to a PS5 will overwrite these profiles with
the console’s copies.
