'use strict';

const { vscode, path, fs, os,
        IS_WIN,
        log, cfg, setCfg, q,
        getActiveRoot, getValidIdfPath,
        setBusy, clearBusy, checkBusy,
        getTerm, buildCmd, buildMarkerCmd, watchCommandDone, watchBuildResult,
        buildEnvSetCmd, buildIdfEnvPrefix, warnNoProject,
        getMonitorRunning, setMonitorRunning,
        getGlobalBusyName,
        getTerms,
        PORT_NAME_REGEX, MONITOR_TERM_NAMES,
} = require('./helpers');

const { getPythonCmd } = require('./python');
const { cmdSelectPort, confirmPortOrReselect } = require('./ports');
const { refreshMonitorButton } = require('./statusBar');
const { checkToolsOrPrompt } = require('./idfRunner');
const { saveAllDirtyCmakePanels } = require('./cmakeEditor');

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

// #FIX(1.85.0): When "Flash & Monitor" needs a build first, the monitor intent
// must survive the async build→flash transition. The build path in runIdf reads
// this flag and passes it to runWithPostFlash so the monitor step is not dropped.
let _forceMonitorAfterBuildFlash = false;

async function runIdf(args, termName, isBuildCommand = false, extraEnvVars = {}, chainArgs = null, onChainStart = null, commandKey = null, _alreadyBusy = false) {
    // #FIX(1.85.0): When runIdf is called from runFlash (which already acquired
    // the busy lock to close the checkBusy→setBusy race window), skip the
    // checkBusy() guard — otherwise runIdf would see its own caller's lock and
    // bail out immediately, leaving the busy state stuck forever ("ESP > flash_monitor
    // is running. Wait for it to finish." with nothing actually running).
    if (!_alreadyBusy && checkBusy()) return;
    // #FIX: Set busy IMMEDIATELY after check — no async gap.
    // Previously setBusy was called ~40 lines below after multiple await's,
    // allowing a second click to race through between checkBusy() and setBusy().
    // When _alreadyBusy is true, setBusy() here just refreshes the name to the
    // more specific termName (e.g. "ESP › Flash & Monitor").
    setBusy(termName);

    const pythonCmd = await getPythonCmd(true);
    if (!pythonCmd) { clearBusy(); return; }

    const idfPath = getValidIdfPath();
    if (!idfPath) {
        clearBusy();
        vscode.window.showErrorMessage('ESP: IDF_PATH not set or invalid! Check extension settings.');
        return;
    }

    const toolsOk = await checkToolsOrPrompt(idfPath, pythonCmd);
    if (!toolsOk) {
        // #FIX(1.85.0): Don't clear the busy lock if checkToolsOrPrompt started a
        // background tool install — the install's own completion handler clears it.
        // Previously runIdf cleared the lock here, allowing concurrent commands to
        // collide with the in-progress install.
        if (getGlobalBusyName() !== 'Installing Tools') clearBusy();
        return;
    }
    const { checkPythonDeps } = require('./python');
    if (!await checkPythonDeps(idfPath, pythonCmd)) { clearBusy(); return; }

    const root = getActiveRoot();
    if (!root) { clearBusy(); warnNoProject(); return; }

    if (isBuildCommand) {
        // #FIX: Auto-save all dirty CMake editor panels before build.
        // If the user edited CMakeLists.txt in the webview but didn't click Save,
        // the build would use stale data from disk. This ensures the on-disk file
        // matches the webview state before the build starts.
        await saveAllDirtyCmakePanels();
        await vscode.workspace.saveAll(false);
    }

    if (!fs.existsSync(path.join(root, 'CMakeLists.txt')) && !fs.existsSync(path.join(root, 'sdkconfig'))) {
        clearBusy();
        vscode.window.showErrorMessage('ESP: No CMakeLists.txt or sdkconfig found. Is this an ESP8266-IDF project?');
        return;
    }

    if (!await checkPartitionCsv(root)) { clearBusy(); return; }

    const envPrefix   = buildIdfEnvPrefix(idfPath, pythonCmd);
    const extraEnvCmd = buildEnvSetCmd(extraEnvVars);
    const idfPy       = path.join(idfPath, 'tools', 'idf.py');

    const quoteArg = a => {
        if (typeof a === 'string' && (a.includes(' ') || (a.includes(path.sep) && !a.startsWith('-')))) return q(a);
        return a;
    };
    const makeIdfCmd = args => `${pythonCmd} ${q(idfPy)} ${args.map(quoteArg).join(' ')}`;

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
                // #FIX: Must clearBusy() before runWithPostFlash, because runFlash()
                // starts with checkBusy() which would block if busy lock is still held.
                clearBusy();
                // #FIX(1.85.0): Pass the flash commandKey so per-command post-flash
                // settings (postFlashAppAction, etc.) are honored, and a pending
                // monitor intent from a Flash&Monitor-that-needed-build is preserved.
                const flashCommandKey = commandKey ? commandKey.replace('Build', 'Flash') : null;
                const forceMonitor = _forceMonitorAfterBuildFlash;
                _forceMonitorAfterBuildFlash = false;
                runWithPostFlash(flashAction, flashCommandKey, forceMonitor)
                    .catch(e => log(`post-build flash error: ${e && e.message || e}`));
            } else {
                _forceMonitorAfterBuildFlash = false; // build failed or no flash — consume flag
                clearBusy();
            }
        }).catch(() => { _forceMonitorAfterBuildFlash = false; clearBusy(); });

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
    // #FIX(1.85.0): Reset monitor state when a monitor command finishes (exits).
    // For chained commands (e.g. flash_monitor), the monitor lives in chainArgs,
    // so also inspect chainArgs — previously the flag stayed "running" after the
    // user exited the monitor with Ctrl+].
    const isMonitorCmd = finalArgs[finalArgs.length - 1] === 'monitor'
        || (Array.isArray(chainArgs) && chainArgs.includes('monitor'));
    const mainWatchPromise = watchCommandDone(markerFile2, termName);
    mainWatchPromise.finally(() => {
        clearBusy();
        if (isMonitorCmd) {
            setMonitorRunning(false);
            refreshMonitorButton();
        }
    });

    const idfCmd2 = chainArgs ? makeIdfCmd(chainArgs) : null;

    // #FIX: Use exact match for last arg instead of .includes() to avoid
    // false positive with e.g. "monitor-test" subcommand
    if (finalArgs[finalArgs.length - 1] === 'monitor' && !chainArgs) {
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
        // #FIX(1.85.1): Reuse mainWatchPromise instead of creating a second
        // watchCommandDone call for the same markerFile. Previously, the
        // second call polled the same file every 400ms; when the first call
        // found and deleted the marker, the second would spin for up to 30
        // minutes until terminal exit or timeout — a polling leak.
        mainWatchPromise.then(() => clearInterval(chainTimer)).catch(() => clearInterval(chainTimer));

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
    // #FIX(1.85.0): Set busy immediately to close the race window between
    // checkBusy() and the eventual setBusy() inside runIdf. Multiple awaits
    // (getPythonCmd, checkToolsOrPrompt, saveAll, cmdSelectPort, ...) happen
    // before runIdf is reached; a second click could slip through before.
    // Every early-return path below clears the lock.
    setBusy(`ESP › ${action}`);

    const pythonCmdFlash = await getPythonCmd(true);
    if (!pythonCmdFlash) { clearBusy(); return; }

    const idfPathFlash = getValidIdfPath();
    if (!idfPathFlash) {
        clearBusy();
        vscode.window.showErrorMessage('ESP: IDF_PATH not set or invalid! Check extension settings.');
        return;
    }
    const toolsOkFlash = await checkToolsOrPrompt(idfPathFlash, pythonCmdFlash);
    if (!toolsOkFlash) {
        // #FIX(1.85.0): Don't clear if a background tool install is running.
        if (getGlobalBusyName() !== 'Installing Tools') clearBusy();
        return;
    }
    const rootFlash = getActiveRoot();
    if (!rootFlash) {
        clearBusy();
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
        if (!port) { clearBusy(); return; }
    }
    if (port && !PORT_NAME_REGEX.test(port)) {
        clearBusy();
        vscode.window.showErrorMessage('ESP: Invalid port name! Shell metacharacters are not allowed.');
        return;
    }

    if (port) {
        const portHolder = { port };
        const ok = await confirmPortOrReselect(portHolder);
        if (!ok) { clearBusy(); return; }
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
        // #FIX: Use 'build' instead of 'reconfigure' — reconfigure only regenerates
        // CMake config files but does NOT produce flasher_args.json. A build is
        // required to generate it. After build completes, the post-build flash
        // action (if any) will handle the rest.
        vscode.window.showInformationMessage(
            'ESP: build/flasher_args.json not found — building project first.'
        );
        // Determine post-build action that leads to the intended flash command
        let postBuildAction = 'none';
        if (baseAction === 'flash') {
            // #FIX(1.85.0): Both branches were identical ('flash'), discarding the
            // monitor intent. The monitor is now preserved via _forceMonitorAfterBuildFlash.
            postBuildAction = 'flash';
        } else if (baseAction === 'app-flash') {
            postBuildAction = 'app_flash';
        } else if (baseAction === 'bootloader-flash') {
            postBuildAction = 'flash_bootloader';
        } else if (baseAction === 'partition_table-flash') {
            postBuildAction = 'flash_partition';
        } else {
            // For any other action, just build — user can flash manually
            postBuildAction = 'none';
        }

        // Build the command key for per-command settings
        let commandKey = null;
        if (baseAction === 'flash') commandKey = 'Build';
        else if (baseAction === 'app-flash') commandKey = 'BuildApp';
        else if (baseAction === 'bootloader-flash') commandKey = 'BuildBootloader';
        else if (baseAction === 'partition_table-flash') commandKey = 'BuildPartition';

        // Temporarily set the post-build action so the build path triggers flash after
        const savedPostAction = commandKey ? cfg(`post${commandKey}Action`) : cfg('postBuildAction');
        if (postBuildAction !== 'none') {
            const actionKey = commandKey ? `post${commandKey}Action` : 'postBuildAction';
            await setCfg(actionKey, postBuildAction);
        }

        // If flash+monitor, set monitor state after flash starts
        const buildOnChainStart = isMonitor
            ? () => { setMonitorRunning(true); refreshMonitorButton(); }
            : null;

        // #FIX(1.85.0): Signal the build path to chain a monitor after the post-build
        // flash. The flag is consumed by runWithPostFlash (called from runIdf's build
        // path once the build succeeds). Without this, "Flash & Monitor" silently ran
        // a plain flash with no monitor when a build was required first.
        if (isMonitor) _forceMonitorAfterBuildFlash = true;

        // Run build — the post-build action will auto-flash
        // #FIX(1.85.0): _alreadyBusy=true — runFlash already holds the busy lock.
        await runIdf(['build'], `ESP › Build → ${title.replace('ESP › ','')}`,
            true, {}, null, buildOnChainStart, commandKey, true);

        // Restore original post-build action
        if (postBuildAction !== 'none') {
            const actionKey = commandKey ? `post${commandKey}Action` : 'postBuildAction';
            await setCfg(actionKey, savedPostAction || 'none');
        }
        return;
    }

    // #FIX(1.85.0): _alreadyBusy=true — runFlash already holds the busy lock to
    // close the race window; runIdf must not re-check/re-acquire it.
    await runIdf(args, title, false, extraEnvVars, monitorChainArgs, onChainStart, null, true);
}

