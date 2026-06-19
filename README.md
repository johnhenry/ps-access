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
- CLI: Node.js (tested on v26). `node-hid` is an **optional** dependency (installed
  automatically) needed only to talk to the controller; commands that don't touch the device
  (`presets`, `share`, `show-share`, `help`) and the web tool work even if it isn't built.
- Web tool: Chrome or Edge (desktop) for WebHID.
- macOS may prompt for **Input Monitoring** permission for the terminal/Chrome on first use.

## CLI

Install with `npm i -g ps-access`, or run any command without installing via `npx ps-access …`.

```bash
ps-access list                       # list connected controllers
ps-access dump                        # decode all 3 profiles
ps-access backup                      # save all 3 profiles to captures/
ps-access read-profile 1 --json       # decode one profile as JSON
ps-access set-active 2                 # switch the active profile (like the profile button)
ps-access set 1 button5=triangle port1=cross   # remap several at once (one write)
ps-access set 1 "port0=left stick" orientation="stick on the right"
ps-access write-profile 2 captures/backup-....json
ps-access restore captures/backup-....json
ps-access apply profile.json 1        # apply a web-app export / share code / URL / preset id to a slot
ps-access export 1 my-profile.json    # save a slot as a portable profile (import side: apply)
ps-access rename 1 "One-handed"       # rename a profile
ps-access copy 1 2                     # clone slot 1 -> 2 (across controllers: --from <id> --to <id>)
ps-access diff 1 my-profile.json      # compare a slot to a file (or slot-to-slot)
ps-access monitor                     # live terminal view of buttons + stick
```

`apply` is the bridge between the web tool and the CLI: feed it a **profile JSON exported from the
web Library**, a **share link/code**, or a built-in **preset id** (`ps-access presets`), and it
writes that mapping to a slot on the controller (reading the current profile first so uuid and
unmodeled fields survive, then round-trip verifying).

- `--device <serial|index|path>` targets a specific controller when several are connected
  (serial is the stable id — see `ps-access list`). With **multiple** controllers connected, a
  *write* without `--device` is refused (so you never edit the wrong one).
- `--all` runs reads/backups (and `set-active`/`apply`) on **every** connected controller.
- `--dry-run` previews a write (`set`/`apply`/`restore`/`write-profile`/`copy`/`rename`) as a diff.
- **Every write auto-backs-up first** to `captures/` and round-trip re-reads to verify.

## Web tool (multiple controllers)

Run it locally with the CLI — no install or separate web server needed:

```bash
npx ps-access serve          # or, after install:  ps-access serve   (optional: serve <port>)
```

Open **<http://localhost:3000/>** in Chrome/Edge. (`http://localhost` is a valid WebHID
secure context, so no HTTPS is required.) It's also hosted at <https://ps-access.johnhenry.me>.

### XMB view (`index.html`)

A full-screen XrossMediaBar-style interface: a horizontal ribbon of blades
(`Controllers · Profile 1 · 2 · 3 · Save · Library · Key Bridge · Monitor`, each profile rendered
as a live mini-controller), a vertical item list, and an enlarged "hero" render when you drill in.
Edit button/stick/port mappings with horizontal value spinners, then save to the controller.

The **Library** blade is for **sharing and presets** (all client-side, no account): apply a
curated starting-point preset (one-handed, toggle-triggers, external-switch D-pad…), **export**
a profile to a JSON file, **import** a file or a CLI backup, or **copy a share link** — a URL
whose `#p=…` hash encodes the profile, auto-detected when someone opens it. After applying or
importing, use **Save** to write it to the controller.

The **Key Bridge** blade is a visual editor for the PC input bridge: assign **any keyboard key
or chord** to each physical button and the stick by selecting a row, pressing Enter, then pressing
the key you want (press the physical button to find its row — it lights up live). Pick a stick
mode (keys / mouse / gamepad axis), then **Export** a `bridge.json` or **copy the run command**.
The browser can author and preview the mapping, but it can't inject input into other apps — you
run the exported config with the local bridge (`ps-access bridge --config bridge.json`), which is
what actually drives the PC. (Macros — multi-step sequences — are edited in the exported JSON.)

