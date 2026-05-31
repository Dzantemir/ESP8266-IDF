'use strict';

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const cp     = require('child_process');

// ╔══════════════════════════════════════════════════════════════════╗
// ║  MODULE-LEVEL STATE (shared across all modules)                    ║
// ╚══════════════════════════════════════════════════════════════════╝
let terms             = {};
let activeRoot        = null;
let globalCtx         = null;
let outputChannel     = null;
let portCache         = { data:[], timestamp: 0 };
let _pythonCmd        = null;
let _pythonCmdTime    = 0;
let _idfPathOverride  = null;
let _toolsVerified    = false;
let _sdkVersionCache  = null;

const PYTHON_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
let _statusBarPort    = null;
let _statusBarBusy    = null;
let _statusBarBuild   = null;
let _statusBarFlash   = null;
let _statusBarMonitor = null;
let _statusBarClean   = null;
let _statusBarMenuconfig = null;
let _monitorRunning   = false;
let _globalBusy       = false;
let _globalBusyName   = '';
let _lastCmdStartTime = 0;
let provider          = null;
let _partitionPanel   = null;
let _pushSdkconfigUpdate = null;
let _sdkconfigCache   = null;
let _onBusyChange      = null;   // callback(busy: boolean, name: string)

// ─── Platform ─────────────────────────────────────────────────────────────────
const IS_WIN   = os.platform() === 'win32';
const IS_MAC   = os.platform() === 'darwin';
const IS_LINUX = os.platform() === 'linux';

// ─── Shared constants ──────────────────────────────────────────────────────────
const FLASH_SIZE_MAP = {
    '256KB': 262144, '512KB': 524288, '1MB': 1048576, '2MB': 2097152,
    '4MB': 4194304, '8MB': 8388608, '16MB': 16777216,
    '512K': 524288,  '1M': 1048576,  '2M': 2097152,  '4M': 4194304,
    '8M': 8388608,  '16M': 16777216,
};

// ╔══════════════════════════════════════════════════════════════════╗
// ║  STATE GETTERS / SETTERS                                           ║
// ╚══════════════════════════════════════════════════════════════════╝
const getTerms            = () => terms;
const setTerms            = (v) => { terms = v; };
let _activeRootWarned = false;
const getActiveRoot       = () => {
    if (activeRoot && !fs.existsSync(activeRoot)) {
        if (!_activeRootWarned) {
            log(`[WARN] Active root "${activeRoot}" no longer exists on disk`);
            _activeRootWarned = true;
        }
        return null;
    }
    if (_activeRootWarned) _activeRootWarned = false; // reset when root becomes valid again
    return activeRoot || null;
};
const setActiveRoot       = (v) => { activeRoot = v; };
const getGlobalCtx        = () => globalCtx;
const setGlobalCtx        = (v) => { globalCtx = v; };
const getOutputChannel    = () => outputChannel;
const setOutputChannel    = (v) => { outputChannel = v; };
const getPortCache        = () => portCache;
const setPortCache        = (v) => { portCache = v; };
const getPythonCmdCache   = () => _pythonCmd;
const setPythonCmdCache   = (v) => { _pythonCmd = v; };
const getPythonCmdTime    = () => _pythonCmdTime;
const setPythonCmdTime    = (v) => { _pythonCmdTime = v; };
const getIdfPathOverride  = () => _idfPathOverride;
const setIdfPathOverride  = (v) => { _idfPathOverride = v; };
const getToolsVerified    = () => _toolsVerified;
const setToolsVerified    = (v) => { _toolsVerified = v; };
const getSdkVersionCache  = () => _sdkVersionCache;
const setSdkVersionCache  = (v) => { _sdkVersionCache = v; };
const getMonitorRunning   = () => _monitorRunning;
const setMonitorRunning   = (v) => { _monitorRunning = v; };
const getGlobalBusy       = () => _globalBusy;
const getGlobalBusyName   = () => _globalBusyName;
const getLastCmdStartTime = () => _lastCmdStartTime;
const getProvider         = () => provider;
const setProvider         = (v) => { provider = v; };
const getPartitionPanel   = () => _partitionPanel;
const setPartitionPanel   = (v) => { _partitionPanel = v; };
const getPushSdkconfigUpdate = () => _pushSdkconfigUpdate;
const setPushSdkconfigUpdate = (v) => { _pushSdkconfigUpdate = v; };
const getSdkconfigCache   = () => _sdkconfigCache;
const setSdkconfigCache   = (v) => { _sdkconfigCache = v; };
const getStatusBarPort    = () => _statusBarPort;
const getStatusBarBusy    = () => _statusBarBusy;
const getStatusBarBuild   = () => _statusBarBuild;
const getStatusBarFlash   = () => _statusBarFlash;
const getStatusBarMonitor = () => _statusBarMonitor;
const getStatusBarClean   = () => _statusBarClean;
const getStatusBarMenuconfig = () => _statusBarMenuconfig;

