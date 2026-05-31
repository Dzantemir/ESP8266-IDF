'use strict';

const { vscode, path, fs, cp, os,
        IS_WIN,
        log, cfg, setCfg, q,
        getActiveRoot, getValidIdfPath, getGlobalCtx,
        setBusy, clearBusy, checkBusy,
        getTerm, buildCmd, buildMarkerCmd, watchCommandDone,
        buildEnvSetCmd, buildIdfEnvPrefix, warnNoProject, ensureVersionTxt,
        setToolsVerified, getToolsVerified, getProvider,
        setPythonCmdCache,
} = require('./helpers');

const { toExecCmd, getPythonCmd, pipInstallReqsParts, checkPip } = require('./python');

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

    return new Promise(resolve => {
        cp.exec(
            `${toExecCmd(pythonCmd)} "${idfToolsPy}" check`,
            { env: { ...process.env, IDF_PATH: idfPath } },
            async (err, stdout, stderr) => {
                const toolsMissing = err || (stderr && stderr.includes('ERROR:'));
                if (!toolsMissing) {
                    setToolsVerified(true);
                    resolve(true);
                    return;
                }

                const combined = (stdout || '') + (stderr || '');
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

                    const parts = IS_WIN
                        ? [`$env:IDF_PATH=${q(idfPath)}`, `${freshPython} ${q(idfToolsPy)} install`,
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
    const idfPath = getValidIdfPath();
    if (!idfPath) return;

    const idfToolsPy = path.join(idfPath, 'tools', 'idf_tools.py');
    if (!fs.existsSync(idfToolsPy)) return;

    const pythonCmd = await getPythonCmd(false, silent);
    if (!pythonCmd) return;

    return new Promise(resolve => {
        cp.exec(
            `${toExecCmd(pythonCmd)} "${idfToolsPy}" check`,
            { env: { ...process.env, IDF_PATH: idfPath } },
            async (err, stdout, stderr) => {
                const toolsMissing = err || (stderr && stderr.includes('ERROR:'));
                if (toolsMissing) {
                    const combined = (stdout || '') + (stderr || '');
                    const match = combined.match(/ERROR:\s+The following required tools were not found:\s*(.+)/i);
                    const missingList = match ? match[1].trim() : '';
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
                        const parts = IS_WIN
                            ? [`$env:IDF_PATH=${q(idfPath)}`, `${pythonCmd} ${q(idfToolsPy)} install`,
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
                    const checkDepsPy = path.join(idfPath, 'tools', 'check_python_dependencies.py');
                    const reqTxt2     = path.join(idfPath, 'requirements.txt');
                    if (fs.existsSync(checkDepsPy)) {
                        const pyExec  = pythonCmd.replace(/^& /, '').replace(/^"|"$/g, '').replace(/^'|'$/g, '');
                        cp.exec(
                            `"${pyExec}" "${checkDepsPy}"`,
                            { env: { ...process.env, IDF_PATH: idfPath } },
                            async (depErr) => {
                                if (depErr) {
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
