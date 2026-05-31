'use strict';

const { vscode, path, fs, os,
        IS_WIN,
        log, cfg, q,
        getActiveRoot, getValidIdfPath,
        setBusy, clearBusy, checkBusy,
        getTerm, buildMarkerCmd, watchCommandDone,
        buildIdfEnvPrefix, warnNoProject,
        getSdkconfigValue, getPartitionCsvFilename,
} = require('./helpers');

const { getPythonCmd, checkPythonDeps } = require('./python');
const { checkToolsOrPrompt } = require('./idfRunner');
const { cmdSelectPort } = require('./ports');

// ─── Resolve otatool.py path ────────────────────────────────────────────────
function getOtatoolPath() {
    const idfPath = getValidIdfPath();
    if (!idfPath) return null;
    const p = path.join(idfPath, 'components', 'app_update', 'otatool.py');
    return fs.existsSync(p) ? p : null;
}

// ─── Resolve CSV path with $(IDF_PATH) expansion ────────────────────────────
function _resolveCsvPath(root, rawFilename) {
    const idfPath = getValidIdfPath();
    // Expand $(IDF_PATH) in filename
    let filename = rawFilename;
    if (filename.includes('$(IDF_PATH)') && idfPath) {
        filename = filename.replace(/\$\(IDF_PATH\)/g, idfPath.replace(/\\/g, '/'));
    }
    // Also handle ${IDF_PATH}
    if (filename.includes('${IDF_PATH}') && idfPath) {
        filename = filename.replace(/\$\{IDF_PATH\}/g, idfPath.replace(/\\/g, '/'));
    }

    // If filename is now an absolute path, return it directly
    if (path.isAbsolute(filename)) {
        return fs.existsSync(filename) ? filename : null;
    }

    // 1) Project-root relative
    const projectCsv = path.join(root, filename);
    if (fs.existsSync(projectCsv)) return projectCsv;

    // 2) SDK built-in partition table
    if (idfPath) {
        const sdkCsv = path.join(idfPath, 'components', 'partition_table', filename);
        if (fs.existsSync(sdkCsv)) return sdkCsv;
    }

    return null;
}

// ─── Check if project has OTA partitions ────────────────────────────────────
function _parseCsvForOta(csv) {
    const slots = [];
    for (const line of csv.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
        if (parts.length < 5) continue;
        const subtype = (parts[2] || '').toLowerCase();
        if (subtype === 'ota_0' || subtype === 'ota_1') {
            const offset = (parts[3] || '').trim();
            const size = (parts[4] || '').trim();
            if (offset && size && /^0x[0-9a-fA-F]+$|^\d+$/.test(offset) && /^0x[0-9a-fA-F]+$|^\d+$/.test(size)) {
                slots.push({ name: parts[0], type: parts[1], subtype, offset, size });
            }
        }
    }
    const hasOtaData = csv.toLowerCase().includes('ota') && csv.split('\n').some(l => {
        const p = l.trim().split(',').map(s => s.trim().replace(/^"|"$/g, ''));
        return p.length >= 3 && p[1].toLowerCase() === 'data' && p[2] === 'ota';
    });
    return { hasOta: slots.length > 0 && hasOtaData, slots };
}

