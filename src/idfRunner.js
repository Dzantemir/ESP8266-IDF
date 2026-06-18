'use strict';

const { vscode, path, fs, cp, os,
        IS_WIN, getUserShell,
        log, cfg, setCfg, q,
        getActiveRoot, getValidIdfPath, getGlobalCtx,
        setBusy, clearBusy, checkBusy,
        getTerm, buildCmd, buildMarkerCmd, watchCommandDone,
        buildEnvSetCmd, buildIdfEnvPrefix, warnNoProject, ensureVersionTxt,
        setToolsVerified, getToolsVerified, getProvider,
        setPythonCmdCache,
} = require('./helpers');

const { getPythonCmd, pipInstallReqsParts, checkPip } = require('./python');

// ─── RTOS SDK structure check ────────────────────────────────────────────────
function checkRtosSdkStructure(idfPath) {
    if (!idfPath) return [];
    const missing = [];
    const chk = (rel, isDir) => {
        const full = path.join(idfPath, ...rel.split('/'));
        if (!fs.existsSync(full)) missing.push(rel + (isDir ? '/' : ''));
    };
    chk('components',              true);
    chk('tools',                   true);
    chk('tools/cmake',             true);
    chk('tools/kconfig_new',       true);
    chk('CMakeLists.txt',          false);
    chk('Kconfig',                 false);
    chk('requirements.txt',        false);
    chk('tools/idf_tools.py',      false);
    chk('tools/idf.py',            false);
    chk('tools/tools.json',        false);
    chk('tools/tools_schema.json', false);
    chk('tools/check_python_dependencies.py', false);
    return missing;
}

async function checkEnvironment(silent = false) {
    const warnings = [];

    const pythonCmd = await getPythonCmd(true, silent);
    if (!pythonCmd) {
        warnings.push({
            label: '⚠️ Python 3.7 not found',
            tooltip: 'Python 3.7 is required for ESP8266 SDK\nClick to download Python 3.7',
            command: 'esp.fixPython',
        });
    }

    const idfPathForCheck = getValidIdfPath();
    if (idfPathForCheck) {
        const sdkMissing = checkRtosSdkStructure(idfPathForCheck);
        if (sdkMissing.length > 0) {
            warnings.push({
                label:   '⚠️ RTOS SDK: missing required files',
                tooltip: 'Required files/folders not found in RTOS SDK:\n' + sdkMissing.map(f => '  • ' + f).join('\n') + '\nClick to re-select SDK folder',
                command: 'esp.fixSdk',
            });
        }
    }

    const projectRoot = getActiveRoot();
    if (projectRoot) {
        const hasCmake = fs.existsSync(path.join(projectRoot, 'CMakeLists.txt'));
        const hasSdkconfig = fs.existsSync(path.join(projectRoot, 'sdkconfig'));
        if (!hasCmake && !hasSdkconfig) {
            warnings.push({
                label: '⚠️ Not an ESP8266-IDF project',
                tooltip: 'No CMakeLists.txt or sdkconfig found in the project folder.\nClick to select a different project folder.',
                command: 'esp.selectProject',
            });
        }
    }

    if (getProvider()) getProvider().setEnvWarnings(warnings);

    if (warnings.length === 0) return true;

    if (!silent) {
        const firstWarning = warnings[0];
        const label = firstWarning.label.replace('⚠️ ', '');
        const ans = await vscode.window.showErrorMessage(
            `ESP8266-IDF: ${label}. See sidebar for details.`,
            'Fix Now'
        );
        if (ans === 'Fix Now') {
            vscode.commands.executeCommand(firstWarning.command);
        }
    }

    return false;
}

