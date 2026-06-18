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
let _buildStatusTimer  = null;

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

// Shared regex for port name validation (used by flash.js, otaFlash.js, extension.js, ports.js)
const PORT_NAME_REGEX = /^[a-zA-Z0-9./\\_-]+$/;

// Shared constant: terminal names used for monitor commands
const MONITOR_TERM_NAMES = [
    'ESP › Monitor', 'ESP › Flash & Monitor', 'ESP › Erase & Flash & Monitor',
    'ESP › App flash & Monitor', 'ESP › Bootloader flash & Monitor', 'ESP › Partition table flash & Monitor',
];

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
const setActiveRoot       = (v, autoOpenMain = true) => {
    const prev = activeRoot;
    activeRoot = v;
    // Auto-open the main source file when the project folder changes (not on startup restore)
    // ESP8266 RTOS SDK does NOT require the file to be named "main.c" — the filename
    // is defined in main/CMakeLists.txt (SRCS "filename.c"). We parse the CMake file
    // to find the first registered .c/.cpp source. Fallback: main/main.c
    if (autoOpenMain && v && v !== prev) {
        try {
            const srcFile = _findMainSourceFile(v);
            if (srcFile) {
                vscode.workspace.openTextDocument(srcFile).then(doc => {
                    vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
                    log(`[setActiveRoot] Auto-opened ${srcFile}`);
                }, err => {
                    log(`[setActiveRoot] Failed to open ${srcFile}: ${err.message}`);
                });
            }
        } catch (e) {
            log(`[setActiveRoot] Error finding main source: ${e.message}`);
        }
    }
};

/**
 * Find the source file containing app_main() in the project.
 * app_main is the universal entry point for ESP-IDF / ESP8266 RTOS SDK projects.
 *
 * Search order:
 * 1. Parse main/CMakeLists.txt SRCS — check each registered .c/.cpp file for "app_main"
 * 2. Scan main/ directory for any .c/.cpp file containing "app_main"
 * 3. Fallback: main/main.c if it exists
 */