function hasOtaPartitions(root) {
    // 0) Early exit: explicitly SINGLE_APP = no OTA ever
    if (getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_SINGLE_APP') === 'y') {
        log('[OTA] CONFIG_PARTITION_TABLE_SINGLE_APP=y → no OTA');
        return { hasOta: false, slots: [] };
    }

    // 1) Try to resolve and parse the CSV file from sdkconfig CONFIG_PARTITION_TABLE_FILENAME
    const csvFilename = getPartitionCsvFilename(root);
    log(`[OTA] partition CSV filename from sdkconfig: "${csvFilename}"`);

    const csvPath = _resolveCsvPath(root, csvFilename);
    if (csvPath) {
        log(`[OTA] found CSV at: ${csvPath}`);
        try {
            const result = _parseCsvForOta(fs.readFileSync(csvPath, 'utf8'));
            log(`[OTA] CSV parse result: hasOta=${result.hasOta}, slots=${result.slots.length}`);
            if (result.hasOta) return result;
        } catch (e) {
            log(`[OTA] CSV parse error: ${e.message}`);
        }
    } else {
        log('[OTA] CSV file not found via CONFIG_PARTITION_TABLE_FILENAME');
    }

    // 2) Try build directory (always reflects actual partition table after build)
    const buildCsv = path.join(root, 'build', 'partition_table', 'partition-table.csv');
    if (fs.existsSync(buildCsv)) {
        log(`[OTA] trying build CSV: ${buildCsv}`);
        try {
            const result = _parseCsvForOta(fs.readFileSync(buildCsv, 'utf8'));
            log(`[OTA] build CSV parse result: hasOta=${result.hasOta}, slots=${result.slots.length}`);
            if (result.hasOta) return result;
        } catch (e) {
            log(`[OTA] build CSV parse error: ${e.message}`);
        }
    } else {
        log('[OTA] build CSV not found');
    }

    // 3) Shortcut: check sdkconfig for OTA partition table type
    //    Only trust this if CSV was NOT found or was inconclusive AND the config explicitly says TWO_OTA
    if (getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_TWO_OTA') === 'y') {
        log('[OTA] CONFIG_PARTITION_TABLE_TWO_OTA=y → assuming OTA (CSV not found/readable)');
        return {
            hasOta: true,
            slots: [
                { name: 'ota_0', type: '0', subtype: 'ota_0', offset: '', size: '' },
                { name: 'ota_1', type: '0', subtype: 'ota_1', offset: '', size: '' },
            ],
        };
    }

    log('[OTA] no OTA partitions detected');
    return { hasOta: false, slots: [] };
}

// ─── Check if serial port exists in system port list ───────────────────────
// Returns:
//   'found'   — port is present in system port list
//   'absent'  — port is NOT present (device clearly not connected)
//   'unknown' — can't verify (empty list or detectPorts failed)
async function _checkSerialPort(port) {
    try {
        const { detectPorts } = require('./ports');
        const portList = await detectPorts();
        if (portList && portList.length > 0) {
            const found = portList.some(p => p.name === port);
            log(`[OTA] port check: ${port} ${found ? 'FOUND' : 'NOT FOUND'} in ${portList.length} ports`);
            return found ? 'found' : 'absent';
        }
        // Empty list — can't verify
        log(`[OTA] port check: detectPorts returned empty list, cannot verify ${port}`);
    } catch (e) {
        log(`[OTA] port list check failed: ${e.message?.slice(0, 100)}`);
    }

    // Fallback: can't verify
    log(`[OTA] port check: could not verify ${port}, result=unknown`);
    return 'unknown';
}

