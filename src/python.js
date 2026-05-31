'use strict';

const { vscode, path, fs, cp,
        IS_WIN, PYTHON_CACHE_TTL,
        log, cfg, setCfg, q,
        getActiveRoot, getValidIdfPath, getGlobalCtx,
        setBusy, clearBusy, checkBusy,
        getTerm, buildCmd, buildMarkerCmd, watchCommandDone,
        setPythonCmdCache, getPythonCmdCache, setPythonCmdTime, getPythonCmdTime,
        setToolsVerified, getProvider, warnNoProject,
} = require('./helpers');

// ─── Python detection (cached) ────────────────────────────────────────────────
// Strip PowerShell-only "& " prefix — cp.exec uses cmd.exe where & is invalid
function toExecCmd(cmd) { return (cmd || '').replace(/^& /, ''); }

// ─── pip availability check ───────────────────────────────────────────────────
async function checkPip(pythonCmd, warn = true) {
    const execCmd = toExecCmd(pythonCmd);
    const hasPip = await new Promise(r =>
        cp.exec(`${execCmd} -m pip --version`, { timeout: 8000 }, (e, stdout, stderr) => {
            log(`[pip] check execCmd="${execCmd}" ok=${!e} out="${(stdout||'').trim()}" err="${(stderr||'').trim()}"`);
            r(!e);
        })
    );
    if (hasPip) return true;

    const msg = warn
        ? `ESP: Python 3.7 found but pip is missing.`
        : `ESP: pip not found — cannot install requirements.`;
    const showFn = warn ? vscode.window.showWarningMessage : vscode.window.showErrorMessage;

    const ans = await showFn(msg, 'Install pip', 'Download Python 3.7');

    if (ans === 'Install pip') {
        log(`[pip] installing via ensurepip for ${pythonCmd}`);

        setBusy('Install pip');

        const t = getTerm('ESP: Install pip');
        t.show(true);

        const markerFile = path.join(require('os').tmpdir(), `esp_pip_${Date.now()}.tmp`);
        const termCmd = (IS_WIN && pythonCmd.startsWith('"')) ? `& ${pythonCmd}` : pythonCmd;
        t.sendText(`${termCmd} -m ensurepip --upgrade${buildMarkerCmd(markerFile)}`);

        await watchCommandDone(markerFile, 'ESP: Install pip').catch(() => {});
        clearBusy();

        const pipOk = await new Promise(r =>
            cp.exec(`${toExecCmd(pythonCmd)} -m pip --version`, { timeout: 5000 }, (e) => r(!e))
        );
        if (pipOk) {
            vscode.window.showInformationMessage('ESP: pip installed successfully!');
            log(`[pip] ensurepip succeeded for ${pythonCmd}`);
            return true;
        } else {
            vscode.window.showErrorMessage('ESP: Failed to install pip. Try reinstalling Python 3.7.');
            log(`[pip] ensurepip failed for ${pythonCmd}`);
            return false;
        }
    }

    if (ans === 'Download Python 3.7')
        vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/release/python-379/'));

    log(`[pip] not found for ${pythonCmd}`);
    return false;
}

