# ESP8266-IDF — Changelog

## 1.83.0

### Features
- **Partition bin links: cross-platform CMake paths** — Bin file paths in `esptool_py_flash_project_args()` now use `${CMAKE_CURRENT_SOURCE_DIR}/filename.bin` instead of absolute filesystem paths (e.g. `d:/path/to/file.bin`). This ensures CMakeLists.txt works correctly on Windows, Linux, and macOS.

### Improvements
- **Auto-copy bin files to project** — When linking a `.bin` file that is outside the project directory, the extension automatically copies it to the project root. This guarantees that `${CMAKE_CURRENT_SOURCE_DIR}/` paths always resolve correctly.
- **Name collision handling** — If a file with the same name already exists in the project root, the extension offers options: overwrite, keep existing, or auto-rename with a numeric suffix.
- **Migration of old absolute paths** — When opening a project that has old-style absolute paths in the partition bin links block, the extension automatically converts them to `${CMAKE_CURRENT_SOURCE_DIR}/` format if the file is inside the project directory.
- **CMake path resolution for file operations** — All file size validation and stat operations now correctly resolve `${CMAKE_CURRENT_SOURCE_DIR}` to the project root directory.

---

## 1.82.0

### Bug Fixes
- **Root CMake Editor: post-project() content no longer deleted on save** — Previously, any CMake code after `project()` (e.g. partition bin links, `if()` blocks, `esptool_py_flash_project_args()` calls) was silently removed when saving from the root CMake Editor. The editor now preserves all content after `project()` via a new "Custom CMake Code (postamble)" section.
- **Root CMake Editor: safety check for all root formData fields** — The init function now ensures all expected fields exist for root mode (not just component mode), preventing `undefined` errors.

### Features
- **New: "Custom CMake Code (postamble)" section in root CMake Editor** — A collapsible textarea section for editing CMake code that appears after `project()` in root CMakeLists.txt. This includes partition bin links, `if(CONFIG_...)` blocks, and any other custom CMake commands. The section is collapsed by default.
- **New: Postamble syntax highlighting in CMake Preview** — The root CMake preview now renders post-project content with syntax highlighting.

### Improvements
- More robust `parseCmakeRoot()` — now uses balanced parenthesis matching to find the end of `project()` instead of a simple regex, correctly handling project names with spaces or additional arguments.
- `generateCmakeRoot()` — now uses `postambleBlock` (all content after `project()`) with fallback to the legacy `partitionBinLinksBlock` for backward compatibility.

---