// ─── Shared OTA pre-flight check ──────────────────────────────────────────
async function otaPreflight(commandName) {
    if (checkBusy()) return null;

    const pythonCmd = await getPythonCmd(true);
    if (!pythonCmd) return null;

    const idfPath = getValidIdfPath();
    if (!idfPath) {
        vscode.window.showErrorMessage('ESP: IDF_PATH not set or invalid!');
        return null;
    }

    const toolsOk = await checkToolsOrPrompt(idfPath, pythonCmd);
    if (!toolsOk) return null;

    // Check Python dependencies before running otatool.py
    if (!await checkPythonDeps(idfPath, pythonCmd)) return null;

    const root = getActiveRoot();
    if (!root) { warnNoProject(); return null; }

    const otatoolPath = getOtatoolPath();
    if (!otatoolPath) {
        vscode.window.showErrorMessage('ESP: otatool.py not found in SDK. Is this a valid ESP8266_RTOS_SDK?');
        return null;
    }

    // Check OTA partition table
    const { hasOta, slots } = hasOtaPartitions(root);
    if (!hasOta) {
        const ans = await vscode.window.showErrorMessage(
            'ESP OTA: This project does not have an OTA partition table.\n' +
            'The partition table must include ota_0, ota_1 and ota-data partitions.\n' +
            'Enable OTA in Menuconfig → Partition Table → Factory app + Two OTA definitions.',
            'Open Menuconfig', 'Learn More'
        );
        if (ans === 'Open Menuconfig') {
            vscode.commands.executeCommand('esp.menuconfig');
        }
        if (ans === 'Learn More') {
            vscode.env.openExternal(vscode.Uri.parse('https://docs.espressif.com/projects/esp8266-rtos-sdk/en/latest/api-reference/system/ota.html'));
        }
        return null;
    }

    // Check that project has been built and flashed at least once
    const flasherArgs = path.join(root, 'build', 'flasher_args.json');
    if (!fs.existsSync(flasherArgs)) {
        const ans = await vscode.window.showWarningMessage(
            'ESP OTA: Project has not been built yet. The device must be flashed with an OTA-compatible partition table before using OTA commands.',
            'Build & Flash First', 'Cancel'
        );
        if (ans === 'Build & Flash First') {
            vscode.commands.executeCommand('esp.build');
        }
        return null;
    }

    // Select port
    let port = cfg('comPort');
    if (!port) {
        port = await cmdSelectPort();
        if (!port) return null;
    }
    if (port && !/^[a-zA-Z0-9./\\_-]+$/.test(port)) {
        vscode.window.showErrorMessage('ESP: Invalid port name! Shell metacharacters are not allowed.');
        return null;
    }

    // Check if serial port exists in system port list
    const portStatus = await _checkSerialPort(port);
    if (portStatus === 'absent') {
        // Port is definitively NOT in the system port list — hard block
        const ans = await vscode.window.showErrorMessage(
            `ESP OTA: Port ${port} not found in available serial ports.\n` +
            'The device is not connected or the port is incorrect.\n' +
            'OTA commands require a connected device — Python errors will occur otherwise.',
            'Select Port', 'Cancel'
        );
        if (ans === 'Select Port') {
            const newPort = await cmdSelectPort();
            if (!newPort) return null;
            port = newPort;
        } else {
            return null;
        }
    } else if (portStatus === 'unknown') {
        // Can't verify — soft warning with Continue Anyway
        const ans = await vscode.window.showWarningMessage(
            `ESP OTA: Cannot verify port ${port}. If the device is not connected, OTA commands will fail with errors.`,
            'Continue Anyway', 'Cancel'
        );
        if (ans !== 'Continue Anyway') return null;
    }

    return { pythonCmd, idfPath, root, otatoolPath, port, slots };
}

// ─── Show OTA error with helpful message ─────────────────────────────────
function showOtaError(commandName, exitCode) {
    if (exitCode === 0) return;
    const hints = [
        'Device not connected — check the USB cable and COM port',
        'Device has not been flashed with OTA firmware yet — run "ESP › Flash" first',
        'Serial port is busy (monitor or another flash is running) — stop it first',
        'Device is in download mode — OTA commands need the device in normal (run) mode',
    ];
    vscode.window.showErrorMessage(
        `❌ ${commandName} failed (exit ${exitCode}).\n` +
        `Possible causes:\n• ${hints.join('\n• ')}`
    );
}