async function getPythonCmd(force = false, silent = false) {
    if (!force && getPythonCmdCache() && (Date.now() - getPythonCmdTime() < PYTHON_CACHE_TTL)) return getPythonCmdCache();

    const statusMsg = force ? vscode.window.setStatusBarMessage('$(sync~spin) ESP: Detecting Python 3.7...', 10000) : null;
    try {

    const getVersion = (cmd) => new Promise(r =>
        cp.exec(`${cmd} --version`, { timeout: 3000 }, (e, stdout, stderr) => {
            const m = (stdout + stderr).trim().match(/Python (\d+\.\d+)/);
            r(m ? m[1] : null);
        })
    );

    const found = async (cmd, label) => {
        const termCmd = (IS_WIN && cmd.startsWith('"')) ? `& ${cmd}` : cmd;
        setPythonCmdCache(termCmd);
        setPythonCmdTime(Date.now());
        log(`Python 3.7 detected (${label}): ${termCmd}`);
        await checkPip(cmd);
        return termCmd;
    };

    const notFound = (wrongVersion) => {
        log(`Python not found (wrongVersion=${wrongVersion})`);
        if (silent) return null;
        const msg = wrongVersion
            ? `ESP: Python ${wrongVersion} found but ESP8266 SDK requires Python 3.7.x.`
            : 'ESP: Python 3.7 not found. Install it or set the folder manually.';
        vscode.window.showWarningMessage(msg, 'Set Python 3.7 folder', 'Download Python 3.7')
            .then(ans => {
                if (ans === 'Set Python 3.7 folder')
                    vscode.commands.executeCommand('esp.setPythonPath');
                else if (ans === 'Download Python 3.7')
                    vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/release/python-379/'));
            });
        return null;
    };

    let wrongVersion = null;

    // ── Step 1: Manual path ───────────────────────────────────────────────────
    const manualFolder = cfg('pythonPath') || '';
    if (manualFolder) {
        const manualExe = IS_WIN
            ? path.join(manualFolder, 'python.exe')
            : [path.join(manualFolder, 'python3.7'), path.join(manualFolder, 'python3')].find(p => fs.existsSync(p)) || path.join(manualFolder, 'python3');

        if (!fs.existsSync(manualExe)) {
            const exeLabel = IS_WIN ? 'python.exe' : 'python3 / python3.7';
            const ans = await vscode.window.showWarningMessage(
                `ESP: ${exeLabel} not found in: ${manualFolder}`,
                'Fix manually', 'Try auto-detect'
            );
            if (ans !== 'Try auto-detect') {
                vscode.commands.executeCommand('esp.setPythonPath');
                return null;
            }
        } else {
            const ver = await getVersion(`"${manualExe}"`);
            if (ver && ver.startsWith('3.7')) return found(`"${manualExe}"`, 'manual');

            const problem = ver
                ? `Manual Python path has Python ${ver} (need 3.7.x)`
                : `Python not found at: ${manualFolder}`;
            const ans = await vscode.window.showWarningMessage(
                `ESP: ${problem}.`, 'Fix manually', 'Try auto-detect'
            );
            if (ans !== 'Try auto-detect') {
                vscode.commands.executeCommand('esp.setPythonPath');
                return null;
            }
            if (ver && !wrongVersion) wrongVersion = ver;
        }
    }

    // ── Step 2: by name ───────────────────────────────────────────────────
    const nameCandidates = IS_WIN ? ['python'] : ['python3.7', 'python3', 'python'];
    for (const cmd of nameCandidates) {
        const ver = await getVersion(cmd);
        if (ver && ver.startsWith('3.7')) return found(cmd, `name:${cmd}`);
        if (ver && !wrongVersion) wrongVersion = ver;
    }

    // ── Step 3: Windows registry ──────────────────────────────────────────
    if (IS_WIN) {
        const regRoots = [
            'HKCU\\SOFTWARE\\Python\\PythonCore',
            'HKLM\\SOFTWARE\\Python\\PythonCore',
            'HKLM\\SOFTWARE\\WOW6432Node\\Python\\PythonCore',
        ];
        for (const root of regRoots) {
            const subkeys = await new Promise(r =>
                cp.exec(`reg query "${root}"`, { timeout: 3000 }, (e, stdout) => {
                    if (e) { r([]); return; }
                    const keys = stdout.split('\r\n')
                        .map(l => l.trim())
                        .filter(l => {
                            const last = l.split('\\').pop();
                            return last && last.startsWith('3.7');
                        });
                    r(keys);
                })
            );
            for (const subkey of subkeys) {
                const exePath = await new Promise(r =>
                    cp.exec(`reg query "${subkey}\\InstallPath" /v ExecutablePath`, { timeout: 3000 }, (e, stdout) => {
                        if (e) { r(null); return; }
                        const m = stdout.match(/ExecutablePath\s+REG_SZ\s+(.+)/);
                        r(m ? m[1].trim() : null);
                    })
                );
                if (!exePath || !fs.existsSync(exePath)) continue;
                const ver = await getVersion(`"${exePath}"`);
                if (ver && ver.startsWith('3.7')) return found(`"${exePath}"`, `registry:${subkey}`);
                if (ver && !wrongVersion) wrongVersion = ver;
            }
        }
    }

    // ── Step 4: scan PATH ──────────────────────────────────────────────────
    const sep      = IS_WIN ? ';' : ':';
    const exeNames = IS_WIN ? ['python.exe'] : ['python3.7', 'python3', 'python'];
    for (const dir of (process.env.PATH || '').split(sep)) {
        if (!dir) continue;
        if (IS_WIN && dir.toLowerCase().includes('windowsapps')) continue;
        if (!fs.existsSync(dir)) continue;

        for (const exe of exeNames) {
            const full = path.join(dir, exe);
            if (!fs.existsSync(full)) continue;
            const ver = await getVersion(`"${full}"`);
            if (ver && ver.startsWith('3.7')) return found(`"${full}"`, `PATH scan: ${full}`);
            if (ver && !wrongVersion) wrongVersion = ver;
        }
    }

    // ── Step 5: nothing found ──────────────────────────────────────────────
    return notFound(wrongVersion);

    } finally {
        if (statusMsg) statusMsg.dispose();
    }
}

// ─── Pre-flight check: Python first, then project folder ─────────────────────
async function requireReady() {
    const pythonCmd = await getPythonCmd();
    if (!pythonCmd) return false;
    const root = getActiveRoot();
    if (!root) {
        warnNoProject();
        return false;
    }
    return true;
}