// Used by statusBar.js to set references after creating them
function _setStatusBarItems(items) {
    if (items.port)       _statusBarPort       = items.port;
    if (items.busy)       _statusBarBusy       = items.busy;
    if (items.build)      _statusBarBuild      = items.build;
    if (items.flash)      _statusBarFlash      = items.flash;
    if (items.monitor)    _statusBarMonitor    = items.monitor;
    if (items.clean)      _statusBarClean      = items.clean;
    if (items.menuconfig) _statusBarMenuconfig = items.menuconfig;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  UTILITY FUNCTIONS                                                 ║
// ╚══════════════════════════════════════════════════════════════════╝

// ─── Path escape helper (Экранирование пробелов в путях) ─────────────────
function q(p) {
    if (!p) return '""';
    if (IS_WIN) {
        const shellPath = cfg('shellPath') || '';
        const isCmd = shellPath.toLowerCase().includes('cmd');
        if (isCmd) {
            return `"${p.replace(/"/g, '""')}"`;
        }
        return `'${p.replace(/'/g, "''")}'`;
    }
    return `"${p.replace(/(["\\$`])/g, '\\$1').replace(/\n/g, "'\\n'")}"`;
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('ESP8266-IDF Tools');
    }
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ─── Config helpers ───────────────────────────────────────────────────────────
function cfg(key) {
    return vscode.workspace.getConfiguration('esp8266-idf', null).get(key);
}

async function setCfg(key, val) {
    const config = vscode.workspace.getConfiguration('esp8266-idf');
    if (cfg('saveSettingsToWorkspace') && vscode.workspace.workspaceFolders?.length) {
        await config.update(key, val, vscode.ConfigurationTarget.Workspace);
    } else {
        try { await config.update(key, undefined, vscode.ConfigurationTarget.Workspace); } catch {}
        await config.update(key, val, vscode.ConfigurationTarget.Global);
    }
}

// ─── Path helpers ─────────────────────────────────────────────────────────────
function expandHome(p) {
    if (!p) return p;
    return (p.startsWith('~/') || p === '~') ? path.join(os.homedir(), p.slice(2)) : p;
}

function getValidIdfPath() {
    const p = expandHome(_idfPathOverride || cfg('idfPath')) || process.env.IDF_PATH;
    if (!p || !fs.existsSync(p)) return null;
    if (!fs.existsSync(path.join(p, 'tools', 'idf_tools.py'))) return null;
    return p;
}

// ─── SDK version detection (cached) ──────────────────────────────────────────
function getSdkVersion(idfPath) {
    if (!idfPath) return '';
    if (_sdkVersionCache && _sdkVersionCache.idfPath === idfPath) return _sdkVersionCache.version;

    let version = '';

    try {
        const gitDescribe = cp.execSync('git describe --tags --always', {
            cwd: idfPath,
            timeout: 3000,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        if (gitDescribe) version = gitDescribe;
    } catch {}

    if (!version) {
        try {
            const versionFile = path.join(idfPath, 'version.txt');
            if (fs.existsSync(versionFile)) {
                version = fs.readFileSync(versionFile, 'utf8').trim();
            }
        } catch {}
    }

    if (!version) {
        try {
            const gitBranch = cp.execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: idfPath,
                timeout: 3000,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
            if (gitBranch) version = gitBranch;
        } catch {}
    }

    _sdkVersionCache = { idfPath, version };
    return version;
}

// ─── Shared one-liner helpers ────────────────────────────────────────────────
function warnNoProject() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        vscode.window.showErrorMessage('ESP: No workspace folder open.', 'Open Folder')
            .then(a => { if (a === 'Open Folder') vscode.commands.executeCommand('workbench.action.files.openFolder'); });
    } else {
        vscode.window.showErrorMessage('ESP: Select project folder!', 'Select Folder')
            .then(a => { if (a === 'Select Folder') vscode.commands.executeCommand('esp.selectProject'); });
    }
}

