'use strict';

const { vscode, path, fs, os,
        IS_WIN,
        log, cfg, setCfg, q,
        getActiveRoot, getValidIdfPath,
        setBusy, clearBusy, checkBusy,
        getTerm, buildCmd, buildMarkerCmd, watchCommandDone, watchBuildResult,
        buildEnvSetCmd, buildIdfEnvPrefix, warnNoProject,
        getMonitorRunning, setMonitorRunning,
        getTerms,
} = require('./helpers');

const { getPythonCmd } = require('./python');
const { cmdSelectPort, confirmPortOrReselect } = require('./ports');
const { refreshMonitorButton } = require('./statusBar');
const { checkToolsOrPrompt } = require('./idfRunner');

// ─── checkPartitionCsv — needed by runIdf, lives here ────────────────────────
async function checkPartitionCsv(root) {
    if (!root) return true;
    const { getPartitionCsvFilename, getSdkconfigValue } = require('./helpers');
    const csvFilename = getPartitionCsvFilename(root);
    const csvPath = path.join(root, csvFilename);

    const isCustom = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_CUSTOM') === 'y';
    if (!isCustom) return true;
    if (fs.existsSync(csvPath)) return true;

    const choice = await vscode.window.showErrorMessage(
        `ESP: Partition table file "${csvFilename}" not found.`,
        'Open Partition Editor',
        'Cancel'
    );
    if (choice === 'Open Partition Editor') {
        vscode.commands.executeCommand('esp.partitionEditor');
    }
    return false;
}

function resolvePostBuildFlashAction(commandKey, postAction) {
    if (postAction === 'none') return null;
    if (postAction === 'flash_bootloader') return 'bootloader-flash';
    if (postAction === 'flash_partition') return 'partition_table-flash';
    // flash or app_flash
    return postAction === 'app_flash' ? 'app-flash' : 'flash';
}