// ─── OTA Flash: Write firmware to OTA slot via serial ───────────────────────
async function cmdOtaFlash() {
    const pre = await otaPreflight('OTA Flash');
    if (!pre) return;
    const { pythonCmd, idfPath, root, otatoolPath, port, slots } = pre;

    // Select .bin file
    const buildDir = path.join(root, 'build');
    const defaultBin = path.join(buildDir, 'firmware.bin');
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: 'OTA Flash — Step 1/2: Select firmware .bin file',
        defaultUri: fs.existsSync(defaultBin) ? vscode.Uri.file(defaultBin) : (fs.existsSync(buildDir) ? vscode.Uri.file(buildDir) : undefined),
        filters: { 'Binary files': ['bin'], 'All files': ['*'] },
        openLabel: 'Select firmware',
    });
    if (!uris?.length) return;
    const binPath = uris[0].fsPath;

    // Select OTA slot
    const slotItems = slots.map(s => ({
        label: `$(package) ${s.subtype.toUpperCase()}`,
        description: `${s.name} — offset ${s.offset}, size ${s.size}`,
        detail: `Partition slot for OTA firmware write`,
        slot: s,
    }));
    const pickedSlot = await vscode.window.showQuickPick(slotItems, {
        title: 'OTA Flash — Step 2/2: Select OTA slot',
        placeHolder: 'Choose which OTA partition to write to',
    });
    if (!pickedSlot) return;

    // Confirm
    const slotName = pickedSlot.slot.subtype;
    const slotNum = slotName === 'ota_0' ? 0 : slotName === 'ota_1' ? 1 : null;
    const confirmMsg = slotNum !== null
        ? `Write "${path.basename(binPath)}" to ${slotName.toUpperCase()} (${pickedSlot.slot.name}) on port ${port}?`
        : `Write "${path.basename(binPath)}" to partition "${pickedSlot.slot.name}" on port ${port}?`;

    const confirmed = await vscode.window.showWarningMessage(
        confirmMsg,
        { modal: true, detail: 'This will overwrite the selected OTA partition on the device via serial connection.\nMake sure the device is connected and in download mode if needed.' },
        'Flash OTA'
    );
    if (confirmed !== 'Flash OTA') return;

    // Build and run otatool.py command
    setBusy('OTA Flash');

    const termName = 'ESP › OTA Flash';
    const t = getTerm(termName);
    t.show(true);

    const pycmd = pythonCmd.replace(/^& /, '').replace(/^"|"$/g, '');
    const ptOffset = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_OFFSET') || '0x8000';
    const baud = cfg('flashBaud') || '115200';

    const baseArgs = [
        `${pycmd} ${q(otatoolPath)}`,
        `--quiet`,
        `--port`, port,
        `--baud`, String(baud),
        `--partition-table-offset`, ptOffset,
    ];

    if (slotNum !== null) {
        baseArgs.push(`write_ota_partition`, `--slot`, String(slotNum), `--input`, q(binPath));
    } else {
        baseArgs.push(`write_ota_partition`, `--name`, q(pickedSlot.slot.name), `--input`, q(binPath));
    }

    const envPrefix = buildIdfEnvPrefix(idfPath, pythonCmd);
    const markerFile = path.join(os.tmpdir(), `esp_ota_${Date.now()}.tmp`);

    if (IS_WIN) {
        t.sendText([`Set-Location ${q(root)}`, envPrefix, baseArgs.join(' ') + ' 2>$null'].join('; ') + buildMarkerCmd(markerFile));
    } else {
        t.sendText([`cd ${q(root)}`, envPrefix, baseArgs.join(' ') + ' 2>/dev/null'].join(' && ') + buildMarkerCmd(markerFile));
    }

    log(`[OTA Flash] writing ${binPath} to ${slotName} on ${port}`);

    watchCommandDone(markerFile, termName).then(exitCode => {
        if (exitCode === 0) {
            vscode.window.showInformationMessage(`✅ OTA Flash: firmware written to ${slotName.toUpperCase()} successfully!`);
            log(`[OTA Flash] ✅ OK — ${slotName}`);
        } else if (exitCode > 0) {
            showOtaError('OTA Flash', exitCode);
            log(`[OTA Flash] ❌ failed (exit ${exitCode})`);
        }
        clearBusy();
    }).catch(() => clearBusy());
}