## [1.81.0]
- Fix (CRITICAL): **CMake Editor crash — "VARIABLE is not defined"** — `${VARIABLE}` and `${COMPONENT_REQUIRES}` placeholder text inside JavaScript template literals was interpreted as variable interpolation instead of literal CMake variable syntax, causing a ReferenceError that prevented the editor from loading (#51)
- Fix: Removed dead duplicate `postMessage` calls — backend was sending both old-format (`addFiles`, `addFolders`, `setComponents`, `scanResult`) and new-format messages, but the HTML webview only handles new-format messages (`setPickedFiles`, `setPickedComponents`, `setScannedFiles`). Removed the dead old-format sends.
- Fix: Removed unused `readExcludedComponents` import from `cmakeEditor.js` (replaced by `readExcludedComponentsFromText` in the same module)
- Cleanup: Simplified `pickComponents` message handler — removed redundant dual-format field/type conversion logic
- Cleanup: Removed redundant compatibility comments in `pickFiles`, `pickFolder`, `scanDirectory` handlers

## [1.80.0]
- Feature: **CMake Editor — Variable Reference Tags** — `${VARIABLE}` references in REQUIRES/PRIV_REQUIRES are now displayed as distinctive orange tags with a 🔗 link icon
  - Orange visual style clearly distinguishes variable references from literal component names (grey tags)
  - Hover tooltip: "Variable reference — edit in Custom CMake preamble"
  - Removable with ✕ button (same as regular tags)
  - Variable references detected automatically via `${...}` pattern matching
- Feature: **CMake Editor — Custom CMake Code (preamble) section** — new collapsible section for editing CMake code that runs before `idf_component_register()`
  - Collapsible section with 📝 icon, collapsed by default, shows "(empty)" when preamble is empty
  - Monospace textarea for editing `if()/set()/endif()` conditional blocks, comments, and variable definitions
  - Placeholder example shows conditional `COMPONENT_REQUIRES` pattern
  - Preamble code is included in CMake preview with syntax highlighting (keywords, variables, comments)
  - Changes to preamble instantly update the live CMake preview
- Feature: **CMake Editor — Variable reference warning** — when `${...}` variable references exist in REQUIRES/PRIV_REQUIRES, a warning banner appears in the preamble section explaining that variable refs cannot be resolved by the tag editor and must be edited in the preamble

## [1.79.0]
- Fix: **Flash File System — smart filesystem type filtering** — the "Flash File System" command now checks the project's partition table CSV and only shows filesystem types (SPIFFS/FATFS/LittleFS) that actually have matching partitions, instead of showing all 3 options unconditionally (#49)
  - If only one filesystem type has partitions → flashes it directly (no menu)
  - If no filesystem partitions found → shows error with "Open Partition Editor" button
  - If multiple types have partitions → shows only those, with partition names as detail
- Fix: **CMake Editor — preserve preamble block** — all CMake code before `idf_component_register()` (such as `if()/set()/endif()` conditional blocks, comments, variable definitions) is now preserved verbatim when saving (#50)
  - Previously, `if(CONFIG_... OR CONFIG_...)\n  set(COMPONENT_REQUIRES sd_spi_driver)\nendif()` would be silently deleted on save
  - Now the entire preamble is stored in `preambleBlock` and prepended to the generated output
  - Works for both Modern (`idf_component_register`) and Legacy (`set(COMPONENT_*) + register_component()`) formats
- Feature: **CMake Editor — detect variable references** — `${VARIABLE}` references in REQUIRES/PRIV_REQUIRES are now detected and flagged via `hasVariableRefs` metadata, enabling future UI warnings about conditional logic

## [1.78.0]
- Feature: **CMake style selector** for New Project and New Component — choose between Modern (`idf_component_register`) and Legacy (`register_component`) format
  - Header bar with Format dropdown and MODERN/LEGACY badge (matches CMake Editor style)
  - Default: Modern (ESP-IDF v4.x/v5.x)
  - Legacy option for ESP8266 RTOS SDK v3.x compatibility
  - Live preview updates when switching format
  - Generated `CMakeLists.txt` matches selected format
- Fix (CRITICAL): `--before`/`--after` esptool options were passed to `idf.py` flash command — these are esptool-only options and caused "No such option: --before" error on ESP8266 RTOS SDK
- Fix (CRITICAL): `--before`/`--after` in Flash FS Image (esptool.py) were placed AFTER `write_flash` subcommand instead of BEFORE — caused "Address default_reset must be a number" error
- Fix: Unused `sdkVal` variable in `extension.js` — now properly used instead of `getSdkconfigValue()`
- Fix: Missing `checkPythonDeps()` call in `cmdFlashFsImage`
- Fix: Missing `fs.existsSync` check for HTML template in `partitionEditor.js`
- Fix: `monitorTermNames` list had 2 outdated names and was missing 'ESP › Erase & Flash & Monitor'

## [1.77.0]
- Feature: CMake Editor now supports legacy ESP8266 RTOS SDK format (`set(COMPONENT_SRCS ...)` + `register_component()`) in addition to modern `idf_component_register()` format
- Feature: CMake Editor auto-detects source files from directory via recursive scanning
- Improvement: CMake Editor supports folder picker for SRC_DIRS, INCLUDE_DIRS, EXTRA_COMPONENT_DIRS
- Improvement: CMake Editor blocks saving during build/flash (busy state)
- Improvement: CMake Editor syncs busy state when panel becomes visible
- Improvement: Close all webview panels (CMake, New Project, Add/Edit Component, Settings, Partition Editor) when switching project
- Fix: Active root path validation — warns when selected project folder no longer exists on disk and resets to null

## [1.76.0]
- Feature: Auto-generate IntelliSense config and tasks.json on project open (`autoGenerateOnOpen` setting, default: true)
  - Only generates files that don't exist yet
  - c_cpp_properties.json includes Xtensa compiler path detection
  - tasks.json uses `$esp-idf-gcc` problem matcher and proper shell configuration
- Feature: `shellPath` setting — manual shell path override (e.g. powershell.exe or /bin/bash)
- Feature: `useExecutionPolicyBypass` setting — on Windows, use `-ExecutionPolicy Bypass` for PowerShell
- Improvement: Terminal creation now uses `-NoProfile` flag on Windows PowerShell (faster startup)
- Improvement: `checkPythonDeps()` runs before every build/flash command — prompts to install missing Python requirements

## [1.75.0]
- Fix: Partition Editor now detects whether the partition table is **built-in** (Single App / Two OTA) or **Custom**
  - Built-in mode: shows yellow badge "Factory + Two OTA (built-in)" or "Single factory app (built-in)" with warning that saving will switch to Custom mode
  - Custom mode: shows green badge "Custom partition table"
- Fix: Saving a built-in partition table now correctly saves to `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME` (e.g. `partitions.csv`) instead of the SDK's built-in filename (e.g. `partitions_two_ota.csv`)
- Fix: When saving a built-in table, sdkconfig is automatically updated to switch from "Single App" or "Two OTA" to "Custom partition table CSV" mode, then `reconfigure` runs automatically
- Fix: Partition Editor now loads CSV from SDK directory when viewing a built-in partition table (was showing empty table)
- Fix: `$(IDF_PATH)` in `CONFIG_PARTITION_TABLE_FILENAME` is now expanded when loading CSV in Partition Editor

## [1.74.0]
- Fix (CRITICAL): `hasOtaPartitions()` could incorrectly return `true` for projects without OTA — `CONFIG_PARTITION_TABLE_FILENAME` often contains `$(IDF_PATH)` which was never expanded, causing CSV path resolution to fail and fall through to the `CONFIG_PARTITION_TABLE_TWO_OTA` shortcut
- Fix: Added `CONFIG_PARTITION_TABLE_SINGLE_APP=y` early-exit check — explicitly skips all OTA detection for single-app partition tables (default for most examples like hello_world)
- Fix: New `_resolveCsvPath()` function properly expands `$(IDF_PATH)` and `${IDF_PATH}` variables in partition CSV filenames, then resolves absolute/relative paths correctly
- Fix: Added detailed logging to `hasOtaPartitions()` — every step logs its result, making OTA detection issues easy to diagnose via Output panel
- Feature: **Serial port device connectivity check** — before running any OTA command, the extension runs `esptool.py chip_id` to verify a device is actually connected to the selected COM port
  - If no device responds, shows error with options: "Select Port" (pick a different port) or "Continue Anyway" (skip check)
  - Prevents cryptic `otatool.py` Python tracebacks when the device is not connected
- Improvement: OTA "no partitions" error message now suggests "Open Menuconfig" (instead of "Open Partition Editor") and explains how to enable OTA

## [1.73.0]
- OTA: Added `otaPreflight()` shared pre-flight check for all 4 OTA commands — eliminates ~120 lines of boilerplate duplication
- OTA: Added build check — if `build/flasher_args.json` doesn't exist, warns "Project has not been built yet. Flash the project first." with a "Build & Flash First" button
- OTA: Improved error messages — when otatool.py fails, shows helpful hints (device not connected, device not flashed with OTA table, serial port busy) instead of just "exit code N"
- OTA: Renamed sidebar group "OTA Flash (WiFi)" → "OTA Partition Mgmt (Serial)"

## [1.72.0]
- Settings Editor: Build After-action changed to `none` / `Flash` (removed `App Flash` — not needed after full build)
- Settings Editor: Build App After-action changed to `none` / `App Flash` (removed `Flash` — full flash after app-only build is unnecessary)
- Settings Editor: Changed Before-Flash to "N/A" for Flash App, Flash Bootloader, and Flash Partition — erasing entire flash before partial flash is counterproductive
- Backend: `runWithPostFlash()` no longer reads `preFlashAppAction`/`preFlashBootloaderAction`/`preFlashPartitionAction` — erase is only applicable to the main Flash command
- `package.json`: Updated enums for `postBuildAction` (removed `app_flash`), `postBuildAppAction` (now `none`/`app_flash`), `preFlashAppAction`/`preFlashBootloaderAction`/`preFlashPartitionAction` (removed `erase`)
- Fix: OTA Read Otadata and OTA Erase commands now check for OTA partitions before running — previously crashed with Python traceback on projects without OTA partition table
- Fix (CRITICAL): `getPartitionCsvFilename()` now reads `CONFIG_PARTITION_TABLE_FILENAME` (not just `CUSTOM_FILENAME`) — built-in OTA partition tables (e.g. `partitions_two_ota.csv`) were never detected
- Fix: `hasOtaPartitions()` now searches 4 locations: project CSV → SDK built-in CSV → build directory CSV → sdkconfig OTA flag
- Fix: OTA CSV parser now strips quotes from values (e.g. `"ota_0"`)
- Fix: All 4 OTA commands now pass `--baud` to otatool.py (was using slow default 115200)
- Fix: OTA Read Otadata now shows success notification (was silent on success)
- Rename: Sidebar group "OTA Flash (WiFi)" → "OTA Partition Mgmt (Serial)" (commands operate via serial, not WiFi)

## [1.71.0]
- Fix: `onDidChangeWorkspaceFolders` now also closes the "Add Component" panel when the active project changes (was left dangling)
- Fix: `getSdkconfigChoice` is now properly exported from `helpers.js` (was defined but missing from exports)
- Fix: Removed unused `quickPickActive` function and export from `components.js`
- Fix: CSS variable `--btn2-ff` renamed to `--btn2-fg` for consistency with other HTML templates (`partition-editor.html`, `cmake-editor.html`, `new-project.html`)

## [1.70.0]
- Settings Editor: Removed "Esptool Connection" section (Chip reset before/after flash) from webview — settings remain accessible via VS Code native Settings UI and sidebar tree commands
- Settings Editor: Removed "Override Flash Configuration" section (Override flash settings, baud, mode, freq, size, compressed upload) from webview — settings remain accessible via VS Code native Settings UI and sidebar tree commands
- Removed unused CSS styles (`.toggle-switch`, `.conditional-section`, `.sub-label`, `.select`) and JS functions (`setToggle`, `updateFlashConfigVisibility`, `setSelect`, `setToggleUI`, `setSelectUI`) from Settings Editor webview

## [1.69.0]
- Feature: **Per-command pre/post action settings** — each Build and Flash command now has its own independent "Before" and "After" action configuration
  - Build: Before (none/clean/fullclean) + After (none/flash/app_flash)
  - Build App: Before (none/clean/fullclean) + After (none/flash/app_flash)
  - Build Bootloader: Before (none/clean/fullclean) + After (none/flash_bootloader)
  - Build Partition Table: Before (none/clean/fullclean) + After (none/flash_partition)
  - Flash: Before (none/erase) + After (none/monitor)
  - Flash App: Before (none/erase) + After (none/monitor)
  - Flash Bootloader: Before (none/erase) + After (none/monitor)
  - Flash Partition Table: Before (none/erase) + After (none/monitor)
  - Flash File System: After (none/monitor)
- Feature: **Redesigned Settings Webview** — compact per-command layout with inline radio buttons for each command
  - Build tab: per-command Before/After actions + shared Post-Build Analysis (Build only)
  - Flash tab: per-command Before/After actions + shared Esptool Connection + Override Flash Config
  - Flash FS tab merged into Flash tab as a command row
- New configuration settings: `preBuildAppAction`, `postBuildAppAction`, `preBuildBootloaderAction`, `postBuildBootloaderAction`, `preBuildPartitionAction`, `postBuildPartitionAction`, `preFlashAppAction`, `postFlashAppAction`, `preFlashBootloaderAction`, `postFlashBootloaderAction`, `preFlashPartitionAction`, `postFlashPartitionAction`
- `flash.js`: `runIdf()` and `runWithPostFlash()` now accept `commandKey` parameter for per-command settings lookup
- `resolvePostBuildFlashAction()` helper maps post-build actions to flash commands (e.g. `flash_bootloader` → `bootloader-flash`)

## [1.68.0]
- Improvement: **Separated Build and Flash pre/post action settings** — Build and Flash now have fully independent "Before" and "After" action configurations in the Settings webview
  - Build tab: Before Build (none/clean/fullclean) + After Build (none/flash/app_flash) + Post-build analysis
  - Flash tab: Before Flash (none/erase) + After Flash (none/monitor) + Esptool connection + Override flash config
  - Flash FS tab: After Flash FS (none/monitor)
  - Each command type uses only its own settings — no shared/merged configuration

## [1.67.0]
- Feature: **Edit Component Webview** — "Edit Component" from the sidebar now opens a webview editor instead of the old 4-step QuickPick wizard
  - Pre-populated from existing CMakeLists.txt (name, sources, headers, dependencies)
  - Component rename with folder rename support
  - Source files (.c) with inline add/remove + auto-detect from directory
  - Header file location: `include/` folder, same folder as `.c`, or none (pre-selected)
  - Component dependencies (REQUIRES) picker with search/filter (pre-populated)
  - Live CMake preview with syntax highlighting
  - "RENAMED" badge shown when component name is changed
- Feature: **Settings Webview Editor** — unified visual settings panel replacing 5 separate QuickPick wizards
  - Build tab: Before build action, After build action, Post-build analysis checkboxes
  - Flash tab: Erase before flash, After flash action, Override flash config (baud/mode/freq/size/compression/before/after)
  - Flash FS tab: After flash filesystem action
  - All settings displayed and editable in one place with instant save
- Fix: `esp.editProject` command was calling `cmdCmakeEditorMain()` directly instead of `cmdEditProject()` which has the logic to choose between root and main CMake editor
- Fix: Removed dead QuickPick-based configure functions from extension.js (moved to SettingsEditor webview)

## [1.66.0]
- Feature: **Auto-add project to workspace** — after creating a new project, the folder is automatically added to the VS Code workspace and set as the active project (no more "Open in Workspace" button prompt)
- Feature: **New Component webview** — "Add New Component" from the sidebar now opens a webview editor instead of the old QuickPick wizard
  - Component name with live validation and duplicate check
  - Source files (.c) with inline add/remove
  - Header file location: `include/` folder, same folder as `.c`, or none
  - Component dependencies (REQUIRES) picker with search/filter
  - Live CMake preview with syntax highlighting
- Fix: Sidebar "cfg is not defined" error — `treeProvider.js` was missing `cfg` import from `./helpers`
- Fix: "log is not defined" error on project creation — import was present but stale VSIX builds may not have included it

## [1.65.0]
- Feature: **CMake Webview Editor** — visual editor for `CMakeLists.txt` (component, main, root) replacing old menu-based QuickPick wizards
  - Edit all `idf_component_register()` parameters: SRCS/SRC_DIRS, INCLUDE_DIRS, REQUIRES, EMBED_FILES, etc.
  - Built-in component picker with search/filter for dependencies and exclusions
  - Live CMake preview with syntax highlighting
  - Multiple editors can be open simultaneously (e.g. component + root)
- Feature: **Create New Project Webview** — replaces old 4-step native wizard with single-page webview editor
  - Parent folder browser, project name with live validation, header location radio buttons
  - Excluded components picker, live preview of all files to be generated
  - "Open in Workspace" button after creation
- Removed: Old menu-based edit component wizard (4-step QuickPick) — pencil icon now opens CMake webview editor
- Removed: Old menu-based edit project wizard — replaced by CMake webview editors (root + main)
- Removed: Old menu-based create project wizard (4-step sequential dialogs) — replaced by webview
- Removed: Make-style compatibility (`component.mk`, `Makefile` generation) — project is pure CMake only

## [1.22.0]
- Feature: **Flash File System** — unified command replacing Flash SPIFFS / Flash FATFS / Flash LittleFS (3 → 1)
  - Auto-detects filesystem type from `CMakeLists.txt` (reads `esptool_py_flash_project_args` block)
  - Shows auto-detected type with "Continue" / "Choose manually" options
  - Falls back to manual selection if CMakeLists.txt block not found
- Removed: **Open Component in Explorer** inline button from sidebar component items (no longer needed)
- Improvement: VSIX package size reduced from 32 MB to 168 KB — `node_modules` excluded via `.vscodeignore`, `@vscode/vsce` moved to `devDependencies`

## [1.21.0]
- Feature: **OTA Flash — firmware over WiFi/serial** — 4 new commands using SDK's `otatool.py`:
  - **OTA Flash** — write firmware .bin to OTA partition slot (ota_0/ota_1) via serial
  - **OTA Switch** — switch boot partition to ota_0 or ota_1 (device boots from selected slot after reset)
  - **OTA Read Status** — read OTA data partition from device (shows current boot selection)
  - **OTA Erase** — erase OTA partition or otadata (reset boot selection or clear slot)
  - New sidebar group 📡 OTA Flash (WiFi) with all 4 commands
  - Auto-detects OTA partition layout from CSV; warns if no OTA slots found
  - Uses `--slot` for ota_0/ota_1 or `--name` for custom partition names
- Fix: **globalCtx is not defined** error causing empty sidebar — `treeProvider.js` EspGroup constructor used bare `globalCtx` variable instead of `getGlobalCtx()` getter
- Fix: **Partition Editor showed raw JS** in Flash Size field — `${safeFlashSize === ...}` was not evaluated when HTML extracted to separate file; replaced with `{{FLASH_SIZE_LABEL}}` placeholder
- Removed: **Set Target** command — ESP8266 has only one target (`esp8266`), `idf.py set-target` is meaningless and destructive (does fullclean + reconfigure)

## [1.19.1]
- Fix: **Removed Partition Editor encrypted toggle** — ESP8266 does not support flash encryption (that's an ESP32-only feature); removed 🔒/🔓 column and Flags field from CSV output
- Refactor: **Monolithic extension.js split into 10 focused modules** — helpers, python, ports, statusBar, idfRunner, flash, components, treeProvider, partitionEditor, extension (entry point)
- Refactor: **Partition Editor HTML extracted to separate file** — `media/partition-editor.html` with `{{PLACEHOLDER}}` template variables; proper syntax highlighting and editability

## [1.19.0]
- Feature: **SDK version display** — shows git tag/branch or version.txt in sidebar next to SDK path
- Feature: **Keyboard shortcuts** — Ctrl+Alt+B (Build), Ctrl+Alt+F (Flash), Ctrl+Alt+M (Monitor/Stop), Ctrl+Alt+G (Menuconfig), Ctrl+Alt+E (Erase Flash)
- Feature: **Set Target** — new `idf.py set-target` command in sidebar (SDK Configure group)
- Feature: **Open Component in Explorer** — right-click component → open folder in OS file manager
- Feature: **Build time tracking** — success notification now shows elapsed time (e.g., "completed in 1m 23s")
- Feature: **Partition Editor clickable CSV filename** — click filename in header to open CSV file
- Feature: **Python detection progress** — status bar spinner while searching for Python 3.7
- Improvement: **Busy state blocks sidebar menus** — inline context menu items disabled when commands are running
- Improvement: **Deduplicated filesystem image builder** — SPIFFS/FATFS/LittleFS share common pre-flight, size selection, and terminal execution code (~210 lines removed)
- Improvement: **OutputChannel properly disposed** on deactivation (memory leak fix)
- Improvement: **Temp marker files cleaned up** on deactivation (no more orphaned .tmp files)
- Improvement: **Terminal and monitor state cleanup** on deactivation
- Improvement: **SDK version shown** when setting SDK path manually
- Improvement: **sdkconfig cache invalidated** by filesystem watcher (not just mtime checks)
- Improvement: **Project structure validation** — warning in sidebar if active folder lacks CMakeLists.txt/sdkconfig

## [1.18.0]
- Fix (CRITICAL): `_toolsVerified = true` even when install FAILS — now reads marker file content (0=success, 1=failure)
- Fix (CRITICAL): `cmdStopMonitor` unconditionally called `clearBusy()` — could release lock during build/flash
- Fix (CRITICAL): Race condition between `clearBusy()` and `runWithPostFlash()` — busy lock now held through the transition
- Fix (CRITICAL): `_monitorRunning = true` set before command actually starts — moved after `t.sendText()`
- Fix (CRITICAL): Missing terminal names for app-flash/bootloader-flash + monitor in `cmdStopMonitor`
- Fix (CRITICAL): Non-unique marker files for SPIFFS/FATFS/LittleFS — stale markers caused false-positive completion; now use unique filenames in `os.tmpdir()`
- Fix (CRITICAL, Python): `entry.py` operator precedence — `order_ & 0x40 == 0x40` evaluated as `order_ & (0x40 == 0x40)` instead of `(order_ & 0x40) == 0x40`; corrupted LFN reconstruction
- Fix (CRITICAL, Python): `fatfs_state.py` passed `sectors_count` instead of `clusters_count` to `get_fat_sectors_count()` — wrong FAT type selection and table size
- Fix (CRITICAL, Python): `--partition_size detect` for non-WL FATFS always raised ValueError — sentinel `-1` now skips validation
- Fix (CRITICAL, Python): `fs_object.py` used `sector_size` instead of `cluster_size` for file splitting — files consumed `sectors_per_cluster`× more space than needed
- Fix: `q()` always used PowerShell escaping on Windows — now checks `shellPath` for cmd.exe
- Fix: `buildCmd()` used `;` on Windows (continues on failure) — now uses `&&` for PowerShell, `;` only for cmd.exe
- Fix: `picked: true` without `canPickMany` was ignored — replaced with `quickPickActive()` helper
- Fix: SPIFFS subtype incorrectly mapped to `spiffs/littlefs` — now preserved as original value from CSV
- Fix: `_panelIsDirty` temporal dead zone — declaration moved before `onDidReceiveMessage` callback
- Fix: Unknown INCLUDE_DIRS silently defaulted to `'dot'` — now preserves custom paths
- Fix: Deprecated `onDidAccept` API in `quickPickActive` — replaced with `onDidChangeSelection`
- Fix: `getSdkconfigValue` read entire file per key call — now cached with mtime invalidation
- Fix: Stale `root` after async `requireReady()` in `cmdGenerateIntelliSense/cmdGenerateTasks`
- Fix (Python): `fatfsparse.py` `os.makedirs` without `exist_ok=True` — `FileExistsError` on re-run
- Fix (Python): `--long-name-support` could never be disabled — added `--no-long-name-support` / `--no_long_name_support`
- Fix (Python): `spiffsgen.py` `StopIteration` caught in wrong scope — `next()` could raise uncaught
- Fix (Python): Minimum partition size validation underestimated FAT overhead — now uses estimated `sectors_per_fat`
- Fix (Python): `fatfs_state.py` boundary warning checked nonsensical condition — now estimates actual cluster count
- Fix (Python): Debug `print(BootSector)` left in `fatfs_parser.py` — removed
- Fix (Python): `fatfsgen.py` `root_entry_count` silently capped at 512 — now uses `max()` to allow more entries
- Fix (Python): `wl_fatfsgen.py` no `move_count` validation — now checks range and handles 0 correctly
- Fix (Python): `fat.py` no bad-cluster marker detection — now raises `RuntimeError` on bad cluster (0xFF7/0xFFF7)
- Fix (Python): `cluster.py` no bounds check on FAT12 read — now raises `IndexError` on out-of-bounds
- Fix (Python): `fatfsparse.py` odd-byte UTF-16 crash — now ensures even byte count before decode

## [1.17.0]
- Feature: **Menuconfig button in status bar** — quick access to `idf.py menuconfig` from the bottom bar (after Monitor button)
- Fix: **CONFIG_WL_SECTOR_SIZE parsing** — was incorrectly checked as boolean (`=== 'y'`), now reads the actual numeric value (4096 or 512)
- Fix: **FATFS partition size auto-adjust** — if partition size from CSV is too small for Wear Levelling, auto-increases to minimum with warning instead of blocking
- Fix: **FATFS output file naming by WL mode** — `_fatfs.bin` (no WL), `_fatfs_wl_p.bin` (WL performance), `_fatfs_wl_s.bin` (WL safe)
- Fix: **EXCLUDE_COMPONENTS CMakeLists.txt parsing** — lines starting with `#` are now correctly treated as comments (e.g. `#set(EXCLUDE_COMPONENTS ...)` no longer parsed as active)
- Fix: **Busy-state locking** — all sidebar and project-modifying actions are now blocked while a terminal command is running:
  - Project switching / creation / clearing
  - Component checkbox toggles, add / edit / delete
  - Flash settings changes (baud, mode, freq, size, compression, before/after flash, monitor baud)
  - Partition Editor, SPIFFS/FATFS/LittleFS generators
  - Build/Flash configuration dialogs
- Fix: **Partition Editor blocks project changes** — cannot switch or create project while editor is open
- Fix: `esp.clearProject` now also checks busy state

## [1.16.8]
- Fix: component scanner now correctly includes all SDK components (register_component, set(srcs) patterns) — previously missed mbedtls, freertos, lwip, console, etc.

## [1.16.7]
- Fix: component scanner now filters out infrastructure components without SRCS (e.g. esptool_py, partition_table, bootloader)

## [1.16.6]
- Fix: component dependencies list now excludes the component being edited (prevents self-dependency)
- Rename: "Dependencies (REQUIRES)" → "Dependencies"

## [1.16.5]
- Fix: EXCLUDE_COMPONENTS now preserves project component exclusions when editing SDK component exclusions

## [1.16.4]
- Feature: Component selection via QuickPick with checkboxes — scan SDK and project components, mark current selections, option to type custom names
- Feature: **Edit Project** — EXCLUDE_COMPONENTS selector (SDK components only, project components managed via sidebar checkboxes)
- Feature: **Create New Project** — EXCLUDE_COMPONENTS selector for new projects
- Feature: **Add Component / Edit Component** — REQUIRES dependencies selector (SDK + project components)
- Change: Edit Project / Create New Project now use EXCLUDE_COMPONENTS instead of REQUIRES
- Fix: EXCLUDE_COMPONENTS preserves project component exclusions when editing SDK component exclusions

## [1.16.3]
- Feature: Dependencies (REQUIRES) selection now uses QuickPick with checkboxes — scan SDK and project components, mark current deps, option to type custom names

## [1.16.2]
- Feature: unified console output for all filesystem generators — progress bar, configuration summary, and result line
- Feature: `fatfsgen.py` / `wl_fatfsgen.py` now show progress bar and configuration (previously silent)
- Feature: `spiffsgen.py` now shows configuration block and result summary (previously only progress bar)

## [1.16.1]
- Fix: removed `Flash & Monitor` from post-build action menu (redundant with `postFlashAction: monitor`)
- Fix: Partition Editor — `spiffs` subtype renamed to `spiffs/littlefs` in dropdown (subtype `0x82` is shared by both filesystems; CSV still saves as `spiffs`)

## [1.16.0]
- Feature: **Make LittleFS** — pack a data folder into a LittleFS v2 filesystem image (pure Python, no dependencies)
- Feature: LittleFS image size selection (Auto / presets / manual), parameters from `sdkconfig`
- Fix: VSIX package cleaned up (992 KB → 150 KB)

## [1.15.0]
- Feature: initial LittleFS support (pip-based wrapper, superseded by 1.16.0 pure Python)

## [1.14.1]
- Fix (CRITICAL): FATFS auto-size was forcing 512KB minimum and double-counting FAT sectors — now auto-detects correctly (e.g. 1KB file → 20KB image)

## [1.14.0]
- Fix (CRITICAL): FATFS — long filename support enabled by default; multiple data corruption and crash bugs fixed in `fatfsgen.py` / `fatfs_utils/` (UTF-16 LE encoding, sector size calculation, SFN validation, fragmented FAT, etc.)

## [1.13.0]
- Feature: **Make FATFS** — pack a data folder into a FAT filesystem image with wear levelling support
- Feature: zero-dependency Python scripts (replaced `construct` library with `struct`)

## [1.12.0] – [1.12.2]
- Feature: component source file selection via QuickPick checkboxes (Add/Edit Component, Edit Project)
- Fix: `EXCLUDE_COMPONENTS` placement in CMakeLists.txt corrected
- Fix: Python cache and tools verification improvements

## [1.11.0]
- Feature: Edit Project — select source files (.c) for compilation via checkboxes
- Fix: `writeExcludedComponents()` newline handling

## [1.10.0]
- Feature: component checkboxes in sidebar — enable/disable components for compilation via `EXCLUDE_COMPONENTS`

## [1.9.2] – [1.9.3]
- Fix (CRITICAL, Linux): bash syntax error broke all commands — fixed `buildIdfEnvPrefix()` separator
- Fix: Linux/macOS compatibility — Python detection, serial ports (CH340/CH341), path handling, `printf` instead of `echo`
- Fix (Windows): PowerShell quoting for SPIFFS and Python commands
- Fix: multiple `spiffsgen.py` bugs (off-by-one errors, floating-point inaccuracy, wrong exception types)
- Fix: various extension.js bugs (command registration, regex, sdkconfig parsing, hex offset detection)

## [1.8.0] – [1.8.6]
- Feature: Partition Editor — bin file size auto-sync on open/refresh, size validation on save
- Feature: Make SPIFFS — image size selection (Auto / presets / manual)
- Feature: Project Folder — cleared state persists across restarts
- Fix: Flash — auto-runs `reconfigure` if `flasher_args.json` is missing
- Fix: IntelliSense — removed `intelliSenseMode` (auto-detected from compile_commands.json)

## [1.7.0] – [1.7.9]
- Feature: Partition Editor — SIZE field read-only when bin linked, auto-set from file size
- Feature: Project Folder — clear button, explicit selection only, edit button visibility
- Fix: Flash+Monitor — monitor runs as separate `idf.py` call; button state tracks actual monitor status

## [1.6.2] – [1.6.8]
- Feature: Make SPIFFS — replaced `mkspiffs` binary with bundled `spiffsgen.py`; parameters from `sdkconfig`
- Feature: Partition Editor — Link to bin (for `fat`/`spiffs` subtypes), auto-size from linked bin
- Fix: Flash+Monitor — erase+flash combined in one call, monitor launched separately

## [1.4.0] – [1.4.4]
- Feature: Partition Editor — Link to bin column, green indicator for linked files, unsaved changes warning
- Fix: code cleanup (removed duplicate handlers and dead code)

## [1.3.3]
- Feature: Partition Editor — added **Link to bin** column; patches `CMakeLists.txt` on save

## [1.1.0] – [1.1.8]
- Feature: Status bar — Build, Flash, Monitor buttons; Monitor toggle start/stop
- Feature: Create New Project wizard — include folder and REQUIRES dependencies steps
- Feature: Sidebar — edit button next to project folder
