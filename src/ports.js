'use strict';

const { vscode, path, fs, cp,
        IS_WIN, IS_MAC, IS_LINUX,
        cfg, setCfg, getPortCache, setPortCache,
        checkBusy,
        PORT_NAME_REGEX,
} = require('./helpers');

async function detectPorts() {
    const now = Date.now();
    const pc = getPortCache();
    if (now - pc.timestamp < 3000) return pc.data;

    let ports = [];
    if (IS_WIN)        ports = await detectPortsWindows();
    else if (IS_LINUX) ports = await detectPortsLinux();
    else if (IS_MAC)   ports = await detectPortsMac();

    setPortCache({ data: ports, timestamp: now });
    return ports;
}

function detectPortsWindows() {
    return new Promise(resolve => {
        const cmd = 'powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_PnPEntity | Where-Object {$_.Name -match \'COM[0-9]+\'} | Select-Object -ExpandProperty Name"';
        cp.exec(cmd, { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
            if (err || !stdout?.trim()) { resolve([]); return; }
            const ports = [];
            for (const line of stdout.split('\n').map(l => l.trim()).filter(Boolean)) {
                const m = line.match(/COM(\d+)/);
                if (m) ports.push({ name: `COM${m[1]}`, desc: line.replace(`(COM${m[1]})`, '').trim() });
            }
            ports.sort((a, b) => parseInt(a.name.slice(3)) - parseInt(b.name.slice(3)));
            resolve(ports);
        });
    });
}

function detectPortsLinux() {
    return new Promise(resolve => {
        const ports = [];
        const seen  = new Set();

        const byId = '/dev/serial/by-id';
        if (fs.existsSync(byId)) {
            try {
                for (const link of fs.readdirSync(byId)) {
                    try {
                        const real = fs.realpathSync(path.join(byId, link));
                        if (!seen.has(real)) {
                            seen.add(real);
                            const desc = link.replace(/^usb-/, '').replace(/_if\d+$/, '').replace(/_/g, ' ');
                            ports.push({ name: real, desc });
                        }
                    } catch { /* broken symlink */ }
                }
            } catch { /* no permission */ }
        }

        try {
            for (const f of fs.readdirSync('/dev')) {
                if (!/^(ttyUSB\d+|ttyACM\d+|ttyS\d+|ttyAMA\d+|ttyCH341\d+)$/.test(f)) continue;
                const full = `/dev/${f}`;
                if (!seen.has(full)) { seen.add(full); ports.push({ name: full, desc: 'Serial' }); }
            }
        } catch { /* no permission */ }

        ports.sort((a, b) => a.name.localeCompare(b.name));
        resolve(ports);
    });
}

function detectPortsMac() {
    return new Promise(resolve => {
        try {
            const devs = fs.readdirSync('/dev').filter(f =>
                /^cu\.(usb|wch|SLAB|usbmodem|usbserial|wchusbserial|SLAB_USBtoUART|BLTH|iAP)/.test(f)
            );
            resolve(devs.map(d => ({ name: `/dev/${d}`, desc: 'Serial' })));
        } catch { resolve([]); }
    });
}

async function cmdSelectPort() {
    if (checkBusy()) return;
    // Flash parameters (baud/mode/freq/size/compression) are configured via menuconfig
    // since v1.85.4 — no manual/menuconfig mode distinction in the port picker.

    const ports = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'ESP: Searching for ports...' },
        () => detectPorts()
    );
    const currentPort = cfg('comPort');
    const items = [
        ...ports.map(p => ({
            label: p.name,
            description: p.name === currentPort
                ? (p.desc ? `${p.desc} — last used` : 'last used')
                : p.desc || ''
        })).sort((a, b) => {
            if (a.label === currentPort) return -1;
            if (b.label === currentPort) return 1;
            return 0;
        }),
        { label: '$(edit) Enter manually...', description: '' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
        title: 'ESP8266-IDF Tools › Select Port',
        placeHolder: IS_WIN ? 'COM3, COM4...' : '/dev/ttyUSB0, /dev/ttyACM0...',
    });
    if (!picked) return null;

    let port;
    if (picked.label.includes('Enter manually')) {
        port = await vscode.window.showInputBox({
            prompt: 'Enter port manually',
            placeHolder: IS_WIN ? 'COM3' : '/dev/ttyUSB0',
            value: cfg('comPort') || '',
            validateInput: text => {
                if (!text) return 'Port cannot be empty';
                if (!PORT_NAME_REGEX.test(text)) return 'Invalid characters in port name';
                return null;
            }
        });
    } else {
        port = picked.label;
    }
    if (!port) return null;
    await setCfg('comPort', port);
    vscode.window.showInformationMessage(`ESP: Port → ${port}`);
    return port;
}

// ─── PORT AVAILABILITY CHECK ──────────────────────────────────────────────────
function isPortAvailable(port) {
    return new Promise(resolve => {
        if (IS_WIN) {
            // #FIX(1.85.5): Use cp.execFile (no shell) instead of cp.exec with string interpolation.
            // Even though `port` is validated by PORT_NAME_REGEX upstream, defense-in-depth —
            // execFile passes the port as a single argv element, so shell metacharacters
            // (if a future regex change ever lets one through) cannot be interpreted by cmd.exe.
            cp.execFile('mode', [port], { timeout: 3000, windowsHide: true }, err => resolve(!err));
        } else {
            try { fs.accessSync(port, fs.constants.R_OK | fs.constants.W_OK); resolve(true); } catch { resolve(false); }
        }
    });
}

async function confirmPortOrReselect(portHolder) {
    const available = await isPortAvailable(portHolder.port);
    if (available) return true;

    const choice = await vscode.window.showWarningMessage(
        `ESP: Port ${portHolder.port} is not available — device not connected?`,
        { modal: true },
        'Select another port'
    );

    if (choice !== 'Select another port') return false;

    const newPort = await cmdSelectPort();
    if (!newPort) return false;
    portHolder.port = newPort;
    return true;
}

module.exports = {
    detectPorts, cmdSelectPort, isPortAvailable, confirmPortOrReselect,
};