function _findMainSourceFile(root) {
    const mainDir = path.join(root, 'main');
    if (!fs.existsSync(mainDir)) return null;

    const srcExtensions = /\.(c|cpp|cc|cxx)$/i;

    // Helper: check if a file contains "app_main"
    const hasAppMain = (filePath) => {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            return /\bapp_main\s*\(/.test(content);
        } catch { return false; }
    };

    // 1. Parse CMakeLists.txt SRCS — check each file for app_main
    const cmakePath = path.join(mainDir, 'CMakeLists.txt');
    if (fs.existsSync(cmakePath)) {
        try {
            const content = fs.readFileSync(cmakePath, 'utf8');
            const srcsMatch = content.match(/SRCS\s+([^)]+)/i);
            if (srcsMatch) {
                const srcs = srcsMatch[1];
                // Extract ALL quoted .c/.cpp filenames from SRCS
                const allSrcs = [];
                const re = /"([^"]+\.(c|cpp|cc|cxx))"/gi;
                let m;
                while ((m = re.exec(srcs)) !== null) {
                    allSrcs.push(m[1]);
                }
                // Check each for app_main
                for (const srcName of allSrcs) {
                    const srcPath = path.join(mainDir, srcName);
                    if (fs.existsSync(srcPath) && hasAppMain(srcPath)) return srcPath;
                }
                // If none has app_main, return the first SRCS file that exists
                for (const srcName of allSrcs) {
                    const srcPath = path.join(mainDir, srcName);
                    if (fs.existsSync(srcPath)) return srcPath;
                }
            }
        } catch (e) {
            log(`[findMainSourceFile] Failed to parse ${cmakePath}: ${e.message}`);
        }
    }

    // 2. Scan main/ for any .c/.cpp file containing app_main
    try {
        const entries = fs.readdirSync(mainDir);
        for (const entry of entries) {
            if (!srcExtensions.test(entry)) continue;
            const fullPath = path.join(mainDir, entry);
            if (hasAppMain(fullPath)) return fullPath;
        }
    } catch (e) {
        log(`[findMainSourceFile] Failed to scan ${mainDir}: ${e.message}`);
    }

    // 3. Fallback: main/main.c
    const fallback = path.join(mainDir, 'main.c');
    if (fs.existsSync(fallback)) return fallback;

    return null;
}
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
            // #FIX(1.85.1): In cmd.exe, backslashes before the closing quote
            // must be escaped. The previous regex `/\\(?=")/g` only matched
            // backslashes before a quote INSIDE the string, but the closing
            // quote is added AFTER the replacement. Now we also escape any
            // trailing backslash that would end up directly before the closing
            // quote. Double internal quotes as well.
            let escaped = p.replace(/\\/g, (m, offset) => {
                // If this backslash is the last char or followed only by backslashes
                // until end-of-string, it needs doubling (it'll precede the closing ")
                const tail = p.slice(offset);
                if (/^\\+$/.test(tail)) return '\\\\';
                return '\\';
            }).replace(/"/g, '""');
            return `"${escaped}"`;
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

    // 1. git describe --tags (works for git clones)
    try {
        const gitDescribe = cp.execSync('git describe --tags --always', {
            cwd: idfPath,
            timeout: 3000,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        if (gitDescribe && /^v?\d+/.test(gitDescribe)) version = gitDescribe;
    } catch {}

    // 2. version.txt (written by ensureVersionTxt or manually)
    if (!version) {
        try {
            const versionFile = path.join(idfPath, 'version.txt');
            if (fs.existsSync(versionFile)) {
                const txt = fs.readFileSync(versionFile, 'utf8').trim();
                if (txt && /^v?\d+\.\d+/.test(txt)) version = txt;
            }
        } catch {}
    }

    // 3. Extract from SDK folder name (e.g. ESP8266_RTOS_SDK-v3.4)
    if (!version) {
        const folderName = path.basename(idfPath);
        const folderMatch = folderName.match(/[-_](v?\d+\.\d+(?:\.\d+)?(?:-\w+)?)/i);
        if (folderMatch) {
            version = folderMatch[1].startsWith('v') ? folderMatch[1] : 'v' + folderMatch[1];
        }
    }

    // 4. CMakeLists.txt IDF_VERSION_MAJOR/MINOR/PATCH
    if (!version) {
        try {
            const cmakeFile = path.join(idfPath, 'CMakeLists.txt');
            if (fs.existsSync(cmakeFile)) {
                const cmake = fs.readFileSync(cmakeFile, 'utf8');
                const major = cmake.match(/IDF_VERSION_MAJOR\s+(\d+)/);
                const minor = cmake.match(/IDF_VERSION_MINOR\s+(\d+)/);
                const patch = cmake.match(/IDF_VERSION_PATCH\s+(\d+)/);
                if (major && minor) {
                    version = `v${major[1]}.${minor[1]}`;
                    if (patch) version += `.${patch[1]}`;
                }
            }
        } catch {}
    }

    // 5. git branch name as last resort
    if (!version) {
        try {
            const gitBranch = cp.execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: idfPath,
                timeout: 3000,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
            if (gitBranch) {
                const verMatch = gitBranch.match(/(v?\d+\.\d+(?:\.\d+)?)/);
                if (verMatch) version = verMatch[1].startsWith('v') ? verMatch[1] : 'v' + verMatch[1];
            }
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
    // #FIX: Only update _lastCmdStartTime for build-related commands.
    // For flash/monitor/OTA commands, the elapsed time is not meaningful
    // as "build time" and would mislead users.
    if (/build|reconfigure|clean/i.test(name)) {
        _lastCmdStartTime = Date.now();
    }
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
    // #FIX: Always set a valid CWD for the terminal. Without this, VS Code
    // defaults to the first workspace folder — if that folder was deleted or
    // renamed, the terminal fails to launch with "Starting directory does not exist".
    const cwd = _resolveTermCwd();
    if (cwd) options.cwd = cwd;
    const t = vscode.window.createTerminal(options);
    terms[name] = t;
    return t;
}

// Resolve a guaranteed-valid CWD for terminal creation.
// Priority: active project root → first existing workspace folder → home dir.
function _resolveTermCwd() {
    // 1. Active project root (already validated by getActiveRoot via fs.existsSync)
    const activeRoot = getActiveRoot();
    if (activeRoot) return vscode.Uri.file(activeRoot);

    // 2. First workspace folder that still exists on disk
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
        for (const f of folders) {
            try { if (fs.existsSync(f.uri.fsPath)) return f.uri; } catch {}
        }
    }

    // 3. Home directory — always valid, terminal will at least launch
    return vscode.Uri.file(os.homedir());
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
// The Python builder (idf.py) requires version.txt in the SDK root with the
// SDK version string, e.g. "v3.4". If the file is missing or contains garbage,
// we write "v3.4" as the default — this is the ESP8266 RTOS SDK version this
// extension is built for.
function ensureVersionTxt(idfPath) {
    if (!idfPath || !fs.existsSync(idfPath)) return;
    const versionFile = path.join(idfPath, 'version.txt');

    let needsWrite = false;
    if (!fs.existsSync(versionFile)) {
        needsWrite = true;
    } else {
        const content = fs.readFileSync(versionFile, 'utf8').trim();
        needsWrite = !/^v\d+\.\d+/.test(content);
    }

    if (needsWrite) {
        try {
            // #FIX(1.85.0): Use the real detected SDK version instead of a hardcoded
            // "v3.4". Previously this overwrote version.txt with the wrong value for
            // users on v3.3 or v3.4-rc1 on every activation.
            const ver = getSdkVersion(idfPath) || 'v3.4';
            fs.writeFileSync(versionFile, ver);
            log(`[version.txt] Written '${ver}' to: ${versionFile}`);
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
        // #FIX(1.85.0): Branch on the configured shell. Previously this always
        // emitted PowerShell syntax (`$env:IDF_PATH=...`), so users who configured
        // cmd.exe as their shell got an unset IDF_PATH and a broken build.
        if (getUserShell().toLowerCase().includes('cmd')) {
            // cmd.exe: set IDF_PATH, then apply idf_tools.py key-value export via
            // for /f. The outer double quotes inside in('...') are required by
            // cmd.exe for /f when the command string itself contains quotes.
            // PowerShell is recommended for SDK/Python paths containing spaces.
            // #FIX(1.85.1): Removed stray double-quote after 2^>nul — the
            // trailing '"' before the closing single-quote broke cmd.exe parsing,
            // leaving the for /f in('...') clause with an unmatched quote and
            // preventing idf_tools.py environment variables from being set.
            return `set "IDF_PATH=${idfPath}" & for /f "tokens=1,* delims==" %i in ('"${py}" "${idfToolsPy}" export --format key-value 2^>nul') do @set "%i=%j"`;
        }
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
                    if (_buildStatusTimer) clearTimeout(_buildStatusTimer);
                    _buildStatusTimer = setTimeout(() => {
                        _buildStatusTimer = null;
                        // #FIX(1.85.0): Guard against the item being disposed during deactivation.
                        try { if (_statusBarBuild) _statusBarBuild.text = '$(tools) Build'; } catch {}
                    }, 4000);
                }
            } else {
                vscode.window.showErrorMessage(
                    `❌ ${taskName} failed (exit ${_exitCode})`, 'Show Output'
                ).then(c => { if (c === 'Show Output') outputChannel?.show(true); });
                log(`${taskName} ❌ failed (exit ${_exitCode})`);
                if (_statusBarBuild) {
                    _statusBarBuild.text = '$(error) Build Failed';
                    if (_buildStatusTimer) clearTimeout(_buildStatusTimer);
                    _buildStatusTimer = setTimeout(() => {
                        _buildStatusTimer = null;
                        // #FIX(1.85.0): Guard against the item being disposed during deactivation.
                        try { if (_statusBarBuild) _statusBarBuild.text = '$(tools) Build'; } catch {}
                    }, 4000);
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
        // #FIX(1.85.0): Branch on the configured shell. Previously this always
        // emitted PowerShell syntax (`; if ($LASTEXITCODE ...)`), which cmd.exe
        // cannot parse — so the marker file was never written and watchCommandDone
        // timed out after 30 minutes for cmd.exe users.
        if (getUserShell().toLowerCase().includes('cmd')) {
            // cmd.exe: `call echo %^errorlevel%` forces re-evaluation of
            // %errorlevel% AFTER the preceding command runs (the ^ escapes the
            // first parse pass; `call` triggers the second, post-command pass).
            return ` & call echo %^errorlevel% >${q(markerFile)}`;
        }
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
        // #FIX(1.85.1): Branch on configured shell — same class of bug as
        // buildIdfEnvPrefix/pipInstallReqsParts. `$env:KEY=value` is PowerShell
        // syntax; cmd.exe needs `set "KEY=value"`.
        if (getUserShell().toLowerCase().includes('cmd')) {
            return entries.map(([k, v]) => `set "${k}=${String(v).replace(/"/g, '""')}"`).join(' && ') + ' && ';
        }
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
    IS_WIN, IS_MAC, IS_LINUX, PYTHON_CACHE_TTL, FLASH_SIZE_MAP, PORT_NAME_REGEX, MONITOR_TERM_NAMES,

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
    // #FIX(1.85.0): Clear module-level timers so they cannot fire on a deactivated extension.
    disposeTimers: () => {
        if (_buildStatusTimer) { clearTimeout(_buildStatusTimer); _buildStatusTimer = null; }
    },

    // Utility functions
    q, log, cfg, setCfg, expandHome, getValidIdfPath, getSdkVersion,
    warnNoProject, getUserShell, setBusy, clearBusy, checkBusy,
    findXtensaGcc, getTerm, buildCmd, ensureVersionTxt, buildIdfEnvPrefix,
    watchCommandDone, watchBuildResult, buildMarkerCmd, buildEnvSetCmd,
    getSdkconfigValue, getSdkconfigChoice, getPartitionCsvFilename,
};