async function cmdFixSdk() {
    if (checkBusy()) return;
    const cfgKey  = 'idfPath';
    const sdkName = 'RTOS SDK';
    const envVar  = 'IDF_PATH';

    const action = await new Promise(resolve => {
        const qp = vscode.window.createQuickPick();
        qp.title       = `ESP8266: Setup ${sdkName}`;
        qp.placeholder = 'How do you want to set up the SDK?';
        qp.ignoreFocusOut = true;
        qp.items = [
            { label: '$(folder-opened) Select existing SDK folder', description: 'Already downloaded — just point to it', value: 'set'   },
            { label: '$(x) Reset',                                  description: `Use ${envVar} environment variable`,    value: 'reset' },
        ];
        qp.buttons = [{
            iconPath: new vscode.ThemeIcon('info'),
            tooltip:  `Show expected ${sdkName} folder structure`
        }];
        qp.onDidTriggerButton(async () => {
            const msg = [
                    `📁 ESP8266_RTOS_SDK/`,
                    `├── components/    ← required`,
                    `├── tools/         ← required`,
                    `├── CMakeLists.txt  ← required`,
                    `├── Kconfig         ← required`,
                    `└── requirements.txt ← required`,
                    ``,
                    `Download:`,
                    `  github.com/espressif/ESP8266_RTOS_SDK`,
                  ].join('\n');
            const btn = await vscode.window.showInformationMessage(
                `Expected ${sdkName} folder structure`,
                { modal: true, detail: msg },
                'Copy to Clipboard', 'OK'
            );
            if (btn === 'Copy to Clipboard') vscode.env.clipboard.writeText(msg);
        });
        qp.onDidAccept(() => { const sel = qp.selectedItems[0]; qp.hide(); resolve(sel || null); });
        qp.onDidHide(()  => resolve(null));
        qp.show();
    });
    if (!action) return;

    if (action.value === 'reset') {
        await setCfg(cfgKey, '');
        vscode.window.showInformationMessage(`ESP: ${sdkName} reset → using ${envVar} from environment`);
        return;
    }

    if (action.value === 'set') {
        const folder = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false,
            openLabel: `Select ${sdkName} folder`
        });
        if (!folder?.[0]) return;
        const selected = folder[0].fsPath;

        const missing = checkRtosSdkStructure(selected);
        if (missing.length) {
            const ok = await vscode.window.showWarningMessage(
                `Required files not found — this does not look like a valid RTOS SDK. Use anyway?`,
                { modal: true, detail: `Missing:\n${missing.map(f => `  • ${f}`).join('\n')}` },
                'Yes', 'Cancel'
            );
            if (ok !== 'Yes') return;
        }
        await setCfg(cfgKey, selected);
        ensureVersionTxt(selected);
        setPythonCmdCache(null);
        setToolsVerified(false);
        if (getProvider()) getProvider().refresh();
        vscode.window.showInformationMessage(`✅ ${sdkName} → ${selected}`);
        await checkEnvironment(true);
        await checkAndInstallTools();
        const { getSdkVersion } = require('./helpers');
        const sdkVer = getSdkVersion(selected);
        if (sdkVer) {
            vscode.window.showInformationMessage(`ESP: SDK version: ${sdkVer}`);
        }
        return;
    }
}

