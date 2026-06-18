# Changelog

## 1.85.1

### Bug Fixes

**Critical:**
- **helpers.js**: Fixed `buildIdfEnvPrefix()` cmd.exe branch — a stray double-quote after `2^>nul` inside the `for /f in('...')` clause broke cmd.exe parsing, preventing `idf_tools.py export` environment variables from being set. Users with `shellPath = cmd.exe` could not build at all because IDF_PATH and tool paths were never applied to the terminal session
- **helpers.js**: Fixed `buildEnvSetCmd()` always emitting PowerShell syntax (`$env:KEY=value`) on Windows regardless of the configured shell. cmd.exe users would get broken environment variable commands. Now branches on `shellPath` like `buildIdfEnvPrefix()` and `pipInstallReqsParts()` already do

**High:**
- **helpers.js**: Fixed `q()` path quoting for cmd.exe — trailing backslashes in paths (e.g. `C:\ESP\`) were not escaped before the closing quote, causing cmd.exe to interpret `\"` as an escaped quote rather than a backslash before the string terminator. The quote would remain unclosed, breaking any command using such paths
- **python.js**: Replaced `cp.exec()` with `cp.execFile()` in `checkPythonDeps()` and `checkPip()` — consistent with the shell-injection fix applied to `otaFlash.js`/`idfRunner.js` in v1.85.0. String interpolation into `cp.exec()` allows shell metacharacters in Python/SDK paths to be interpreted by the shell; `cp.execFile()` bypasses the shell entirely

**Medium:**
- **settingsEditor.js**: Added `</script`-escape to `{{INITIAL_SETTINGS}}` template replacement — consistent with the `_JSON` suffixed placeholder security model introduced in v1.84.0. Without this, a settings value containing `</script>` would break the webview's `<script>` block
- **flash.js**: Fixed duplicate `watchCommandDone()` call for chained commands (e.g. Flash & Monitor) — the second call for the same marker file polled every 400ms for up to 30 minutes after the first call found and deleted the marker, leaking a polling interval. Now reuses the same Promise reference
- **flash.js**: Fixed `preFlashAction='erase'` only applying to the full `flash` command — now applies to all flash subtypes (app-flash, bootloader-flash, partition_table-flash) as the setting description implies

## 1.85.0

### Bug Fixes

**Critical:**
- **flash.js**: Fixed a regression introduced by the `runFlash` race-window fix where pressing Flash / Flash & Monitor / Monitor / Erase Flash would show `"ESP > flash_monitor is running. Wait for it to finish."` even though nothing was actually running. `runFlash` now acquires the busy lock immediately (to close the race), but `runIdf` was rejecting the call via its own `checkBusy()` guard — seeing its own caller's lock and bailing out, leaving the busy state stuck forever. Added an `_alreadyBusy` parameter to `runIdf`: when `runFlash` calls it, the guard is skipped (the lock is already held and `setBusy` just refreshes the name to the more specific terminal title)
- **extension.js**: Fixed `cmdFlashFsImage` releasing the busy lock while the filesystem image was still being written to flash — `watchCommandDone(...).then().catch()` was neither `await`ed nor `return`ed, so the `finally` block ran synchronously and called `clearBusy()` before esptool finished. This allowed concurrent Build/Erase/Flash commands to collide on the serial port. Now the watch promise is properly awaited
- **cmakeEditor.js + cmake-editor.html**: Fixed auto-save of dirty CMake editor panels before build being a no-op — the host posted `requestSave` to the webview, but the HTML had no handler for it, so the 3-second timeout always fired and unsaved CMakeLists.txt edits were silently ignored at build time. Added a `requestSave` message handler in `cmake-editor.html` that invokes the existing `save()` function
- **packaging**: Fixed version mismatch between `package.json` (1.84.3) and the embedded `extension.vsixmanifest` (1.84.0) — the .vsix was not re-packaged with `vsce package` after the version bump. Also fixed the `changelog.md` asset path case mismatch (manifest referenced lowercase `changelog.md` while the file on disk was `CHANGELOG.md`), which made the Changelog tab empty on case-sensitive filesystems (Linux)

**High:**
- **statusBar.js**: Fixed the Monitor status-bar button being invisible on startup — `refreshMonitorButton()` was called before `_setStatusBarItems(...)` populated the module-level reference, so it returned early and never called `.show()`. The button only appeared after the user started/stopped a monitor. Now the call order is correct
- **flash.js**: Fixed `runIdf` clearing the busy lock prematurely when `checkToolsOrPrompt` launched a background tool install — the install's own completion handler is now responsible for clearing the lock
- **flash.js**: Fixed "Flash & Monitor" silently dropping the monitor step when a build was required first — both branches of `postBuildAction = isMonitor ? 'flash' : 'flash'` were identical and the build path ignored `chainArgs`. Now the original action is preserved across the build→flash chain
- **extension.js**: Fixed leaked TreeView event-listener disposables — `onDidCollapseElement`/`onDidExpandElement`/`onDidChangeCheckboxState` return values were dropped instead of being pushed to `ctx.subscriptions`, causing duplicate handlers and a checkbox write-queue that kept firing after deactivation
- **helpers.js**: Fixed `buildIdfEnvPrefix()` and `buildMarkerCmd()` always emitting PowerShell syntax on Windows even when the user configured `cmd.exe` as the shell — the terminal received `$env:IDF_PATH=...` / `; if ($LASTEXITCODE ...)` which cmd.exe cannot parse, so `IDF_PATH` was never set and the marker file was never written, hanging `watchCommandDone` for 30 minutes. Now cmd.exe-compatible variants are emitted
- **components.js**: Fixed `readExcludedComponentsFromText` silently dropping component exclusions for multi-line `set(EXCLUDE_COMPONENTS ...)` forms — the trailing `\s` in the regex required a whitespace character immediately after the name, so `set(EXCLUDE_COMPONENTS\n  foo\n  bar)` was not detected. Changed to `\b`
- **python.js**: Fixed `pipInstallReqsParts` unconditionally emitting PowerShell `$env:IDF_PATH=...` on Windows, breaking Python-requirements installation for cmd.exe users. Now branches on the configured shell
- **python.js**: Fixed `checkPip` permanently locking the busy state if terminal creation threw — `setBusy('Install pip')` was called before `getTerm(...)` with no `try/finally`, and the function is invoked fire-and-forget, so the exception was swallowed but the lock remained. Now wrapped in `try/finally`

**Medium:**
- **flash.js**: Fixed `runWithPostFlash` being called without `commandKey` (ignoring per-command `postFlashAppAction`/`postFlashBootloaderAction`/`postFlashPartitionAction` settings) and without `await` (potential unhandled rejection) in the build→flash path
- **flash.js**: Fixed `preFlashAction='erase'` being ignored for the direct `esp.flash` command — the `!commandKey` guard was always false because `commandKey='Flash'`
- **flash.js**: Fixed `esp.monitorRunning` context key and the Monitor status-bar button getting stuck in the "running" state after `flash_monitor` — the `isMonitorCmd` check only inspected `finalArgs`, but for chained commands the monitor lives in `chainArgs`
- **flash.js**: Fixed `chainTimer` (`setInterval`) leaking for up to 30 minutes when the first command in a chain failed and the chain marker was never written
- **flash.js**: Fixed `runFlash` not calling `setBusy()` before its initial `await`s, leaving a race window between `checkBusy()` and the lock being set
- **idfRunner.js**: Fixed `checkToolsOrPrompt`/`checkAndInstallTools` treating a failed `idf_tools.py` spawn (e.g. python ENOENT) as "tools verified OK" — the `err` argument from `cp.execFile` was ignored, so any non-"tools missing" failure marked tools as verified and proceeded to a confusing build failure
- **idfRunner.js**: Fixed PowerShell `buildCmd` joining install steps with `;` (which does not check `$LASTEXITCODE`) instead of `; if ($LASTEXITCODE -eq 0) { ... }`, allowing a failed `idf_tools.py install` to be masked by a successful `pip install`
- **cmakeEditor.js**: Fixed `onDidReceiveMessage` handler leaking on every 3-second auto-save timeout — the handler is now disposed in the timeout callback
- **otaFlash.js**: Fixed `cmdOtaErase` "active slot" detection — the regex expected `Active slot: OTA_N` in `otatool.py read_otadata` output, but that command prints raw otadata seq/crc fields, so the safety warning against erasing the active boot slot was dead code. Now parses the otadata seq values to determine the active slot
- **otaFlash.js**: Fixed contradictory OTA-mode guidance — the error hint told users the device must be in run mode, while the confirmation dialog correctly required download mode. OTA via `otatool.py` requires download mode; the misleading hint was corrected
- **components.js**: Fixed comment stripping corrupting multi-line `set(EXCLUDE_COMPONENTS ...)` values — comments are now stripped per original line before joining
- **components.js**: Fixed `writeExcludedComponents` silently dropping the exclusion list when CMakeLists.txt had neither the `include($ENV{IDF_PATH}...project.cmake)` anchor nor a `project(` line — the old `set(...)` was already removed. Now falls back to appending at EOF
- **components.js**: Hardened `cmdEditComponent` against webview-supplied `compDir` path traversal — the component directory is now always re-derived server-side from the project root and original component name
- **extension.js / helpers.js**: Fixed `_autoGenTimer`, the 500 ms startup `setTimeout`, and `_buildStatusTimer` not being cleared in `deactivate()` — they could fire on a deactivated extension. Now cleared on deactivation
- **extension.js**: Fixed `onDidChangeWorkspaceFolders` auto-falling back to `current[0]` without validating it is an ESP8266-IDF project — now prefers the first remaining folder that passes `_checkEspProject`

**Low:**
- **helpers.js**: Fixed `ensureVersionTxt` hardcoding `v3.4` instead of using the existing `getSdkVersion(idfPath)` detection chain, which overwrote `version.txt` with the wrong value for users on v3.3 or v3.4-rc1
- **extension.js**: Removed unused `getProvider`/`getMonitorRunning` imports
- **package.json**: Removed dead config keys `esp8266-idf.monitorBaud`, `esp8266-idf.preFlashAppAction`, `esp8266-idf.preFlashBootloaderAction`, `esp8266-idf.preFlashPartitionAction` that were declared but never read by any source file
- **components.js**: Hardened webview JSON injection — `{{AVAILABLE_COMPONENTS}}`/`{{PROJECT_ROOT}}` placeholders now escape `</` and `"` to prevent XSS via component folder names containing `</script>`
- **partitionEditor.js**: Added missing `localResourceRoots` restriction (the other editors already restrict to the media directory)
- **partitionEditor.js / cmakeEditor.js**: Fixed `String.replace('{{...}}', data)` interpreting `$&`/`` $` ``/`$'` specially in JSON user data, corrupting the HTML. Now uses function replacements
- **cmakeEditor.js / settingsEditor.js / newProjectEditor.js**: Removed unreachable dead message handlers (`pickComponents`, `refreshSettings`, `pickExcludedComponents`) that the webviews never post
- **cmake-editor.html**: Fixed duplicate `cmakePreview` element ID across the root/component form templates

## 1.84.3

### Features

- **helpers.js**: Auto-open the source file containing `app_main()` when switching project folder — `app_main` is the universal entry point for ESP-IDF / ESP8266 RTOS SDK. Search order: (1) parse `main/CMakeLists.txt` SRCS and check each file for `app_main`, (2) scan `main/` for any `.c`/`.cpp` containing `app_main`, (3) fallback to first SRCS file, then `main/main.c`. Does not trigger on startup (restoring saved root)
- **extension.js**: Project validation in "Select Project" dialog — folders are now checked for ESP8266-IDF project markers and displayed with visual indicators: ✅ full match (CMakeLists.txt + main/CMakeLists.txt or components/*/CMakeLists.txt), ⚠️ partial (only root CMakeLists.txt), ❌ none (no CMakeLists.txt). Selecting a non-IDF folder shows a confirmation warning before proceeding

### Bug Fixes

- **flash.js + cmakeEditor.js**: Auto-save dirty CMake editor panels before build — if the user edited CMakeLists.txt in the webview but didn't click Save, the build would use stale data from disk. Now `saveAllDirtyCmakePanels()` is called before `saveAll()` in `runIdf`, ensuring the on-disk file always matches the webview state when a build starts
- **treeProvider.js**: Removed SDK version display from sidebar — the version shown was always "v3.4" (hardcoded default) and provided no useful information to the user
- **helpers.js**: Fixed terminal launch failure when all workspace folders are missing — added `os.homedir()` as final fallback in `_resolveTermCwd()`, guaranteeing the terminal always gets a valid CWD

## 1.84.2

### Bug Fixes

**Critical:**
- **helpers.js**: Fixed `ensureVersionTxt` writing "unknown" to `version.txt` — the Python builder (idf.py) requires this file to contain the SDK version (e.g. "v3.4"). If the file is missing or contains invalid content, "v3.4" is now written as the default (the ESP8266 RTOS SDK version this extension is built for). The file is never written with "unknown"
- **idfRunner.js**: Fixed `checkToolsOrPrompt` and `checkAndInstallTools` always failing when `pythonCmd` contained shell quotes — `cp.execFile()` executes the binary directly without a shell, so quoted paths like `"python3"` or `"C:\Python37\python.exe"` were treated as literal filenames. Now strips surrounding quotes before passing to `execFile`
- **flash.js**: Fixed race condition in `runIdf` — `setBusy()` was called after multiple `await` operations, allowing a second click to slip through between `checkBusy()` and `setBusy()`. Now `setBusy()` is called immediately after `checkBusy()`, before any async gap. Early returns properly call `clearBusy()`
- **extension.js**: Fixed double `clearBusy()` in `cmdFlashFsImage` — `clearBusy()` was called both inside the promise callback and in `finally`, causing a redundant second call. Now only `finally` calls `clearBusy()`, with a guard to avoid wiping the monitor's busy state if it was started
- **helpers.js**: Fixed terminal launch failure when workspace folder is deleted — `getTerm()` created terminals without specifying `cwd`, causing VS Code to default to the first workspace folder. If that folder was deleted from disk, the terminal failed with "Starting directory does not exist". Now `getTerm()` sets `cwd` to the active project root, or the first existing workspace folder as fallback

**Improvements:**
- **helpers.js**: `getSdkVersion` now has additional fallback methods for non-git SDK installs (folder name parsing, CMakeLists.txt IDF_VERSION defines) so the SDK version is displayed correctly even without a .git directory

## 1.84.1

### Bug Fixes

**Critical:**
- **helpers.js**: Fixed `ensureVersionTxt` writing "unknown" to `version.txt` — the Python builder (idf.py) requires this file to contain the SDK version (e.g. "v3.4"). When the SDK was installed from a zip archive (no .git directory), all git-based detection methods failed and "unknown" was written instead of the real version. Now the function tries 5 detection methods in order: (1) `git describe --tags`, (2) `.git/HEAD` symbolic ref, (3) SDK folder name parsing (e.g. `ESP8266_RTOS_SDK-v3.4` → `v3.4`), (4) `CMakeLists.txt` `IDF_VERSION_MAJOR/MINOR/PATCH` defines, (5) `git rev-parse --abbrev-ref HEAD`. If none succeed, the file is NOT written with "unknown" — instead a warning is logged instructing the user to create it manually
- **helpers.js**: Fixed `getSdkVersion` returning empty string for non-git SDK installs — added the same fallback chain (folder name, CMakeLists.txt) so the SDK version is correctly displayed in the status bar and tree view even when the SDK has no .git directory
- **idfRunner.js**: Fixed `checkToolsOrPrompt` and `checkAndInstallTools` always failing when `pythonCmd` contained shell quotes — `cp.execFile()` executes the binary directly without a shell, so quoted paths like `"python3"` or `"C:\Python37\python.exe"` were treated as literal filenames. Now strips surrounding quotes before passing to `execFile`, matching the pattern already used for `check_python_dependencies.py`

**Security:**
- **otaFlash.js**: Fixed shell injection vulnerability in `cmdOtaErase` — the `read_otadata` command used `cp.exec()` with string interpolation allowing shell injection via crafted port names. Replaced with `cp.execFile()` which passes arguments as an array, eliminating the shell injection vector
- **idfRunner.js**: Fixed shell injection in `checkToolsOrPrompt` and `checkAndInstallTools` — replaced `cp.exec()` with `cp.execFile()` for `idf_tools.py check` and `check_python_dependencies.py` invocations. All three `cp.exec` calls that spawn Python scripts now use the safe `cp.execFile` API

**Correctness:**
- **idfRunner.js**: Fixed "Required build tools are not installed" message appearing on every VS Code startup — three root causes: (1) `checkAndInstallTools` did not check `_toolsVerified` before running `idf_tools.py check`, so it re-ran on every startup; (2) when tools were found OK, `setToolsVerified(true)` was never called, so subsequent commands triggered another check; (3) the `toolsMissing` detection used `err || stderr.includes('ERROR:')` which triggered on any non-zero exit code or generic ERROR string (e.g. Python warnings), instead of checking for the specific "The following required tools were not found" message. Now: `checkAndInstallTools` skips if already verified; sets `_toolsVerified = true` when tools are OK; only shows the dialog when the specific missing-tools ERROR is detected; in silent mode (startup), missing tools are logged but don't show a dialog
- **partitionEditor.js**: Fixed stale sdkconfig cache in `switchToCustomMode` — after writing `CONFIG_PARTITION_TABLE_CUSTOM=y` to sdkconfig, the in-memory cache was not invalidated, causing subsequent `getSdkconfigValue()` calls to return stale data. Now calls `setSdkconfigCache(null)` after the write
- **helpers.js**: Fixed status bar race condition in `watchBuildResult` — if a new build started within 4 seconds of a previous build completing, the old `setTimeout` timer would overwrite the status bar text. Now stores the timer ID and calls `clearTimeout()` before setting a new timer
- **python.js**: Fixed `getVersion` Promise that could hang forever — the callback-only `Promise` constructor had no `reject` path. Added a 5-second timeout with `reject()` and `clearTimeout` cleanup in the exec callback
- **newProjectEditor.js**: Fixed partial project creation on error — if any `mkdirSync`/`writeFileSync` call failed mid-way, a broken partial project was left on disk. Now tracks all created paths and rolls back (deletes files/directories in reverse order) before re-throwing the error
- **partitionEditor.js**: Fixed `setTimeout` timer leak — the 300ms timer for `applySizeUpdatesOnOpen` was never cleaned up if the panel was disposed before the timer fired. Now stores the timer ID and registers `onDidDispose` to call `clearTimeout`
- **cmakeEditor.js**: Fixed webview panel leak on creation error — if `createWebviewPanel()` succeeded but `panel.webview.html = ...` threw, the panel was never tracked in `_cmakePanels` and `onDidDispose` was never registered, causing a resource leak. Now wraps both calls in try/catch, disposes the panel on error, and only registers in the Map after both succeed

**Improvements:**
- **partitionEditor.js**: Improved `_copyBinToProject` file comparison — replaced unreliable file-size equality check with SHA1 hash comparison. Two different files can have the same size, leading to false "same file" detection and skipped overwrites
- **settingsEditor.js**: Eliminated duplicated settings defaults — extracted `_getDefaultSettings()` function used by both `cmdSettingsEditor` and the `refreshSettings` handler, reducing 18 duplicated fields to a single source of truth
- **extension.js**: Improved `cmdFlashFsImage` error handling — replaced awkward `_earlyReturn()` pattern with proper `try/catch/finally`, where `finally` always calls `clearBusy()`. This ensures the busy lock is released even on unexpected errors
- **treeProvider.js**: Replaced silent `catch {}` in `getChildren` with logged warning — if the `components/` directory is unreadable (e.g. permission denied), the error is now logged to the output channel instead of being silently swallowed
- **helpers.js + flash.js + extension.js**: Extracted shared `MONITOR_TERM_NAMES` constant — the monitor terminal name list was hardcoded in two places. Now defined once in `helpers.js` and imported where needed, ensuring the lists stay in sync
- **python.js**: Changed `found()` pip check to fire-and-forget — `await checkPip(cmd)` blocked the return of the Python command. Now uses `checkPip(cmd).catch(() => {})` so the Python command is returned immediately while the pip check runs asynchronously

## 1.84.0

### Bug Fixes

**Critical:**
- **cmake-editor.html**: Replaced `confirm()` with `vscode.postMessage({command:'confirmRefresh'})` — `confirm()` does not work in VSCode webviews and caused silent failures
- **cmake-editor.html**: Changed `let cmakeFormat = {{CMAKE_FORMAT}}` to `{{CMAKE_FORMAT_JSON}} || "modern"` — unquoted template substitution caused `ReferenceError` when value was a bare string (e.g. `modern` instead of `"modern"`)
- **All HTML files**: Replaced unsafe string template patterns (`"{{VAR}}"`, `'{{VAR}}'`) with JSON-injected `{{VAR_JSON}}` templates that use `JSON.stringify()` on the host side — prevents XSS and SyntaxError from values containing quotes/special chars
- **All HTML files**: Added `window.addEventListener('error', ...)` error catcher script to display user-friendly error panels instead of blank/broken webviews when template substitution fails
- **All HTML files**: Wrapped `init()` calls in `try/catch` with error display panels — prevents silent crashes on null/undefined template data

**Non-critical:**
- **cmake-editor.html**: Fixed `pickSingleFile('sdkconfig')` overwriting value on cancel — now checks `msg.cancelled` flag and `files.length`
- **partition-editor.html**: Fixed undefined CSS variable `--fg` → changed to `--text` (defined in `:root`)
- **partition-editor.html**: Added `has-error` class application in `validate()` — CSS rule existed but was never triggered
- **partition-editor.html**: Fixed HTML injection vulnerability in `{{SAFE_FLASH_SIZE}}` and `{{SAFE_FILENAME}}` — now set via `textContent`/`value` from JS instead of inline HTML attributes
- **settings-editor.html**: Fixed `saveSettings()` `setTimeout` always showing success — now waits for host response (`saveSettingsResult` message) with 5s safety timeout
- **settings-editor.html**: Added null guard in `applySettingsToUI()` — prevents crash when `settings` is null/undefined
- **new-project.html**: Fixed copy-paste bug: `msg.type === 'exclude' ? 'excludeComponents' : 'excludeComponents'` → `const field = 'excludeComponents'`

### Host-side changes
- **cmakeEditor.js**: Added `_JSON` template replacements for all string/number variables using `_escJsJson()` (JSON.stringify + `</script` escape)
- **cmakeEditor.js**: Added `confirmRefresh` message handler — shows VSCode modal dialog and posts `confirmRefreshResult` back to webview
- **cmakeEditor.js**: Added `cancelled: true` flag to `setPickedFiles` response when file picker is cancelled
- **cmakeEditor.js**: Sends `saveSettingsResult` back to webview after save (success or failure)
- **components.js**: Added `_JSON` template replacements for `AVAILABLE_COMPONENTS` and `PROJECT_ROOT`
- **partitionEditor.js**: Added `_JSON` template replacements for `IS_BUILTIN`, `MODE_LABEL`, `MODE_HINT`, `SAFE_FLASH_SIZE`, `SAFE_FILENAME`
- **settingsEditor.js**: Added `_JSON` template replacement for `INITIAL_MODE`
- **newProjectEditor.js**: Added `_JSON` template replacement for `AVAILABLE_COMPONENTS`

## 1.83.8

### Bug Fixes
- **littlefsgen.py**: Fixed `LFS.inline_max` auto-detection formula — was `min(block_size//8, 256)`, now correctly uses `min(cache_size, attr_max, block_size//8)` matching LittleFS C source. For ESP8266 (cache_size=64, attr_max=1022, block_size=4096): inline_max=64 (was incorrectly 256)
- **fatfsgen.py**: Fixed `_generate_partition_from_folder` calling `write_content()` with empty content for empty files — added `if content:` guard consistent with `main()` and `_calculate_min_partition_size`