// ─── OTA Switch: Switch active OTA partition ────────────────────────────────
async function cmdOtaSwitch() {
    const pre = await otaPreflight('OTA Switch');
    if (!pre) return;
    const { pythonCmd, idfPath, root, otatoolPath, port, slots } = pre;

    // Select which slot to switch to
    const slotItems = slots.map(s => ({
        label: `$(arrow-right) Switch to ${s.subtype.toUpperCase()}`,
        description: `${s.name} — offset ${s.offset}`,
        slot: s,
    }));
    const pickedSlot = await vscode.window.showQuickPick(slotItems, {
        title: 'OTA Switch — Select target boot partition',
        placeHolder: 'Choose which OTA slot to boot from next',
    });
    if (!pickedSlot) return;

    const slotName = pickedSlot.slot.subtype;
    const slotNum = slotName === 'ota_0' ? 0 : slotName === 'ota_1' ? 1 : null;

    setBusy('OTA Switch');

    const termName = 'ESP › OTA Switch';
    const t = getTerm(termName);
    t.show(true);

    const pycmd = pythonCmd.replace(/^& /, '').replace(/^"|"$/g, '');
    const ptOffset = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_OFFSET') || '0x8000';
    const baud = cfg('flashBaud') || '115200';

    const baseArgs = [
        `${pycmd} ${q(otatoolPath)}`,
        `--quiet`,
        `--port`, port,
        `--baud`, String(baud),
        `--partition-table-offset`, ptOffset,
        `switch_ota_partition`,
    ];

    if (slotNum !== null) {
        baseArgs.push(`--slot`, String(slotNum));
    } else {
        baseArgs.push(`--name`, q(pickedSlot.slot.name));
    }

    const envPrefix = buildIdfEnvPrefix(idfPath, pythonCmd);
    const markerFile = path.join(os.tmpdir(), `esp_ota_switch_${Date.now()}.tmp`);

    if (IS_WIN) {
        t.sendText([`Set-Location ${q(root)}`, envPrefix, baseArgs.join(' ') + ' 2>$null'].join('; ') + buildMarkerCmd(markerFile));
    } else {
        t.sendText([`cd ${q(root)}`, envPrefix, baseArgs.join(' ') + ' 2>/dev/null'].join(' && ') + buildMarkerCmd(markerFile));
    }

    log(`[OTA Switch] switching boot to ${slotName} on ${port}`);

    watchCommandDone(markerFile, termName).then(exitCode => {
        if (exitCode === 0) {
            vscode.window.showInformationMessage(`✅ OTA Switch: next boot will use ${slotName.toUpperCase()}. Reset the device to apply.`);
            log(`[OTA Switch] ✅ OK — boot → ${slotName}`);
        } else if (exitCode > 0) {
            showOtaError('OTA Switch', exitCode);
            log(`[OTA Switch] ❌ failed (exit ${exitCode})`);
        }
        clearBusy();
    }).catch(() => clearBusy());
}

// ─── OTA Read Otadata: Show current OTA state ──────────────────────────────
async function cmdOtaReadOtadata() {
    const pre = await otaPreflight('OTA Read');
    if (!pre) return;
    const { pythonCmd, idfPath, root, otatoolPath, port } = pre;

    setBusy('OTA Read');

    const termName = 'ESP › OTA Read Otadata';
    const t = getTerm(termName);
    t.show(true);

    const pycmd = pythonCmd.replace(/^& /, '').replace(/^"|"$/g, '');
    const ptOffset = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_OFFSET') || '0x8000';
    const baud = cfg('flashBaud') || '115200';

    const baseArgs = [
        `${pycmd} ${q(otatoolPath)}`,
        `--port`, port,
        `--baud`, String(baud),
        `--partition-table-offset`, ptOffset,
        `read_otadata`,
    ];

    const envPrefix = buildIdfEnvPrefix(idfPath, pythonCmd);
    const markerFile = path.join(os.tmpdir(), `esp_ota_read_${Date.now()}.tmp`);

    // Note: read_otadata needs stdout to show the OTA data table,
    // so we don't use --quiet here. But we still suppress stderr tracebacks.
    if (IS_WIN) {
        t.sendText([`Set-Location ${q(root)}`, envPrefix, baseArgs.join(' ') + ' 2>$null'].join('; ') + buildMarkerCmd(markerFile));
    } else {
        t.sendText([`cd ${q(root)}`, envPrefix, baseArgs.join(' ') + ' 2>/dev/null'].join(' && ') + buildMarkerCmd(markerFile));
    }

    log(`[OTA Read] reading otadata from ${port}`);
    watchCommandDone(markerFile, termName).then(exitCode => {
        if (exitCode === 0) {
            vscode.window.showInformationMessage('✅ OTA Read: otadata read successfully. Check terminal for details.');
            log('[OTA Read] ✅ OK');
        } else if (exitCode > 0) {
            showOtaError('OTA Read', exitCode);
            log(`[OTA Read] ❌ failed (exit ${exitCode})`);
        }
        clearBusy();
    }).catch(() => clearBusy());
}