async function runIdf(args, termName, isBuildCommand = false, extraEnvVars = {}, chainArgs = null, onChainStart = null, commandKey = null) {
    if (checkBusy()) return;

    const pythonCmd = await getPythonCmd(true);
    if (!pythonCmd) return;

    const idfPath = getValidIdfPath();
    if (!idfPath) {
        vscode.window.showErrorMessage('ESP: IDF_PATH not set or invalid! Check extension settings.');
        return;
    }

    const toolsOk = await checkToolsOrPrompt(idfPath, pythonCmd);
    if (!toolsOk) return;
    const { checkPythonDeps } = require('./python');
    if (!await checkPythonDeps(idfPath, pythonCmd)) return;

    const root = getActiveRoot();
    if (!root) { warnNoProject(); return; }

    if (isBuildCommand) {
        await vscode.workspace.saveAll(false);
    }

    if (!fs.existsSync(path.join(root, 'CMakeLists.txt')) && !fs.existsSync(path.join(root, 'sdkconfig'))) {
        vscode.window.showErrorMessage('ESP: No CMakeLists.txt or sdkconfig found. Is this an ESP-IDF project?');
        return;
    }

    if (!await checkPartitionCsv(root)) return;

    const envPrefix   = buildIdfEnvPrefix(idfPath, pythonCmd);
    const extraEnvCmd = buildEnvSetCmd(extraEnvVars);
    const idfPy       = path.join(idfPath, 'tools', 'idf.py');

    const quoteArg = a => {
        if (typeof a === 'string' && (a.includes(' ') || (a.includes(path.sep) && !a.startsWith('-')))) return q(a);
        return a;
    };
    const makeIdfCmd = args => `${pythonCmd} ${q(idfPy)} ${args.map(quoteArg).join(' ')}`;

    if (checkBusy()) return;
    setBusy(termName);

    const t = getTerm(termName);
    t.show(true);

    if (isBuildCommand) {
        let buildArgs = [...args];
        const preActionKey = commandKey ? `pre${commandKey}Action` : 'preBuildAction';
        const postActionKey = commandKey ? `post${commandKey}Action` : 'postBuildAction';
        const preAction = cfg(preActionKey);
        if (preAction === 'clean' || preAction === 'fullclean') {
            buildArgs.unshift(preAction);
        }
        // postBuildAnalysis only applies to the main Build command
        if (!commandKey) {
            const analysisCmds = cfg('postBuildAnalysis') || [];
            if (analysisCmds.length > 0) {
                buildArgs.push(...analysisCmds);
            }
        }

        const postAction = cfg(postActionKey);
        const willFlash  = postAction !== 'none';

        if (willFlash) {
            let port = cfg('comPort');
            if (!port) { port = await cmdSelectPort(); if (!port) { clearBusy(); return; } }
            const portHolder = { port };
            const portOk = await confirmPortOrReselect(portHolder);
            if (!portOk) { clearBusy(); return; }
            if (portHolder.port !== cfg('comPort')) await setCfg('comPort', portHolder.port);
        }

        log(`[Call 1] idf.py ${buildArgs.join(' ')}`);

        const idfCmd1 = makeIdfCmd(buildArgs);

        const markerFile = path.join(os.tmpdir(), `esp_bld_${Date.now()}.tmp`);
        const markerSuffix = buildMarkerCmd(markerFile);

        watchBuildResult(markerFile, termName, root).then(exitCode => {
            if (exitCode === 0 && willFlash) {
                const flashAction = resolvePostBuildFlashAction(commandKey, postAction);
                if (!flashAction) { clearBusy(); return; }
                const flasherArgs = path.join(root, 'build', 'flasher_args.json');
                if (!fs.existsSync(flasherArgs)) {
                    vscode.window.showWarningMessage(
                        'ESP: Build succeeded but flasher_args.json is missing — skipping flash. Try running Flash manually.'
                    );
                    clearBusy();
                    return;
                }
                runWithPostFlash(flashAction);
            } else {
                clearBusy();
            }
        }).catch(() => clearBusy());

        if (IS_WIN) {
            t.sendText([`Set-Location ${q(root)}`, envPrefix, extraEnvCmd + idfCmd1].join('; ') + markerSuffix);
        } else {
            t.sendText([`cd ${q(root)}`, envPrefix, extraEnvCmd + idfCmd1].join(' && ') + markerSuffix);
        }
        return;
    }

    let finalArgs = [...args];
    const idfCmd = makeIdfCmd(finalArgs);

    const markerFile2 = path.join(os.tmpdir(), `esp_cmd_${Date.now()}.tmp`);
    const markerSuffix2 = buildMarkerCmd(markerFile2);
    watchCommandDone(markerFile2, termName).finally(() => clearBusy());

    const idfCmd2 = chainArgs ? makeIdfCmd(chainArgs) : null;

    if (args.includes('monitor') && !chainArgs) {
        setMonitorRunning(true);
        refreshMonitorButton();
    }

    if (idfCmd2 && onChainStart) {
        const chainMarker = path.join(os.tmpdir(), `esp_chain_${Date.now()}.tmp`);
        const chainStarted = Date.now();
        const CHAIN_TIMEOUT = 30 * 60 * 1000;

        const chainTimer = setInterval(() => {
            const termGone = !t || t.exitStatus !== undefined;
            const timedOut = Date.now() - chainStarted > CHAIN_TIMEOUT;
            if (termGone || timedOut) {
                clearInterval(chainTimer);
                try { fs.unlinkSync(chainMarker); } catch {}
                return;
            }
            if (fs.existsSync(chainMarker)) {
                clearInterval(chainTimer);
                try { fs.unlinkSync(chainMarker); } catch {}
                onChainStart();
            }
        }, 400);

        const writeChainMarker = IS_WIN
            ? `'0' | Out-File -NoNewline -Encoding ASCII ${q(chainMarker)}`
            : `printf '0\\n' > ${q(chainMarker)}`;

        if (IS_WIN) {
            const second = `; if ($LASTEXITCODE -eq 0) { ${writeChainMarker}; ${idfCmd2} }`;
            t.sendText(`Set-Location ${q(root)}; ${envPrefix}; ${extraEnvCmd}${idfCmd}${second}${markerSuffix2}`);
        } else {
            const second = ` && ${writeChainMarker} && ${idfCmd2}`;
            t.sendText(`cd ${q(root)} && ${envPrefix} && ${extraEnvCmd}${idfCmd}${second}${markerSuffix2}`);
        }
    } else {
        if (IS_WIN) {
            const second = idfCmd2 ? `; if ($LASTEXITCODE -eq 0) { ${idfCmd2} }` : '';
            t.sendText(`Set-Location ${q(root)}; ${envPrefix}; ${extraEnvCmd}${idfCmd}${second}${markerSuffix2}`);
        } else {
            const second = idfCmd2 ? ` && ${idfCmd2}` : '';
            t.sendText(`cd ${q(root)} && ${envPrefix} && ${extraEnvCmd}${idfCmd}${second}${markerSuffix2}`);
        }
    }
}