**Accessibility:** the configurator is built to be used by the same people the controller is for.
Every section/option/value change is announced to screen readers (a polite live region), it's
fully keyboard- and controller-operable, **?** opens a controls reference, and it honors
`prefers-reduced-motion` (no animated wave), `prefers-contrast`, and Windows High Contrast /
`forced-colors`. A high-visibility focus ring on the selected item is available as an **opt-in
toggle in Help (off by default**, so it doesn't fight the XMB look); OS high-contrast / forced-colors
modes turn it on automatically.

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
cursor (decoded from input-report `byte 39`; see [PROTOCOL.md](PROTOCOL.md)). You can also **switch
it from the app**: each Profile blade has a **Set active on controller** item (the active one is
marked `✓`), doing the same thing as the device's profile button — `set-active` on the CLI. The ambient
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

## PC input bridge (use the controller on any PC)

Beyond editing PS5 profiles, you can use the Access Controller as a **general PC input device** —
its stick and buttons driving keyboard/mouse or a virtual gamepad, so it controls *any* software,
not just a PS5. The bridge reads the controller's live USB input and maps it through a small,
platform-agnostic engine (`web/bridge-core.mjs`) to a pluggable output **sink**.

```bash
ps-access bridge --sink dry-run               # print mapped events, inject nothing (try it first)
ps-access bridge --sink xdotool               # stick -> arrow keys, buttons -> keys (X11; needs xdotool)
ps-access bridge --sink uinput                # virtual gamepad/keyboard via /dev/uinput (Linux)
ps-access bridge --config my-map.json         # custom mapping (see DEFAULT_MAPPING in bridge-core)
ps-access bridge --simulate frames.json --sink dry-run   # replay recorded frames, no hardware
```

- **xdotool** sink (X11): no native deps; set `--display :0` if `$DISPLAY` isn't set.
- **uinput** sink (Linux, lowest latency): a stdlib-only Python helper creates the virtual device.
  It needs access to `/dev/uinput` — run as root, or add a udev rule, e.g.:
  ```
  # /etc/udev/rules.d/99-uinput.rules
  KERNEL=="uinput", GROUP="input", MODE="0660"   # then: add your user to the `input` group
  ```
- Mapping config example (`my-map.json`):
  ```json
  { "buttons": {
      "8": "space",
      "0": "mouse1",
      "1": "ctrl+s",
      "2": ["ctrl+c", "ctrl+v"]
    },
    "stick": { "mode": "mouse" }, "mouse": { "speed": 22 } }
  ```
  `stick.mode` is `keys` (arrows/WASD), `mouse` (relative pointer), or `axis` (gamepad).
- A button value can be:
  - a single key — **held** while the button is held (`"space"`, `"a"`, `"mouse1"`);
  - a **chord** — `"ctrl+s"` — fired once on press (modifiers held around the key);
  - a **macro** — `["ctrl+c", "ctrl+v"]` or `["g", "i"]` — a sequence fired once on press.

  Chords and macros make a single accessible switch trigger a complex action that would
  otherwise need several simultaneous or sequential presses.

### Building a mapping

Author the config visually in the web **Key Bridge** blade, or from the terminal:

```bash
ps-access bridge edit                         # interactive press-to-bind editor (TTY)
ps-access bridge edit --config my-map.json --out my-map.json
ps-access bridge set 0=ctrl+s 8=space 2=ctrl+c,ctrl+v stick.mode=mouse --out my-map.json
ps-access bridge show --config my-map.json    # print the resolved config
```

- **edit** is the CLI twin of the web editor: ↑/↓ to select a button/stick row, **Enter** to
  bind (then press the key you want), **Del** to clear, **s** to save, **q** to quit.
- **set** targets: `0`..`9` (buttons), `stick.mode`, `stick.up/down/left/right`, `mouse.speed`;
  a comma-separated value (`2=ctrl+c,ctrl+v`) becomes a macro. These commands need no controller.

> Verified with simulated input on Linux; on-hardware verification is pending a physical unit.

## Layout

```
web/access-protocol.mjs   shared, I/O-free protocol (parse/build/CRC/enums) — used by both tools
web/profile-library.mjs   shared, I/O-free profile sharing + preset library (used by the web tool)
lib/hid-node.mjs          node-hid transport (Node CLI only)
web/bridge-core.mjs       PC bridge: pure input->output mapping engine
lib/bridge-sinks.mjs      PC bridge: output sinks (dry-run, xdotool, uinput)
lib/uinput-helper.py      PC bridge: stdlib-only virtual device for the uinput sink
cli.mjs                   the `ps-access` command (profiles; dispatches `bridge` subcommand)
bridge.mjs                PC input bridge — module run via `ps-access bridge`
web/index.html + xmb.js   XMB-style configurator (the web UI) + Library + live Monitor, via hid-web.mjs
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
