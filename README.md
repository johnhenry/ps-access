# ps-access

Read and write **PlayStation Access Controller** profiles from a PC over **USB-C — no PS5
required**. Includes a command-line tool and a multi-controller browser (WebHID) configurator,
plus a documented protocol.

The Access Controller normally can only be customized by plugging it into a PS5. This project
talks the same on-device profile protocol directly, so you can read, edit, back up, restore,
and clone the 3 on-device profiles (button remapping, the built-in stick, expansion ports)
yourself.

> Verified end-to-end against real hardware (read / write / round-trip / restore) on macOS.
> See [PROTOCOL.md](PROTOCOL.md) for the protocol. This project builds on the prior art of
> Jacek Fedoryński’s web editor (<https://www.jfedor.org/ps-access/>) — credit and thanks to him
> for first making PC-side profile editing possible.

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

Open **<http://localhost:3000/web/>** in Chrome/Edge.

### XMB view (`index.html`)

A full-screen XrossMediaBar-style interface: a horizontal ribbon of blades
(`Controllers · Profile 1 · 2 · 3 · Save · Monitor`, each profile rendered as a live
mini-controller), a vertical item list, and an enlarged "hero" render when you drill in. Edit
button/stick/port mappings with horizontal value spinners, then save to the controller.

It's driven by the controller's **raw HID input report**, so it reads *physical* buttons
regardless of remapping: tilt the **stick** to navigate, **center / stick-click = confirm**,
**any perimeter button = back**, and pressing any physical button lights it up on every render.
Keyboard works too (arrows / Enter / Backspace).

Unplugging and replugging the controller **reconnects automatically** (no refresh). The
**Controllers** blade also has a persistent **＋ Connect a controller…** action (activate it with
Enter or a click) to grant or reconnect a controller on demand.

Under the controller name in the top bar, the **active on-device profile** is shown live (e.g.
`Profile 3 · stick on the right`) — it reflects whichever profile is selected on the controller
itself and **updates the moment you press the device's profile button**, independent of the UI
cursor (decoded from input-report `byte 39`; see [PROTOCOL.md](PROTOCOL.md)). The ambient
background wave echoes it too: its three curves fade their leading lines as the active profile
climbs (1 → all solid, 2 → first faded, 3 → first two faded), and fade out entirely when no
controller is connected.

The **Monitor** blade opens a full-screen live input view (big controller render + physical-button
chips + stick crosshair + the raw input report with the physical-button bytes highlighted). Because
the controller is purely *observed* here — navigation is suspended so every button and the stick can
be tested freely — opening it first shows a **confirm gate** warning that you'll need the **keyboard
(Esc)** or the **Done** button to leave (the controller can't exit on its own). The render follows
the **active on-device profile**, matching its **orientation**, and re-renders if you switch
profiles on the controller while watching. (Also available as a standalone page, `monitor.html`.)

### Diagnostics (`hid-capture.html`)

A developer tool that shows the live input report and logs which bits flip on each press —
used to reverse-engineer the physical-button layout (see PROTOCOL.md).

## Layout

```
web/access-protocol.mjs   shared, I/O-free protocol (parse/build/CRC/enums) — used by both tools
lib/hid-node.mjs          node-hid transport (Node CLI only)
cli.mjs                   command-line tool
web/index.html + xmb.js   XMB-style configurator (the web UI) + live Monitor blade, via hid-web.mjs
web/controller-render.mjs shared controller SVG render + physical-input decode
web/monitor.html + monitor.js  standalone XMB-styled live input monitor
web/hid-capture.html      input-report diagnostics / RE tool
captures/                 profile backups (created on backup/auto-backup)
reference/                Jacek Fedoryński’s original web editor — third-party, see reference/NOTICE.md
PROTOCOL.md               protocol documentation
```

## Safety

Profiles live in 3 on-device slots and are fully recoverable: take a `backup` first, and note
that writes auto-back-up. Connecting the controller to a PS5 will overwrite these profiles with
the console’s copies.
