import crc32 from './crc.js';

const PAYLOAD_SIZE = 63;
const PROFILE_DATA_SIZE = 956;

let device = null;

document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("open_device").addEventListener("click", open_device);
    document.getElementById("load_from_device").addEventListener("click", load_from_device);
    document.getElementById("save_to_device").addEventListener("click", save_to_device);

    device_buttons_set_disabled_state(true);

    for (let profile_number = 1; profile_number <= 3; profile_number++) {
        for (let port_number = 0; port_number <= 4; port_number++) {
            document.getElementById(`p${profile_number}_e${port_number}_mapping1_dropdown`).addEventListener("change", () => {
                port_options_set_visibility(profile_number, port_number);
            });
            port_options_set_visibility(profile_number, port_number);
        }
    }

    if ("hid" in navigator) {
        navigator.hid.addEventListener('disconnect', hid_on_disconnect);
    } else {
        display_error("Your browser doesn't support WebHID. Try Chrome (desktop version) or a Chrome-based browser.");
    }
});

async function open_device() {
    clear_error();
    let success = false;
    const devices = await navigator.hid.requestDevice({
        filters: [{ vendorId: 0x054c, productId: 0x0e5f }]
    }).catch((err) => { display_error(err); });
    if (devices !== undefined && devices.length > 0) {
        device = devices[0];
        console.log(device);
        if (!device.opened) {
            await device.open().catch((err) => { display_error(err + "\nIf you're on Linux, you might need to give yourself permissions to the appropriate /dev/hidraw* device."); });
        }
        success = device.opened;
        if (success && device.collections[0].featureReports.some(x => x.reportId == 99)) {
            display_error("Please connect your Access controller with a USB cable.");
            success = false;
        }
    }

    device_buttons_set_disabled_state(!success);

    if (!success) {
        device = null;
    }
}

async function load_from_device() {
    if (device == null) {
        return;
    }
    clear_error();

    try {
        for (let profile_number = 1; profile_number <= 3; profile_number++) {
            let buffer = new ArrayBuffer(PAYLOAD_SIZE);
            let dataview = new DataView(buffer);
            dataview.setUint8(0, 0x10 + profile_number - 1);
            await device.sendFeatureReport(0x60, buffer);

            let profile_data = new ArrayBuffer(PROFILE_DATA_SIZE);
            let profile_data_view = new DataView(profile_data);
            for (let i = 0; i < 18; i++) {
                let data_with_report_id = await device.receiveFeatureReport(0x61);
                for (let j = 0; j < 56; j++) {
                    if (i * 56 + j < PROFILE_DATA_SIZE) {
                        profile_data_view.setUint8(i * 56 + j, data_with_report_id.getUint8(4 + j));
                    }
                }
            }
            // console.log(profile_data_view);
            console.log("Profile", profile_number);
            dump_hex(profile_data);
            set_ui_state_from_profile_data(profile_number, profile_data_view);
        }
    } catch (e) {
        display_error(e);
    }
}

async function save_to_device() {
    if (device == null) {
        return;
    }
    clear_error();

    try {
        for (let profile_number = 1; profile_number <= 3; profile_number++) {
            let profile_data = make_profile_data_from_ui_state(profile_number);
            for (let i = 0; i < 18; i++) {
                let buffer = new ArrayBuffer(PAYLOAD_SIZE);
                let dataview = new DataView(buffer);
                dataview.setUint8(0, 0x08 + profile_number);
                dataview.setUint8(1, i);
                for (let j = 0; j < 56; j++) {
                    if (i * 56 + j < PROFILE_DATA_SIZE) {
                        dataview.setUint8(2 + j, profile_data.getUint8(i * 56 + j));
                    }
                }
                if (i == 17) {
                    // add crc to last packet
                    dataview.setUint32(6, crc32(profile_data, PROFILE_DATA_SIZE), true);
                }
                // console.log(dataview);
                await device.sendFeatureReport(0x60, buffer);
            }
            // At this point i think we're supposed to read 0x61 until byte 2 is zero.
            // But i don't think it does anything other than it tells us that the controller
            // has finished storing the configuration or something.
            // console.log(await device.receiveFeatureReport(0x61));
        }
    } catch (e) {
        display_error(e);
    }
}

function set_ui_state_from_profile_data(profile_number, data) {
    if (data.getUint8(0) != 2) {
        throw new Error("expected byte 0 to be 0x02");
    }

    let toggle = {};
    for (let i = 0; i < 16; i++) {
        toggle[i] = (data.getUint8(150 + Math.floor(i / 8)) & (1 << (i % 8))) != 0;
    }

    for (let button_number = 1; button_number <= 10; button_number++) {
        let button_data = new DataView(data.buffer.slice(100 + (button_number - 1) * 5, 100 + button_number * 5));
        document.getElementById(`p${profile_number}_b${button_number}_mapping1_dropdown`).value = button_data.getUint8(0);
        document.getElementById(`p${profile_number}_b${button_number}_mapping2_dropdown`).value = button_data.getUint8(1);
        document.getElementById(`p${profile_number}_b${button_number}_toggle_checkbox`).checked = toggle[button_number - 1];
    }

    for (let port_number = 0; port_number < 5; port_number++) {
        let port_data = new DataView(data.buffer.slice(152 + port_number * 45, 152 + (port_number + 1) * 45));
        switch (port_data.getInt8(0)) {
            case 0x00:
                document.getElementById(`p${profile_number}_e${port_number}_mapping1_dropdown`).value = 0;
                break;
            case 0x01:
                document.getElementById(`p${profile_number}_e${port_number}_mapping1_dropdown`).value = 100 + port_data.getUint8(1);
                if (port_number == 0) {
                    document.getElementById(`p${profile_number}_orientation_dropdown`).value = port_data.getUint8(2);
                }
                break;
            case 0x02:
            case 0x03:
                document.getElementById(`p${profile_number}_e${port_number}_mapping1_dropdown`).value = port_data.getUint8(2);
                document.getElementById(`p${profile_number}_e${port_number}_mapping2_dropdown`).value = port_data.getUint8(3);
                document.getElementById(`p${profile_number}_e${port_number}_toggle_checkbox`).checked = toggle[9 + port_number];
                document.getElementById(`p${profile_number}_e${port_number}_analog_checkbox`).checked = (port_data.getInt8(0) == 0x02);
                break;
            default:
                throw new Error("unexpected byte 0 in expansion port data");
        }
        port_options_set_visibility(profile_number, port_number);
    }
}