// ─── Shell detection ────────────────────────────────────────────────────────────
function getUserShell() {
    if (IS_WIN) return cfg('shellPath') || 'powershell.exe';
    return cfg('shellPath') || process.env.SHELL || '/bin/bash';
}

// ─── Global busy lock ────────────────────────────────────────────────────────
function setBusy(name) {
    _globalBusy       = true;
    _globalBusyName   = name;
    _lastCmdStartTime = Date.now();
    vscode.commands.executeCommand('setContext', 'esp.busy', true);
    if (_statusBarBusy) {
        _statusBarBusy.text            = `$(sync~spin) ESP: ${name}`;
        _statusBarBusy.tooltip         = `ESP: running — ${name}\nAll commands are locked until finished\nClick to open terminal`;
        _statusBarBusy.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        _statusBarBusy.show();
    }
    log(`[BUSY] locked by: ${name}`);
    if (_onBusyChange) try { _onBusyChange(true, name); } catch {}
}

function clearBusy() {
    _globalBusy     = false;
    _globalBusyName = '';
    vscode.commands.executeCommand('setContext', 'esp.busy', false);
    if (_statusBarBusy) {
        _statusBarBusy.hide();
        _statusBarBusy.backgroundColor = undefined;
    }
    log('[BUSY] released');
    if (_onBusyChange) try { _onBusyChange(false, ''); } catch {}
}

function checkBusy() {
    if (_globalBusy) {
        vscode.window.showWarningMessage(
            `ESP: "${_globalBusyName}" is running. Wait for it to finish.`,
            'Show Terminal'
        ).then(c => { if (c === 'Show Terminal') vscode.commands.executeCommand('workbench.action.terminal.focus'); });
        return true;
    }
    return false;
}

// ─── Compiler path detection for IntelliSense ────────────────────────────────
function findXtensaGcc() {
    const espressifTools = path.join(os.homedir(), '.espressif', 'tools');
    const xtensaRoot = path.join(espressifTools, 'xtensa-lx106-elf');
    if (!fs.existsSync(xtensaRoot)) return '';
    try {
        const gccBin = IS_WIN ? 'xtensa-lx106-elf-gcc.exe' : 'xtensa-lx106-elf-gcc';
        const versions = fs.readdirSync(xtensaRoot)
            .filter(d => fs.statSync(path.join(xtensaRoot, d)).isDirectory())
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
        for (const ver of versions) {
            const candidate = path.join(xtensaRoot, ver, 'bin', gccBin);
            if (fs.existsSync(candidate)) { log(`Found xtensa gcc: ${candidate}`); return candidate; }
        }
    } catch { /* ignore */ }
    return '';
}

// ─── Terminal management ──────────────────────────────────────────────────────
function getTerm(name) {
    const reuse = cfg('reuseTerminal');
    if (reuse && terms[name] && terms[name].exitStatus === undefined) {
        return terms[name];
    }
    if (terms[name]) {
        try { terms[name].dispose(); } catch {}
        delete terms[name];
    }
    const shellPath = getUserShell();
    const options = { name, shellPath };
    if (IS_WIN && shellPath.toLowerCase().includes('powershell') && cfg('useExecutionPolicyBypass')) {
        options.shellArgs = ['-ExecutionPolicy', 'Bypass', '-NoLogo', '-NoProfile'];
    }
    const t = vscode.window.createTerminal(options);
    terms[name] = t;
    return t;
}

function buildCmd(parts) {
    if (IS_WIN) {
        const shellPath = getUserShell();
        const isCmd = shellPath.toLowerCase().includes('cmd');
        return isCmd ? parts.join(' && ') : parts.join('; ');
    }
    return parts.join(' && ');
}