async function runWithPostFlash(action, commandKey = null, forceMonitor = false) {
    const postActionKey = commandKey ? `post${commandKey}Action` : 'postFlashAction';

    const postAction       = cfg(postActionKey);
    // #FIX(1.85.1): preFlashAction='erase' now applies to ALL flash subtypes
    // (flash, app-flash, bootloader-flash, partition_table-flash), not just
    // the full 'flash' command. The setting description says "Action before
    // flashing" without limiting it to one subtype.
    const eraseFirst       = cfg('preFlashAction') === 'erase';

    // #FIX(1.85.0): Honor a pending monitor intent from a Flash & Monitor that
    // needed a build first (forceMonitor flag), in addition to the user's
    // postFlashAction setting.
    const wantMonitor = forceMonitor || postAction === 'monitor';
    const finalAction = (wantMonitor && !action.endsWith('_monitor'))
        ? action + '_monitor'
        : action;

    return runFlash(finalAction, eraseFirst);
}

function cmdStopMonitor() {
    const { getGlobalBusyName } = require('./helpers');
    // #FIX: Only clearBusy if the busy task IS the monitor itself.
    // During flash_monitor, busy is held during the FLASH phase — clearing
    // it would allow another command to start while flash is still running.
    const busyName = getGlobalBusyName();
    if (busyName && getMonitorRunning()) {
        const isMonitorOnlyTask = busyName === 'ESP › Monitor';
        if (isMonitorOnlyTask) {
            clearBusy();
        }
    }
    const monitorTermNames = MONITOR_TERM_NAMES;
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