// Returns pip install command parts for requirements.txt (IS_WIN aware)
function pipInstallReqsParts(idfPath, pythonCmd, reqTxt) {
    return IS_WIN
        ? [`$env:IDF_PATH=${q(idfPath)}`, `${pythonCmd} -m pip install -r ${q(reqTxt)}`]
        : [`export IDF_PATH=${q(idfPath)}`, `${pythonCmd} -m pip install -r ${q(reqTxt)}`];
}

// ─── Check python deps before each command ───────────────────────────────────
async function checkPythonDeps(idfPath, pythonCmd) {
    if (!idfPath || !pythonCmd) return true;
    const checkDepsPy = path.join(idfPath, 'tools', 'check_python_dependencies.py');
    if (!fs.existsSync(checkDepsPy)) return true;
    const pyExec = pythonCmd.replace(/^& /, '').replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    return new Promise(resolve => {
        cp.exec(
            `"${pyExec}" "${checkDepsPy}"`,
            { env: { ...process.env, IDF_PATH: idfPath } },
            async (depErr) => {
                if (!depErr) { resolve(true); return; }
                const ans = await vscode.window.showWarningMessage(
                    'ESP-IDF: Python requirements not satisfied. Install now?',
                    'Install', 'Skip'
                );
                if (ans === 'Install') {
                    const reqTxt = path.join(idfPath, 'requirements.txt');
                    const t2 = getTerm('ESP › Install Requirements');
                    t2.show(true);
                    setBusy('Installing requirements');
                    const markerFile = path.join(require('os').tmpdir(), `esp_req_${Date.now()}.tmp`);
                    const parts = pipInstallReqsParts(idfPath, pythonCmd, reqTxt);
                    t2.sendText(buildCmd(parts) + buildMarkerCmd(markerFile));
                    watchCommandDone(markerFile, 'ESP › Install Requirements').then(() => {
                        clearBusy();
                        vscode.window.showInformationMessage('✅ Python requirements installed!');
                    }).catch(e => { clearBusy(); log(`Install Requirements error: ${e?.message || e}`); });
                }
                resolve(false);
            }
        );
    });
}

// ─── Set Python 3.7 path (Manual Toolpath Settings) ──────────────────────────
async function cmdSetPythonPath() {
    if (checkBusy()) return;
    const current = cfg('pythonPath') || '';
    const items = [
        {
            label: '$(search)  Auto-detect',
            description: 'Search automatically via PATH / Python Launcher',
            value: 'auto'
        },
        {
            label: '$(folder)  Select folder...',
            description: current ? `Current: ${current}` : 'Specify Python 3.7 installation folder',
            value: 'folder'
        }
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'ESP-IDF Tools › Python 3.7 Path',
        placeHolder: current ? `Manual: ${current}` : 'Currently: auto-detect',
        ignoreFocusOut: true,
    });
    if (!picked) return;

    if (picked.value === 'auto') {
        await setCfg('pythonPath', '');
        setPythonCmdCache(null);
        setToolsVerified(false);
        if (getProvider()) getProvider().refresh();
        vscode.window.showInformationMessage('ESP: Python path reset to auto-detect.');
        // checkEnvironment is called from extension.js — we just emit the command
        return;
    }

    const uris = await vscode.window.showOpenDialog({
        title: IS_WIN
            ? 'Select folder containing python.exe (e.g. C:\\Python37-32)'
            : 'Select folder containing python3 (e.g. /usr/bin)',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Python 3.7 folder',
    });
    if (!uris || !uris.length) return;

    const folder = uris[0].fsPath;
    await setCfg('pythonPath', folder);
    setPythonCmdCache(null);
    setToolsVerified(false);
    if (getProvider()) getProvider().refresh();
    vscode.window.showInformationMessage(`ESP: Python 3.7 path set to: ${folder}`);
    // Validate the selected folder
    const exePath = IS_WIN
        ? path.join(folder, 'python.exe')
        : [path.join(folder, 'python3.7'), path.join(folder, 'python3')].find(p => fs.existsSync(p)) || path.join(folder, 'python3');
    const verCheck = await new Promise(r =>
        cp.exec(`"${exePath}" --version`, { timeout: 3000 }, (e, so, se) => {
            const m = (so + se).match(/Python (\d+\.\d+)/);
            r(m ? m[1] : null);
        })
    );
    if (!verCheck || !verCheck.startsWith('3.7')) {
        vscode.window.showWarningMessage(
            verCheck
                ? `ESP: Python ${verCheck} found in selected folder. Need 3.7.x!`
                : `ESP: ${IS_WIN ? 'python.exe' : 'python3'} not found in: ${folder}`
        );
    } else {
        await checkPip(`"${exePath}"`);
    }
}

async function cmdFixPython() {
    vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/release/python-379/'));
}

module.exports = {
    toExecCmd, checkPip, getPythonCmd, requireReady, pipInstallReqsParts,
    checkPythonDeps, cmdSetPythonPath, cmdFixPython,
};