// ─── Create version.txt if missing or content invalid ────────────────────────
function ensureVersionTxt(idfPath) {
    if (!idfPath || !fs.existsSync(idfPath)) return;
    const versionFile = path.join(idfPath, 'version.txt');

    let needsWrite = false;
    if (!fs.existsSync(versionFile)) {
        needsWrite = true;
    } else {
        const head = fs.readFileSync(versionFile, 'utf8').slice(0, 16).trim();
        needsWrite = !/^v\d+\.\d+/.test(head);
    }

    if (needsWrite) {
        try {
            // Try to get version from git tag first
            let version = 'unknown';
            try {
                const result = cp.execSync('git describe --tags --always', {
                    cwd: idfPath, encoding: 'utf8', timeout: 5000
                }).trim();
                if (result) version = result;
            } catch {}
            if (version === 'unknown') {
                // Fallback: try to read from git HEAD or kconfig
                try {
                    const headRef = path.join(idfPath, '.git', 'HEAD');
                    if (fs.existsSync(headRef)) {
                        const head = fs.readFileSync(headRef, 'utf8').trim();
                        const match = head.match(/ref: refs\/(tags|heads)\/(.+)/);
                        if (match) version = match[2];
                    }
                } catch {}
            }
            fs.writeFileSync(versionFile, version);
            log(`[version.txt] Written '${version}' to: ${versionFile}`);
        } catch (e) {
            log(`[version.txt] Failed to write: ${e.message}`);
        }
    }
}

// ─── IDF env prefix ───────────────────────────────────────────────────────────
function buildIdfEnvPrefix(idfPath, pythonCmd) {
    const py = pythonCmd || (IS_WIN ? 'python' : 'python3');
    const idfToolsPy = path.join(idfPath, 'tools', 'idf_tools.py');
    if (IS_WIN) {
        return [
            `$env:IDF_PATH=${q(idfPath)}`,
            `try { ${py} ${q(idfToolsPy)} export --format key-value 2>$null | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object { $k,$v = $_ -split '=',2; if ($k -eq 'PATH') { $env:PATH = ($v -replace [regex]::Escape('%PATH%'), $env:PATH) } else { Set-Item "Env:$k" $v } } } catch {}`,
        ].join('; ');
    } else {
        return `export IDF_PATH=${q(idfPath)} && eval $(${py} ${q(idfToolsPy)} export --format shell 2>/dev/null) 2>/dev/null || true`;
    }
}

// ─── Build notifications via marker file ─────────────────────────────────────
function watchCommandDone(markerFile, termName) {
    return new Promise(resolve => {
        const started   = Date.now();
        const maxWaitMs = 30 * 60 * 1000;
        const timer = setInterval(() => {
            if (!terms[termName] || terms[termName].exitStatus !== undefined) {
                clearInterval(timer);
                try { fs.unlinkSync(markerFile); } catch {}
                resolve(-1); return;
            }
            if (Date.now() - started > maxWaitMs) {
                clearInterval(timer);
                try { fs.unlinkSync(markerFile); } catch {}
                log(`[BUSY] command watcher timed out: ${termName}`);
                resolve(-1); return;
            }
            if (fs.existsSync(markerFile)) {
                clearInterval(timer);
                let _exitCode = -1;
                try {
                    _exitCode = parseInt(fs.readFileSync(markerFile, 'utf8').trim(), 10);
                } catch {}
                try { fs.unlinkSync(markerFile); } catch {}
                if (_pushSdkconfigUpdate && termName === 'ESP › Menuconfig') {
                    setTimeout(() => { try { _pushSdkconfigUpdate(); } catch {} }, 300);
                }
                resolve(_exitCode);
            }
        }, 400);
    });
}