// ─── Check tools before command, prompt to install if missing ────────────────
async function checkToolsOrPrompt(idfPath, pythonCmd) {
    if (getToolsVerified()) return true;

    const idfToolsPy = path.join(idfPath, 'tools', 'idf_tools.py');
    if (!fs.existsSync(idfToolsPy)) { setToolsVerified(true); return true; }

    // #FIX: Strip shell quotes from pythonCmd for execFile — cp.execFile()
    // executes the binary directly (no shell), so surrounding quotes are
    // treated as part of the filename and the call fails silently.
    const pyExec = pythonCmd.replace(/^& /, '').replace(/^"|"$/g, '').replace(/^'|'$/g, '');

    return new Promise(resolve => {
        cp.execFile(
            pyExec, [idfToolsPy, 'check'],
            { env: { ...process.env, IDF_PATH: idfPath } },
            async (err, stdout, stderr) => {
                // #FIX: Only treat as "tools missing" if the specific ERROR message
                // from idf_tools.py is present. A non-zero exit code or generic
                // "ERROR" in stderr can be triggered by warnings, deprecation
                // notices, or Python import warnings — not by missing tools.
                const combined = (stdout || '') + (stderr || '');
                const hasToolError = combined.match(/ERROR:\s+The following required tools were not found:/i);
                // #FIX(1.85.0): If idf_tools.py failed to spawn (python ENOENT, import
                // error, etc.), `err` is truthy but `hasToolError` is null — previously
                // this fell through to setToolsVerified(true), treating a crash as
                // "tools verified OK". Resolve false WITHOUT marking verified so the
                // caller knows the check failed and can retry.
                if (err && !hasToolError) {
                    log('[checkToolsOrPrompt] idf_tools.py check failed: ' + (err.message || err));
                    resolve(false);
                    return;
                }
                if (!hasToolError) {
                    setToolsVerified(true);
                    log('[checkToolsOrPrompt] Build tools verified OK');
                    resolve(true);
                    return;
                }

                const match = combined.match(/ERROR:\s+The following required tools were not found:\s*(.+)/i);
                const missingList = match ? match[1].trim() : '';
                const detail = missingList
                    ? `Missing tools: ${missingList}`
                    : 'Run "Install Tools" to set up the build environment.';

                const ans = await vscode.window.showErrorMessage(
                    missingList
                        ? `⚠️ ESP8266-IDF: Build tools not found (${missingList}). Install them first?`
                        : '⚠️ ESP8266-IDF: Build tools are not installed. Install them first?',
                    'Install Now', 'Cancel'
                );

                if (ans === 'Install Now') {
                    const freshPython = await getPythonCmd(true);
                    if (!freshPython) {
                        const a = await vscode.window.showErrorMessage(
                            'ESP: Python not found! Please install Python 3.7 first.',
                            'Download Python 3.7'
                        );
                        if (a === 'Download Python 3.7') {
                            vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/release/python-379/'));
                        }
                        resolve(false);
                        return;
                    }

                    const t = getTerm('ESP › Install Tools');
                    t.show(true);
                    setBusy('Installing Tools');

                    const markerFile = path.join(os.tmpdir(), `esp_install_${Date.now()}.tmp`);
                    const reqTxt = path.join(idfPath, 'requirements.txt');

                    const pipOk = await checkPip(freshPython);
                    if (!pipOk) { clearBusy(); resolve(false); return; }

                    // #FIX(1.85.0): Branch on configured shell — buildCmd() joins parts
                    // with " && " for cmd.exe, which cannot parse PowerShell's
                    // `$env:IDF_PATH=...` syntax. Emit `set "IDF_PATH=..."` for cmd.exe.
                    const idfSetCmd = getUserShell().toLowerCase().includes('cmd')
                        ? `set "IDF_PATH=${idfPath}"`
                        : `$env:IDF_PATH=${q(idfPath)}`;
                    const parts = IS_WIN
                        ? [idfSetCmd, `${freshPython} ${q(idfToolsPy)} install`,
                           ...(fs.existsSync(reqTxt) ? [`${freshPython} -m pip install -r ${q(reqTxt)}`] : [])]
                        : [`export IDF_PATH=${q(idfPath)}`, `${freshPython} ${q(idfToolsPy)} install`,
                           ...(fs.existsSync(reqTxt) ? [`${freshPython} -m pip install -r ${q(reqTxt)}`] : [])];
                    t.sendText(buildCmd(parts) + buildMarkerCmd(markerFile));

                    watchCommandDone(markerFile, 'ESP › Install Tools').then(exitCode => {
                        if (exitCode === 0) {
                            setToolsVerified(true);
                            vscode.window.showInformationMessage('✅ ESP8266-IDF tools installed! You can now run Build.');
                        } else if (exitCode > 0) {
                            setToolsVerified(false);
                            vscode.window.showErrorMessage(`ESP8266-IDF tools installation failed (exit code ${exitCode}). Check the terminal for details.`);
                        } else {
                            setToolsVerified(false);
                            log('[Install Tools] Marker not found — install may not have completed');
                        }
                        clearBusy();
                    }).catch(e => { clearBusy(); log(`Install Tools error: ${e?.message || e}`); });
                }
                resolve(false);
            }
        );
    });
}

