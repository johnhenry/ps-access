#!/usr/bin/env python3
"""Virtual input device for the ps-access PC bridge — Linux /dev/uinput, stdlib only.

Reads one JSON event per line on stdin (from lib/bridge-sinks.mjs UinputSink):
    {"type":"key","code":"space","action":"down"}
    {"type":"axis","code":"x","value":-1.0}
and injects them as a virtual keyboard or gamepad via /dev/uinput.

No third-party packages: just ctypes/struct/fcntl/os. Needs write access to
/dev/uinput (run as root, or add a udev rule granting your user the `input` group).

Usage:
    uinput-helper.py keyboard      # virtual keyboard (xdotool-style keysyms)
    uinput-helper.py gamepad       # virtual gamepad (BTN_* + ABS_X/Y)
    uinput-helper.py keyboard --selftest   # print planned device setup, don't open uinput
"""
import sys, os, json, struct, fcntl, time

# ---- linux/uinput.h + input-event-codes.h constants ----
EV_SYN, EV_KEY, EV_ABS = 0x00, 0x01, 0x03
SYN_REPORT = 0
ABS_X, ABS_Y = 0x00, 0x01
BUS_USB = 0x03

def _IOC(d, t, nr, size): return (d << 30) | (size << 16) | (t << 8) | nr
_IOW = lambda t, nr, size: _IOC(1, t, nr, size)
_IO = lambda t, nr: _IOC(0, t, nr, 0)
UI_SET_EVBIT = _IOW(ord('U'), 100, 4)
UI_SET_KEYBIT = _IOW(ord('U'), 101, 4)
UI_SET_ABSBIT = _IOW(ord('U'), 103, 4)
UI_DEV_CREATE = _IO(ord('U'), 1)
UI_DEV_DESTROY = _IO(ord('U'), 2)

# A practical subset of KEY_* codes, keyed by the xdotool-style keysyms the bridge emits.
KEY = {
    "space": 57, "Return": 28, "Escape": 1, "BackSpace": 14, "Tab": 15,
    "shift": 42, "ctrl": 29, "alt": 56,
    "Up": 103, "Down": 108, "Left": 105, "Right": 106,
    "a": 30, "b": 48, "c": 46, "d": 32, "e": 18, "f": 33, "g": 34, "h": 35,
    "i": 23, "j": 36, "k": 37, "l": 38, "m": 50, "n": 49, "o": 24, "p": 25,
    "q": 16, "r": 19, "s": 31, "t": 20, "u": 22, "v": 47, "w": 17, "x": 45,
    "y": 21, "z": 44,
    "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
}
# Gamepad buttons (BTN_*), keyed by friendly names a gamepad mapping would use.
BTN = {
    "BTN_SOUTH": 0x130, "BTN_EAST": 0x131, "BTN_NORTH": 0x133, "BTN_WEST": 0x134,
    "BTN_TL": 0x136, "BTN_TR": 0x137, "BTN_SELECT": 0x13a, "BTN_START": 0x13b,
    "BTN_THUMBL": 0x13d, "BTN_THUMBR": 0x13e,
    # friendly aliases
    "cross": 0x130, "circle": 0x131, "triangle": 0x133, "square": 0x134,
    "l1": 0x136, "r1": 0x137, "select": 0x13a, "start": 0x13b,
}
ABS_RANGE = (-32767, 32767)


def codes_for(kind):
    return KEY if kind == "keyboard" else {**BTN, **KEY}


def build(kind, selftest=False):
    table = codes_for(kind)
    keycodes = sorted(set(table.values()))
    name = f"ps-access {kind}".encode()[:79]
    if selftest:
        print(f"[selftest] device='{name.decode()}' kind={kind} "
              f"keys={len(keycodes)} abs={'X,Y' if kind=='gamepad' else 'none'}")
        return None
    try:
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    except (PermissionError, FileNotFoundError) as ex:
        print(f"uinput: cannot open /dev/uinput ({ex}). Run as root, or grant access with a "
              f"udev rule (add your user to a group that owns /dev/uinput).", file=sys.stderr)
        sys.exit(13)
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_SYN)
    for code in keycodes:
        fcntl.ioctl(fd, UI_SET_KEYBIT, code)
    absmin = [0] * 64
    absmax = [0] * 64
    if kind == "gamepad":
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_ABS)
        for ax in (ABS_X, ABS_Y):
            fcntl.ioctl(fd, UI_SET_ABSBIT, ax)
            absmin[ax], absmax[ax] = ABS_RANGE
    # struct uinput_user_dev: char name[80]; input_id(4*u16); u32 ff; s32 absmax/min/fuzz/flat[64]
    dev = struct.pack("80sHHHHi", name, BUS_USB, 0x054c, 0x0e5f, 1, 0)
    dev += struct.pack("64i", *absmax) + struct.pack("64i", *absmin)
    dev += struct.pack("64i", *([0] * 64)) + struct.pack("64i", *([0] * 64))
    os.write(fd, dev)
    fcntl.ioctl(fd, UI_DEV_CREATE)
    time.sleep(0.2)  # give udev a moment to create the node
    return fd


def emit(fd, etype, code, value):
    # struct input_event: timeval(2*long) + u16 type + u16 code + s32 value
    os.write(fd, struct.pack("llHHi", 0, 0, etype, code, value))


def syn(fd):
    emit(fd, EV_SYN, SYN_REPORT, 0)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    kind = args[0] if args else "keyboard"
    selftest = "--selftest" in sys.argv
    if kind not in ("keyboard", "gamepad"):
        print(f"unknown kind '{kind}' (keyboard|gamepad)", file=sys.stderr); sys.exit(2)
    fd = build(kind, selftest)
    if selftest:
        return
    table = codes_for(kind)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") == "key":
                code = table.get(e.get("code"))
                if code is not None:
                    emit(fd, EV_KEY, code, 1 if e.get("action") == "down" else 0)
                    syn(fd)
            elif e.get("type") == "axis" and kind == "gamepad":
                ax = ABS_X if e.get("code") == "x" else ABS_Y
                val = int(max(-1.0, min(1.0, float(e.get("value", 0)))) * ABS_RANGE[1])
                emit(fd, EV_ABS, ax, val)
                syn(fd)
    finally:
        try:
            fcntl.ioctl(fd, UI_DEV_DESTROY)
            os.close(fd)
        except Exception:
            pass


if __name__ == "__main__":
    main()