function watchBuildResult(markerFile, taskName, root) {
    const started   = Date.now();
    const maxWaitMs = 15 * 60 * 1000;
    return new Promise(resolve => {
    const timer = setInterval(() => {
        if (!terms[taskName] || terms[taskName].exitStatus !== undefined) {
            clearInterval(timer);
            try { fs.unlinkSync(markerFile); } catch {}
            resolve(-1); return;
        }
        if (!fs.existsSync(markerFile)) {
            if (Date.now() - started > maxWaitMs) {
                clearInterval(timer);
                try { fs.unlinkSync(markerFile); } catch {}
                log(`Build marker timed out: ${markerFile}`);
                resolve(-1);
            }
            return;
        }
        clearInterval(timer);
        let _exitCode = -1;
        try {
            _exitCode = parseInt(fs.readFileSync(markerFile, 'utf8').trim(), 10);
            try { fs.unlinkSync(markerFile); } catch {}
            if (_exitCode === 0) {
                const elapsed = Math.round((Date.now() - _lastCmdStartTime) / 1000);
                const timeStr = elapsed >= 60 ? `${Math.floor(elapsed/60)}m ${elapsed%60}s` : `${elapsed}s`;
                const cc = root ? path.join(root, 'build', 'compile_commands.json') : null;
                const hasCc = cc && fs.existsSync(cc);
                const hint = hasCc ? ' IntelliSense updated.' : '';
                vscode.window.showInformationMessage(`✅ ${taskName} completed in ${timeStr}.${hint}`);
                log(`${taskName} ✅ OK`);
                if (_statusBarBuild) {
                    _statusBarBuild.text = '$(check) Build OK';
                    setTimeout(() => { if (_statusBarBuild) _statusBarBuild.text = '$(tools) Build'; }, 4000);
                }
            } else {
                vscode.window.showErrorMessage(
                    `❌ ${taskName} failed (exit ${_exitCode})`, 'Show Output'
                ).then(c => { if (c === 'Show Output') outputChannel?.show(true); });
                log(`${taskName} ❌ failed (exit ${_exitCode})`);
                if (_statusBarBuild) {
                    _statusBarBuild.text = '$(error) Build Failed';
                    setTimeout(() => { if (_statusBarBuild) _statusBarBuild.text = '$(tools) Build'; }, 4000);
                }
            }
        } catch (e) {
            log(`Build marker read error: ${e.message}`);
        }
        resolve(_exitCode);
    }, 400);
    });
}

function buildMarkerCmd(markerFile) {
    if (IS_WIN) {
        return `; if ($LASTEXITCODE -eq 0) { '0' | Out-File -NoNewline -Encoding ASCII ${q(markerFile)} } else { [string]$LASTEXITCODE | Out-File -NoNewline -Encoding ASCII ${q(markerFile)} }`;
    } else {
        // #35: Capture real exit code via $? after ';', so it always runs.
        // Use a unique variable name to avoid collisions with user scripts.
        return `; _esp_exit_code_=$?; printf '%s\\n' "$_esp_exit_code_" > ${q(markerFile)}`;
    }
}

// ─── sdkconfig helpers ────────────────────────────────────────────────────────
function getSdkconfigValue(root, key) {
    const cacheKey = root;
    const files = ['sdkconfig', 'sdkconfig.defaults'];
    let needsRefresh = !_sdkconfigCache || _sdkconfigCache.root !== cacheKey;

    if (!needsRefresh) {
        for (const fname of files) {
            const p = path.join(root, fname);
            try {
                const stat = fs.statSync(p);
                if (!_sdkconfigCache.mtimes[fname] || stat.mtimeMs !== _sdkconfigCache.mtimes[fname]) {
                    needsRefresh = true;
                    break;
                }
            } catch {
                if (_sdkconfigCache.mtimes[fname] !== undefined) {
                    needsRefresh = true;
                    break;
                }
            }
        }
    }

    if (needsRefresh) {
        const data = new Map();
        const mtimes = {};
        for (const fname of files) {
            const p = path.join(root, fname);
            try {
                const stat = fs.statSync(p);
                mtimes[fname] = stat.mtimeMs;
                const content = fs.readFileSync(p, 'utf8');
                for (const line of content.split('\n')) {
                    const eqIdx = line.indexOf('=');
                    if (eqIdx > 0 && !line.startsWith('#')) {
                        const k = line.substring(0, eqIdx).trim();
                        const v = line.substring(eqIdx + 1).trim().replace(/^"|"$/g, '');
                        if (!data.has(k)) data.set(k, v);
                    }
                }
            } catch {}
        }
        _sdkconfigCache = { root: cacheKey, mtimes, data };
    }

    return _sdkconfigCache.data.get(key) || null;
}