// ─── OTA Erase: Erase OTA partition or otadata ─────────────────────────────
async function cmdOtaErase() {
    const pre = await otaPreflight('OTA Erase');
    if (!pre) return;
    const { pythonCmd, idfPath, root, otatoolPath, port, slots } = pre;

    const eraseItems = [
        { label: '$(trash) Erase otadata', description: 'Reset OTA boot selection to factory', value: 'otadata' },
    ];
    for (const s of slots) {
        eraseItems.push({
            label: `$(trash) Erase ${s.subtype.toUpperCase()}`,
            description: `${s.name} — offset ${s.offset}`,
            value: `slot_${s.subtype}`,
            slot: s,
        });
    }

    const picked = await vscode.window.showQuickPick(eraseItems, {
        title: 'OTA Erase — Select what to erase',
        placeHolder: 'Choose partition to erase',
    });
    if (!picked) return;

    const confirmed = await vscode.window.showWarningMessage(
        `Erase ${picked.label.replace('$(trash) ', '')}? This cannot be undone.`,
        { modal: true },
        'Erase'
    );
    if (confirmed !== 'Erase') return;

    setBusy('OTA Erase');

    const termName = 'ESP › OTA Erase';
    const t = getTerm(termName);
    t.show(true);

    const pycmd = pythonCmd.replace(/^& /, '').replace(/^"|"$/g, '');
    const ptOffset = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_OFFSET') || '0x8000';
    const baud = cfg('flashBaud') || '115200';

    const baseArgs = [`${pycmd} ${q(otatoolPath)}`, `--quiet`, `--port`, port, `--baud`, String(baud), `--partition-table-offset`, ptOffset];

    if (picked.value === 'otadata') {
        baseArgs.push('erase_otadata');
    } else {
        const slot = picked.slot;
        const slotNum = slot.subtype === 'ota_0' ? 0 : slot.subtype === 'ota_1' ? 1 : null;
        baseArgs.push('erase_ota_partition');
        if (slotNum !== null) {
            baseArgs.push('--slot', String(slotNum));
        } else {
            baseArgs.push('--name', q(slot.name));
        }
    }

    const envPrefix = buildIdfEnvPrefix(idfPath, pythonCmd);
    const markerFile = path.join(os.tmpdir(), `esp_ota_erase_${Date.now()}.tmp`);

    if (IS_WIN) {
        t.sendText([`Set-Location ${q(root)}`, envPrefix, baseArgs.join(' ') + ' 2>$null'].join('; ') + buildMarkerCmd(markerFile));
    } else {
        t.sendText([`cd ${q(root)}`, envPrefix, baseArgs.join(' ') + ' 2>/dev/null'].join(' && ') + buildMarkerCmd(markerFile));
    }

    log(`[OTA Erase] erasing ${picked.value} on ${port}`);

    watchCommandDone(markerFile, termName).then(exitCode => {
        if (exitCode === 0) {
            vscode.window.showInformationMessage(`✅ OTA Erase: ${picked.label.replace('$(trash) ', '')} erased successfully.`);
            log(`[OTA Erase] ✅ OK — ${picked.value}`);
        } else if (exitCode > 0) {
            showOtaError('OTA Erase', exitCode);
            log(`[OTA Erase] ❌ failed (exit ${exitCode})`);
        }
        clearBusy();
    }).catch(() => clearBusy());
}

module.exports = {
    cmdOtaFlash, cmdOtaSwitch, cmdOtaReadOtadata, cmdOtaErase,
    hasOtaPartitions, getOtatoolPath,
};