// ─── Resolve bundled script paths ───────────────────────────────────────
function getSpiffsgenScript() {
    return path.join(getGlobalCtx().extensionPath, 'scripts', 'spiffsgen.py');
}

function getFatfsgenScript() {
    return path.join(getGlobalCtx().extensionPath, 'scripts', 'fatfsgen.py');
}

function getLittlefsgenScript() {
    return path.join(getGlobalCtx().extensionPath, 'scripts', 'littlefsgen.py');
}

async function checkAndInstallTools(silent = true) {
    // #FIX: Skip if tools were already verified in this session
    if (getToolsVerified()) return;

    const idfPath = getValidIdfPath();
    if (!idfPath) return;

    const idfToolsPy = path.join(idfPath, 'tools', 'idf_tools.py');
    if (!fs.existsSync(idfToolsPy)) { setToolsVerified(true); return; }

    const pythonCmd = await getPythonCmd(false, silent);
    if (!pythonCmd) return;

    // #FIX: Strip shell quotes from pythonCmd for execFile — cp.execFile()
    // executes the binary directly (no shell), so surrounding quotes are
    // treated as part of the filename and the call fails silently.
    const pyExec = pythonCmd.replace(/^& /, '').replace(/^"|"$/g, '').replace(/^'|'$/g, '');

    return new Promise(resolve => {
        cp.execFile(
            pyExec, [idfToolsPy, 'check'],
            { env: { ...process.env, IDF_PATH: idfPath } },
            async (err, stdout, stderr) => {
                // #FIX: Only treat as "tools missing" if stderr contains the specific
                // ERROR message from idf_tools.py. A non-zero exit code alone can be
                // triggered by warnings, deprecation notices, or other non-critical
                // output. The actual "tools not found" condition is always accompanied
                // by an ERROR line in stderr/stdout.
                const combined = (stdout || '') + (stderr || '');
                const hasToolError = combined.match(/ERROR:\s+The following required tools were not found:/i);
                // #FIX(1.85.0): If idf_tools.py failed to spawn (python ENOENT, import
                // error, etc.), `err` is truthy but `hasToolError` is null — previously
                // this fell through to the `else` branch which calls setToolsVerified(true),
                // treating a crash as "tools verified OK". Mark verified=false and
                // resolve without prompting so the caller can retry later.
                if (err && !hasToolError) {
                    log('[checkAndInstallTools] idf_tools.py check failed: ' + (err.message || err));
                    setToolsVerified(false);
                    resolve();
                    return;
                }
                if (hasToolError) {
                    const match = combined.match(/ERROR:\s+The following required tools were not found:\s*(.+)/i);
                    const missingList = match ? match[1].trim() : '';

                    if (silent) {
                        // In silent mode (startup), just log and set verified — don't spam
                        // the user with a dialog every time VS Code starts.
                        log(`[checkAndInstallTools] Tools missing (silent): ${missingList || 'unknown'}`);
                        setToolsVerified(false);
                        resolve();
                        return;
                    }

                    const msg = missingList
                        ? `ESP8266-IDF: Required build tools not found (${missingList}). Install now?`
                        : 'ESP8266-IDF: Required build tools are not installed. Install now?';

                    const ans = await vscode.window.showInformationMessage(msg, 'Install', 'Cancel');
                    if (ans === 'Install') {
                        const pipOk = await checkPip(pythonCmd);
                        if (!pipOk) { resolve(); return; }

                        const t = getTerm('ESP › Install Tools');
                        t.show(true);
                        setBusy('Installing Tools');

                        const markerFile = path.join(os.tmpdir(), `esp_install_${Date.now()}.tmp`);
                        const marker = buildMarkerCmd(markerFile);

                        const reqTxt = path.join(idfPath, 'requirements.txt');
                        // #FIX(1.85.0): Branch on configured shell — buildCmd() joins parts
                        // with " && " for cmd.exe, which cannot parse PowerShell's
                        // `$env:IDF_PATH=...` syntax. Emit `set "IDF_PATH=..."` for cmd.exe.
                        const idfSetCmd = getUserShell().toLowerCase().includes('cmd')
                            ? `set "IDF_PATH=${idfPath}"`
                            : `$env:IDF_PATH=${q(idfPath)}`;
                        const parts = IS_WIN
                            ? [idfSetCmd, `${pythonCmd} ${q(idfToolsPy)} install`,
                               ...(fs.existsSync(reqTxt) ? [`${pythonCmd} -m pip install -r ${q(reqTxt)}`] : [])]
                            : [`export IDF_PATH=${q(idfPath)}`, `${pythonCmd} ${q(idfToolsPy)} install`,
                               ...(fs.existsSync(reqTxt) ? [`${pythonCmd} -m pip install -r ${q(reqTxt)}`] : [])];
                        t.sendText(buildCmd(parts) + marker);

                        watchCommandDone(markerFile, 'ESP › Install Tools').then(exitCode => {
                            if (exitCode === 0) {
                                setToolsVerified(true);
                                vscode.window.showInformationMessage('✅ ESP8266-IDF tools installed successfully!');
                            } else if (exitCode > 0) {
                                setToolsVerified(false);
                                vscode.window.showErrorMessage(`ESP8266-IDF tools installation failed (exit code ${exitCode}). Check the terminal for details.`);
                            } else {
                                setToolsVerified(false);
                            }
                            clearBusy();
                        }).catch(e => { clearBusy(); log(`Install Tools error: ${e?.message || e}`); });
                    }
                } else {
                    // #FIX: Tools are present — set verified flag so we don't re-check
                    // on every command. Previously this was missing, causing the startup
                    // check to run idf_tools.py on every command even when tools were OK.
                    setToolsVerified(true);
                    log('[checkAndInstallTools] Build tools verified OK');

                    const checkDepsPy = path.join(idfPath, 'tools', 'check_python_dependencies.py');
                    const reqTxt2     = path.join(idfPath, 'requirements.txt');
                    if (fs.existsSync(checkDepsPy)) {
                        const pyExec  = pythonCmd.replace(/^& /, '').replace(/^"|"$/g, '').replace(/^'|'$/g, '');
                        cp.execFile(
                            pyExec, [checkDepsPy],
                            { env: { ...process.env, IDF_PATH: idfPath } },
                            async (depErr) => {
                                if (depErr) {
                                    if (silent) {
                                        log('[checkAndInstallTools] Python requirements not satisfied (silent)');
                                        resolve();
                                        return;
                                    }
                                    const ans = await vscode.window.showWarningMessage(
                                        'ESP8266-IDF: Python requirements not satisfied. Install now?',
                                        'Install', 'Skip'
                                    );
                                    if (ans === 'Install') {
                                        const t2 = getTerm('ESP › Install Requirements');
                                        t2.show(true);
                                        setBusy('Installing requirements');
                                        const markerFile2 = path.join(os.tmpdir(), `esp_req_${Date.now()}.tmp`);
                                        const parts2 = pipInstallReqsParts(idfPath, pythonCmd, reqTxt2);
                                        t2.sendText(buildCmd(parts2) + buildMarkerCmd(markerFile2));
                                        watchCommandDone(markerFile2, 'ESP › Install Requirements').then(exitCode => {
                                            clearBusy();
                                            if (exitCode === 0) {
                                                vscode.window.showInformationMessage('✅ Python requirements installed!');
                                            } else {
                                                vscode.window.showErrorMessage('❌ Python requirements installation failed. Check terminal.');
                                            }
                                        }).catch(e => { clearBusy(); log(`Install Requirements error: ${e?.message || e}`); });
                                    }
                                } else {
                                    log('[checkAndInstallTools] Python requirements verified OK');
                                }
                                resolve();
                            }
                        );
                    } else {
                        resolve();
                    }
                    return;
                }
                resolve();
            }
        );
    });
}

module.exports = {
    checkRtosSdkStructure, checkEnvironment, cmdFixSdk,
    checkToolsOrPrompt, getSpiffsgenScript, getFatfsgenScript, getLittlefsgenScript,
    checkAndInstallTools,
};