function getSdkconfigChoice(root, baseKey, values, def) {
    for (const v of values) {
        const choiceKey = `${baseKey}_${v}`;
        const val = getSdkconfigValue(root, choiceKey);
        if (val === 'y') return String(v);
    }
    const plainVal = getSdkconfigValue(root, baseKey);
    if (plainVal !== null) return plainVal;
    return def;
}

function getPartitionCsvFilename(root) {
    const sdkconfig = path.join(root, 'sdkconfig');
    if (fs.existsSync(sdkconfig)) {
        try {
            const content = fs.readFileSync(sdkconfig, 'utf8');
            // Check CONFIG_PARTITION_TABLE_FILENAME first (covers all partition table types)
            const m = content.match(/^CONFIG_PARTITION_TABLE_FILENAME="(.+)"$/m);
            if (m && m[1]) return m[1].trim();
            // Fallback to custom filename
            const mc = content.match(/^CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="(.+)"$/m);
            if (mc && mc[1]) return mc[1].trim();
        } catch {}
    }
    const sdkconfigDefaults = path.join(root, 'sdkconfig.defaults');
    if (fs.existsSync(sdkconfigDefaults)) {
        try {
            const content = fs.readFileSync(sdkconfigDefaults, 'utf8');
            const m = content.match(/^CONFIG_PARTITION_TABLE_FILENAME="(.+)"$/m);
            if (m && m[1]) return m[1].trim();
            const mc = content.match(/^CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="(.+)"$/m);
            if (mc && mc[1]) return mc[1].trim();
        } catch {}
    }
    return 'partitions.csv';
}

function buildEnvSetCmd(envObj) {
    const entries = Object.entries(envObj);
    if (!entries.length) return '';
    if (IS_WIN) {
        // Trailing '; ' separates env commands from the next command
        return entries.map(([k, v]) => `$env:${k}=${q(String(v))}`).join('; ') + '; ';
    } else {
        // Trailing ' && ' separates env commands from the next command
        return entries.map(([k, v]) => `export ${k}=${q(String(v))}`).join(' && ') + ' && ';
    }
}

module.exports = {
    // Re-exported node modules for convenience
    vscode, path, fs, os, cp,

    // Constants
    IS_WIN, IS_MAC, IS_LINUX, PYTHON_CACHE_TTL, FLASH_SIZE_MAP,

    // State getters
    getTerms, getActiveRoot, getGlobalCtx, getOutputChannel, getPortCache,
    getPythonCmdCache, getPythonCmdTime, getIdfPathOverride, getToolsVerified,
    getSdkVersionCache, getMonitorRunning, getGlobalBusy, getGlobalBusyName,
    getLastCmdStartTime, getProvider, getPartitionPanel, getPushSdkconfigUpdate,
    getSdkconfigCache,
    getStatusBarPort, getStatusBarBusy, getStatusBarBuild, getStatusBarFlash,
    getStatusBarMonitor, getStatusBarClean, getStatusBarMenuconfig,

    // State setters
    setTerms, setActiveRoot, setGlobalCtx, setOutputChannel, setPortCache,
    setPythonCmdCache, setPythonCmdTime, setIdfPathOverride, setToolsVerified,
    setSdkVersionCache, setMonitorRunning, setProvider, setPartitionPanel,
    setPushSdkconfigUpdate, setSdkconfigCache,

    // Internal helpers
    _setStatusBarItems,
    setOnBusyChange: (fn) => { _onBusyChange = fn; },

    // Utility functions
    q, log, cfg, setCfg, expandHome, getValidIdfPath, getSdkVersion,
    warnNoProject, getUserShell, setBusy, clearBusy, checkBusy,
    findXtensaGcc, getTerm, buildCmd, ensureVersionTxt, buildIdfEnvPrefix,
    watchCommandDone, watchBuildResult, buildMarkerCmd, buildEnvSetCmd,
    getSdkconfigValue, getSdkconfigChoice, getPartitionCsvFilename,
};