async function runFlash(action = 'flash', eraseFirst = false) {
    if (checkBusy()) return;

    const pythonCmdFlash = await getPythonCmd(true);
    if (!pythonCmdFlash) return;

    const idfPathFlash = getValidIdfPath();
    if (!idfPathFlash) {
        vscode.window.showErrorMessage('ESP: IDF_PATH not set or invalid! Check extension settings.');
        return;
    }
    const toolsOkFlash = await checkToolsOrPrompt(idfPathFlash, pythonCmdFlash);
    if (!toolsOkFlash) return;
    const rootFlash = getActiveRoot();
    if (!rootFlash) {
        warnNoProject();
        return;
    }

    await vscode.workspace.saveAll(false);

    const overrideFlash = cfg('overrideFlashConfig');
    let flashArgs   = [];
    let extraEnvVars = {};

    let port = cfg('comPort');
    if (!port) {
        port = await cmdSelectPort();
        if (!port) return;
    }
    if (port && !/^[a-zA-Z0-9./\\_-]+$/.test(port)) {
        vscode.window.showErrorMessage('ESP: Invalid port name! Shell metacharacters are not allowed.');
        return;
    }

    if (port) {
        const portHolder = { port };
        const ok = await confirmPortOrReselect(portHolder);
        if (!ok) return;
        port = portHolder.port;
        if (port !== cfg('comPort')) await setCfg('comPort', port);
    }

    // NOTE: --before / --after are esptool.py options, NOT idf.py options.
    // They must NOT be passed to idf.py (causes "No such option" error on
    // ESP8266 RTOS SDK and older ESP-IDF). They are correctly used only in
    // the direct esptool.py call path (cmdFlashFsImage in extension.js).

    if (overrideFlash) {
        const baud        = cfg('flashBaud')           || 115200;
        const mode        = cfg('flashMode')           || 'dio';
        const freq        = cfg('flashFreq')           || '40m';
        const size        = cfg('flashSize')           || '2MB';
        const compressed  = cfg('useCompressedUpload') ?? true;

        flashArgs = [
            '-p', port, '-b', String(baud),
            '--flash_mode', mode, '--flash_freq', freq, '--flash_size', size,
            compressed ? '-z' : '-u',
        ];
    } else if (port) {
        flashArgs = ['-p', port];
    }

    const isMonitor  = action.endsWith('_monitor');
    const baseAction = isMonitor ? action.replace('_monitor', '') : action;
    let args  = [];
    let title = '';

    if (baseAction === 'monitor') {
        if (port) {
            args = ['-p', port, 'monitor'];
        } else {
            args = ['monitor'];
        }
        title = 'ESP › Monitor';
    } else {
        args = eraseFirst
            ? [...flashArgs, 'erase_flash', baseAction]
            : [...flashArgs, baseAction];
        const humanAction = baseAction.replace(/-/g, ' ').replace(/_/g, ' ');
        title = `ESP › ${eraseFirst ? 'Erase & ' : ''}${humanAction.charAt(0).toUpperCase() + humanAction.slice(1)}`;

        if (isMonitor) {
            title += ' & Monitor';
        }
    }

    let monitorChainArgs = null;
    let onChainStart = null;
    if (isMonitor) {
        monitorChainArgs = port
            ? ['-p', port, 'monitor']
            : ['monitor'];
        onChainStart = () => { setMonitorRunning(true); refreshMonitorButton(); };
    }

    const flasherArgsJson = path.join(rootFlash, 'build', 'flasher_args.json');
    if (!fs.existsSync(flasherArgsJson) && baseAction !== 'monitor') {
        vscode.window.showInformationMessage(
            'ESP: build/flasher_args.json not found — running reconfigure first.'
        );
        await runIdf(['reconfigure'], `ESP › Reconfigure → ${title.replace('ESP › ','')}`,
            false, {}, args, () => { if (isMonitor) { setMonitorRunning(true); refreshMonitorButton(); } });
        return;
    }

    await runIdf(args, title, false, extraEnvVars, monitorChainArgs, onChainStart);
}

async function runWithPostFlash(action, commandKey = null) {
    const postActionKey = commandKey ? `post${commandKey}Action` : 'postFlashAction';

    const postAction       = cfg(postActionKey);
    // Erase only applicable for the main Flash command (not App/Bootloader/Partition)
    const eraseFirst       = !commandKey && cfg('preFlashAction') === 'erase';

    const finalAction = (postAction === 'monitor' && !action.endsWith('_monitor'))
        ? action + '_monitor'
        : action;

    return runFlash(finalAction, eraseFirst);
}

function cmdStopMonitor() {
    const { getGlobalBusyName } = require('./helpers');
    if (getGlobalBusyName() && getMonitorRunning()) {
        clearBusy();
    }
    const monitorTermNames = ['ESP › Monitor', 'ESP › Flash & Monitor', 'ESP › Erase & Flash & Monitor', 'ESP › App flash & Monitor', 'ESP › Bootloader flash & Monitor', 'ESP › Partition table flash & Monitor'];
    let found = false;
    const terms = getTerms();
    for (const name of monitorTermNames) {
        const t = terms[name];
        if (t && t.exitStatus === undefined) {
            t.sendText('\x1d', false);
            log(`Sent Ctrl+] to terminal: ${name}`);
            found = true;
        }
    }
    if (!found) {
        vscode.window.showWarningMessage('ESP: No active monitor terminal found.');
    }
    setMonitorRunning(false);
    refreshMonitorButton();
}

module.exports = {
    runIdf, runFlash, runWithPostFlash, cmdStopMonitor, checkPartitionCsv,
};