function make_profile_data_from_ui_state(profile_number) {
    let data_array_buffer = new ArrayBuffer(PROFILE_DATA_SIZE);
    let data = new DataView(data_array_buffer);
    data.setUint8(0, 0x02);
    const profile_name = `Profile ${profile_number}`;
    for (let i = 0; (i < profile_name.length) && (i < 40); i++) {
        data.setUint16(4 + 2 * i, profile_name.charCodeAt(i), true);
    }
    // we set new random uuid every time, ignoring variants/versions
    for (let i = 0; i < 16; i++) {
        data.setUint8(84 + i, Math.floor(Math.random() * 256));
    }
    let toggle = 0;
    // buttons
    for (let button_number = 1; button_number <= 10; button_number++) {
        const mapping1 = document.getElementById(`p${profile_number}_b${button_number}_mapping1_dropdown`).value;
        const mapping2 = document.getElementById(`p${profile_number}_b${button_number}_mapping2_dropdown`).value;
        if (document.getElementById(`p${profile_number}_b${button_number}_toggle_checkbox`).checked) {
            toggle |= 1 << (button_number - 1);
        }
        data.setUint8(100 + (5 * (button_number - 1)), mapping1);
        data.setUint8(100 + (5 * (button_number - 1)) + 1, mapping2);
    }
    //  stick/expansion ports
    for (let port_number = 0; port_number <= 4; port_number++) {
        const mapping1 = document.getElementById(`p${profile_number}_e${port_number}_mapping1_dropdown`).value;
        if (mapping1 > 100) { // stick
            data.setUint8(152 + port_number * 45, 0x01);
            data.setUint8(152 + port_number * 45 + 1, mapping1 - 100);
            // all ports get the same orientation, even though it only affects the built-in stick
            const orientation = document.getElementById(`p${profile_number}_orientation_dropdown`).value;
            data.setUint8(152 + port_number * 45 + 2, orientation);
            // only default sensitivity and deadzone for now
            data.setUint8(152 + port_number * 45 + 5, 3);
            data.setUint8(152 + port_number * 45 + 8, 0x80);
            data.setUint8(152 + port_number * 45 + 9, 0x80);
            data.setUint8(152 + port_number * 45 + 10, 0xc4);
            data.setUint8(152 + port_number * 45 + 11, 0xc4);
            data.setUint8(152 + port_number * 45 + 12, 0xe1);
            data.setUint8(152 + port_number * 45 + 13, 0xe1);
        }
        if ((mapping1 > 0) && (mapping1 < 100)) { // button
            const button_type = document.getElementById(`p${profile_number}_e${port_number}_analog_checkbox`).checked ? 0x02 : 0x03;
            data.setUint8(152 + port_number * 45, button_type);
            data.setUint8(152 + port_number * 45 + 2, mapping1);
            const mapping2 = document.getElementById(`p${profile_number}_e${port_number}_mapping2_dropdown`).value;
            data.setUint8(152 + port_number * 45 + 3, mapping2);
            if (document.getElementById(`p${profile_number}_e${port_number}_toggle_checkbox`).checked) {
                toggle |= 1 << (9 + port_number);
            }
        }
    }
    data.setUint16(150, toggle, true);
    // timestamp
    data.setBigInt64(948, BigInt(Date.now()), true);
    // console.log(data);
    return data;
}

function clear_error() {
    document.getElementById("error").classList.add("d-none");
}

function display_error(message) {
    document.getElementById("error").innerText = message;
    document.getElementById("error").classList.remove("d-none");
}

function dump_hex(data) {
    console.log([...new Uint8Array(data)].map(x => x.toString(16).padStart(2, '0')).join(' '));
}

function hid_on_disconnect(event) {
    if (event.device === device) {
        device = null;
        device_buttons_set_disabled_state(true);
    }
}

function device_buttons_set_disabled_state(state) {
    document.getElementById("load_from_device").disabled = state;
    document.getElementById("save_to_device").disabled = state;
}

function port_options_set_visibility(profile_number, port_number) {
    const value = document.getElementById(`p${profile_number}_e${port_number}_mapping1_dropdown`).value;

    for (const container_element of document.querySelectorAll(`.p${profile_number}_e${port_number}_button_setting`)) {
        if ((value > 0) && (value < 100)) {
            container_element.classList.remove('d-none');
        } else {
            container_element.classList.add('d-none');
        }
    }
}