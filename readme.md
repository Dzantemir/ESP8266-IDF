# ESP8266-IDF

A convenient VS Code extension for developing with **ESP8266-series** chips.  
Supports **ESP8266_RTOS_SDK** via `idf.py`.

**Supported chips:** ESP8266 (ESP8266EX), ESP8285 (ESP8285N08)


---

## Features

### ⚙️ Build
- **Build** — full project build with configurable pre/post actions
- **Build App** — application only
- **Build Bootloader** — bootloader only
- **Build Partition Table** — partition table only
- Auto-saves all unsaved files before build
- Pre-build action: none / clean / full clean
- Post-build action: none / flash / flash app
- Optional post-build analysis: size / size-components / size-files
- COM port verified before build when post-build flash is selected

### ⚡ Flash
- **Flash** — flash full firmware to device
- **Flash App** — flash application only
- **Flash Bootloader** — flash bootloader only
- **Flash Partition Table** — flash partition table only
- **Flash File System** — flash filesystem image (.bin) to partition
  - Auto-detects filesystem type (SPIFFS / FATFS / LittleFS) from `CMakeLists.txt`
  - Reads `esptool_py_flash_project_args` block to determine type and partition offset
  - Falls back to manual selection if auto-detect fails
  - Auto-detects partition offset from partition table CSV
  - Uses `esptool.py write_flash` under the hood
- **Erase Flash** — full flash erase
- Configurable erase before flash
- Configurable action after flash: none / monitor
- Port availability check before flashing
- If `build/flasher_args.json` is missing — automatically runs `reconfigure` first, then flash

### 🖥️ Monitor
- **Monitor** — toggles between start/stop (button changes state)
- Status bar shows Monitor button — red when running
- Configurable baud rate
- When terminal is killed (trash icon) — monitor state resets automatically
- Flash + Monitor runs as two separate `idf.py` calls: flash completes first, then monitor starts
- Monitor button activates only when monitor actually starts (not during flash)

### 🔧 SDK Configure
- **Menuconfig** — visual configuration (`idf.py menuconfig`)
- **Reconfigure** — re-run CMake
- **Reset Projectconfig** — delete `sdkconfig` and restore defaults on next build

### 📁 Project Folder
- Shows active project name
- **📂** root CMake editor — opens webview editor for root `CMakeLists.txt`
- **📄** main CMake editor — opens webview editor for `main/CMakeLists.txt`
- **✕** clear button — releases active project folder (visible only when folder is selected)
- Project folder selection always shows QuickPick menu — no auto-selection
- Cleared folder state persists across VS Code restarts
- **📦 Components** — lists `components/` subfolders with **checkboxes**
  - ☑️ / ☐ — toggle component compilation (writes `EXCLUDE_COMPONENTS` to `CMakeLists.txt`)
  - `[+]` — Create New Component
  - `[✏️]` — open CMake webview editor for component
  - `[🗑]` — delete component

### ⚙️ CMake Webview Editor
Visual editor for `CMakeLists.txt` — component, main, and root files.
- **Format toggle** — switch between Modern (`idf_component_register`) and Legacy (`set(COMPONENT_SRCS ...)` + `register_component()`) with header dropdown and badge
- All `idf_component_register()` parameters: SRCS/SRC_DIRS, EXCLUDE_SRCS, INCLUDE_DIRS, PRIV_INCLUDE_DIRS, REQUIRES, PRIV_REQUIRES, EMBED_FILES, EMBED_TXTFILES, LDFRAGMENTS
- Radio toggle between explicit SRCS list and auto-discover SRC_DIRS
- Built-in component picker with search/filter for REQUIRES/PRIV_REQUIRES
- **Variable Reference Tags** — `${VARIABLE}` references in REQUIRES/PRIV_REQUIRES are shown as distinctive orange tags with 🔗 icon, clearly separating them from literal component names (grey tags)
  - Type `${COMPONENT_REQUIRES}` or any `${VARIABLE}` in the REQUIRES/PRIV_REQUIRES input field to add a variable reference
  - Variable references can also be added via the component picker
- **Custom CMake Code (preamble)** — collapsible section for editing CMake code that runs before `idf_component_register()` (e.g. `if(CONFIG_BT_ENABLED) set(COMPONENT_REQUIRES bt) endif()` conditional blocks)
  - Monospace textarea with syntax-highlighted preview
  - Collapsed by default, shows "(empty)" when no preamble code exists
  - Variable reference warning appears when `${...}` patterns are detected in dependencies
- **Custom CMake Code (postamble)** — collapsible section for editing CMake code that appears after `project()` in root CMakeLists.txt
  - Includes partition bin links, `if(CONFIG_...)` blocks, `esptool_py_flash_project_args()` calls
  - Collapsed by default, syntax-highlighted in CMake Preview
- Live CMake preview with syntax highlighting (keywords, variables, strings, comments)
- Multiple editors can be open simultaneously
- Root editor: project name, EXCLUDE_COMPONENTS, EXTRA_COMPONENT_DIRS
- **Busy State Protection** — save is disabled during build/flash to prevent file corruption

### ➕ Create New Project
Webview-based project generator — all settings on one page:
- Parent folder browser, project name with live validation
- **CMake style selector** — Modern (`idf_component_register`) or Legacy (`register_component`) with Format dropdown and badge in header
- Header file location: `include/` folder, same folder as `.c`, or none
- Excluded components picker
- Live preview of all files to be created
- Project automatically added to workspace and set as active after creation

### ➕ Create New Component
Webview-based component generator — all settings on one page:
- Component name with live validation and duplicate check
- **CMake style selector** — Modern (`idf_component_register`) or Legacy (`register_component`) with Format dropdown and badge in header
- Source files (.c) with inline add/remove
- Header file location: `include/` folder, same folder as `.c`, or none
- Component dependencies (REQUIRES) picker with search/filter
- Live CMake preview with syntax highlighting

### ✏️ Edit Component
Webview-based component editor — all settings on one page:
- Pre-populated from existing CMakeLists.txt (name, sources, headers, dependencies)
- Component rename with automatic folder rename
- Source files (.c) with inline add/remove + auto-detect from directory
- Header file location: `include/` folder, same folder as `.c`, or none (pre-selected)
- Component dependencies (REQUIRES) picker with search/filter (pre-populated)
- Live CMake preview with syntax highlighting
- "RENAMED" badge shown when component name is changed

### ⚙️ Settings Editor
Unified visual settings panel — per-command pre/post actions for Build and Flash:
- **Build tab**: Per-command Before/After actions for Build, Build App, Build Bootloader, Build Partition Table + shared Post-Build Analysis (Build only)
- **Flash tab**: Per-command Before/After actions for Flash, Flash App, Flash Bootloader, Flash Partition Table, Flash File System
- Esptool Connection settings and Override Flash Config are accessible via VS Code native Settings UI and sidebar tree commands (not in the webview)
- All settings displayed and editable with instant save

### 🛠️ Make SPIFFS
Pack any folder into a SPIFFS binary image using the bundled `spiffsgen.py` script.

- Opens folder picker (defaults to project root)
- **Image size**: Auto (minimum size calculated by spiffsgen.py) or manual input (bytes / KB / hex)
- SPIFFS parameters:
  - `CONFIG_SPIFFS_PAGE_SIZE` from `sdkconfig` → `--page-size`
  - `CONFIG_WL_SECTOR_SIZE` from `sdkconfig` → `--block-size`
  - `--obj-name-len 32` (spiffsgen.py default, not configurable via ESP8266_RTOS_SDK)
  - `--meta-len 4` (spiffsgen.py default, not configurable via ESP8266_RTOS_SDK)
  - `--use-magic` / `--use-magic-len` always enabled (spiffsgen.py defaults)
- `--aligned-obj-ix-tables` always enabled (required for ESP8266)
- Checks Python → SDK folder → project folder before running
- Saves `<foldername>_spiffs.bin` to project root

### 🛠️ Make FATFS
Pack any folder into a FAT filesystem image using the bundled `fatfsgen.py` / `wl_fatfsgen.py` scripts.

- Opens folder picker (defaults to project root)
- **Image size**: Auto (minimum size auto-detected by fatfsgen.py), presets, or manual input (bytes / KB / MB / hex)
- FATFS parameters:
  - `CONFIG_WL_SECTOR_SIZE` from `sdkconfig` → `--sector_size`
  - `--sectors_per_cluster 1` (safe default, not configurable via ESP8266_RTOS_SDK)
  - `--long_name_support` always enabled for LFN compatibility
- **Wear levelling mode** selection: plain FATFS, WL performance, or WL safe mode
- When WL is selected, uses `wl_fatfsgen.py` instead of `fatfsgen.py`
- **Zero dependencies** — all scripts use only Python standard library (`struct`, `argparse`, `os`, etc.)
- Checks Python → SDK folder → project folder before running
- Saves `<foldername>_fatfs.bin` to project root

### 🛠️ Make LittleFS
Pack any folder into a LittleFS v2 filesystem image using the bundled `littlefsgen.py` script.

- Opens folder picker (defaults to project root)
- **Image size**: Auto (calculated from content), presets, or manual input (bytes / KB / hex)
- LittleFS parameters:
  - `CONFIG_WL_SECTOR_SIZE` from `sdkconfig` → `--block_size`
  - `--name_max 32` (matches esp_littlefs component default)
- **Pure Python** — no external dependencies, compatible with Python 3.7+
- Supports inline files (small files stored in metadata pair) and CTZ skip-list files (large files)
- Additional CLI options: `--disk_version`, `--compact`, `--no-pad`, `--follow-symlinks`
- Checks Python → SDK folder → project folder before running
- Saves `<foldername>_littlefs.bin` to project root

> ### 🗂️ Partition Table Editor
>
> Visual editor for ESP8266 flash partition tables — drag-and-drop, flash map, validation, bin linking.
>
> - Drag-and-drop partition reordering (drag handle `⠿`)
> - Flash map visualization
> - **Default Partition** — standard single factory app layout
> - **Auto Offsets** — automatic offset recalculation from PT end
> - Reads PT offset, flash size and CSV filename from `sdkconfig`
> - **Link to bin** — available only for `fat` and `spiffs/littlefs` subtypes
>   - When a bin file is linked — SIZE is set automatically to match file size (rounded to 4096)
>   - SIZE field becomes read-only while a bin is linked
>   - On open — bin file sizes silently re-checked and SIZE updated if file changed
>   - On **Refresh** — bin file sizes re-checked, partitions updated, missing files unlinked
>   - On save — bin file checked against available area; save blocked if file is too large
>   - **Cross-platform CMake paths** — bin file paths use `${CMAKE_CURRENT_SOURCE_DIR}/filename.bin` instead of absolute paths for Windows/Linux/macOS compatibility
>   - **Auto-copy bin files** — files outside the project directory are automatically copied to project root
>   - **Name collision handling** — overwrite, keep existing, or auto-rename with numeric suffix
>   - **Migration of old absolute paths** — old-style absolute paths are automatically converted to `${CMAKE_CURRENT_SOURCE_DIR}/` format
> - Unsaved changes warning on close
> - New partitions get unique names automatically
> - Validation: alignment, overlaps, name length, duplicate names, custom subtype range
> - TYPE: `app` / `data` / `custom…` (hex subtype 0x00–0xFE)
> - DATA subtypes: `nvs`, `ota`, `phy`, `fat`, `spiffs/littlefs`
>   - `spiffs/littlefs` — partition subtype `0x82`, used by both SPIFFS and LittleFS filesystems. Saved as `spiffs` in CSV (ESP-IDF format).
> - APP subtypes: `factory`, `ota_0`, `ota_1`

### 📡 OTA Partition Management (Serial)
- **OTA Flash** — write firmware to OTA partition slot via serial
- **OTA Switch** — change boot partition (ota_0 / ota_1)
- **OTA Read Status** — read current OTA partition status
- **OTA Erase** — erase OTA partition data
- Serial port device connectivity check before OTA commands
- Auto-detects OTA partition layout from CSV; warns if no OTA slots found

### 📊 Analysis
- **Size** — firmware size report
- **Size Components** — per-component breakdown
- **Size Files** — per-file breakdown

### 🔧 VSCode Utilities
- **Generate IntelliSense** — creates `.vscode/c_cpp_properties.json`
  - Uses `compile_commands.json` as primary source (most accurate for Xtensa)
  - No `intelliSenseMode` override — C/C++ extension auto-detects from compile commands
- **Generate tasks.json** — adds ESP build tasks for `Ctrl+Shift+B`

**Auto-Generate Dev Files**
- When `autoGenerateOnOpen` is enabled (default: `true`), the extension auto-generates `.vscode/c_cpp_properties.json` and `.vscode/tasks.json` when a project is opened
- Only generates files that don't exist yet — existing files are never overwritten
- `c_cpp_properties.json` uses `compile_commands.json` as primary source for IntelliSense (most accurate for Xtensa)
- `tasks.json` includes Build, Build App, Build Bootloader, Clean, Full Clean, Size tasks
- Problem matcher `$esp-idf-gcc` is registered for GCC error/warning format

### 📊 Status Bar
Quick access buttons: **Build** → **Flash** → **Clean** → **Monitor** → **Menuconfig** → **COM port**

### ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+B` | Build |
| `Ctrl+Alt+F` | Flash |
| `Ctrl+Alt+M` | Monitor (toggle) |
| `Ctrl+Alt+G` | Menuconfig |
| `Ctrl+Alt+E` | Erase Flash |

---

## Requirements

- [Python 3.7.x](https://www.python.org/downloads/release/python-379/) — **must be 3.7.x**
- [ESP8266_RTOS_SDK](https://github.com/espressif/ESP8266_RTOS_SDK)

---

## Setup

1. Install the extension
2. Set SDK path — click **RTOS IDF: not set** in sidebar
3. Install build tools — extension installs automatically via `idf_tools.py`
4. Select project folder — click **Project Folder → folder not found** in sidebar
5. Select COM port via **Serial Source Settings → Port**
6. Run **Build** → **Flash** → **Monitor**

---

## Extension Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `esp8266-idf.idfPath` | Path to ESP8266_RTOS_SDK | |
| `esp8266-idf.pythonPath` | Manual path to Python 3.7 | |
| `esp8266-idf.comPort` | COM port (`COM3` or `/dev/ttyUSB0`) | |
| `esp8266-idf.flashBaud` | Flash baud rate | `115200` |
| `esp8266-idf.flashSize` | Flash size | `2MB` |
| `esp8266-idf.flashMode` | SPI flash mode | `dio` |
| `esp8266-idf.flashFreq` | SPI flash frequency | `40m` |
| `esp8266-idf.monitorBaud` | Monitor baud rate | `74880` |
| `esp8266-idf.preBuildAction` | Action before Build (none/clean/fullclean) | `none` |
| `esp8266-idf.postBuildAction` | Action after successful build | `none` |
| `esp8266-idf.preBuildAppAction` | Action before Build App (none/clean/fullclean) | `none` |
| `esp8266-idf.postBuildAppAction` | Action after successful Build App (none/app_flash) | `none` |
| `esp8266-idf.preBuildBootloaderAction` | Action before Build Bootloader (none/clean/fullclean) | `none` |
| `esp8266-idf.postBuildBootloaderAction` | Action after successful Build Bootloader (none/flash_bootloader) | `none` |
| `esp8266-idf.preBuildPartitionAction` | Action before Build Partition Table (none/clean/fullclean) | `none` |
| `esp8266-idf.postBuildPartitionAction` | Action after successful Build Partition Table (none/flash_partition) | `none` |
| `esp8266-idf.postBuildAnalysis` | Analysis commands to run automatically after a successful build (array: size/size-components/size-files) | `[]` |
| `esp8266-idf.preFlashAction` | Before flash: `none` / `erase` | `none` |
| `esp8266-idf.postFlashAction` | After flash: `none` / `monitor` | `none` |
| `esp8266-idf.preFlashAppAction` | Action before Flash App (none) | `none` |
| `esp8266-idf.postFlashAppAction` | Action after successful Flash App (none/monitor) | `none` |
| `esp8266-idf.preFlashBootloaderAction` | Action before Flash Bootloader (none) | `none` |
| `esp8266-idf.postFlashBootloaderAction` | Action after successful Flash Bootloader (none/monitor) | `none` |
| `esp8266-idf.preFlashPartitionAction` | Action before Flash Partition Table (none) | `none` |
| `esp8266-idf.postFlashPartitionAction` | Action after successful Flash Partition Table (none/monitor) | `none` |
| `esp8266-idf.postFlashFsAction` | Action after successful flash filesystem (none/monitor) | `none` |
| `esp8266-idf.beforeFlashing` | Chip reset before flash (esptool `--before`) | `default_reset` |
| `esp8266-idf.afterFlashing` | Chip reset after flash (esptool `--after`) | `hard_reset` |
| `esp8266-idf.useCompressedUpload` | Compressed upload (`-z`) | `true` |
| `esp8266-idf.overrideFlashConfig` | Use manual flash settings | `false` |
| `esp8266-idf.reuseTerminal` | Reuse existing terminal | `true` |
| `esp8266-idf.saveSettingsToWorkspace` | Save settings per-project | `true` |
| `esp8266-idf.autoGenerateOnOpen` | Automatically generate IntelliSense config and tasks.json on project open (only if files don't exist yet) | `true` |
| `esp8266-idf.shellPath` | Shell path (e.g. powershell.exe or /bin/bash). Leave empty for auto-detection. | |
| `esp8266-idf.useExecutionPolicyBypass` | On Windows, use -ExecutionPolicy Bypass for PowerShell | `true` |

---

## Supported Platforms

- ✅ Windows 10/11 (PowerShell)
- ✅ Linux (bash)
- ✅ macOS (bash/zsh)

---

## Links

- [GitHub Repository](https://github.com/Dzantemir/ESP8266-IDF)
- [ESP8266_RTOS_SDK](https://github.com/espressif/ESP8266_RTOS_SDK)
- [Report Issues](https://github.com/Dzantemir/ESP8266-IDF/issues)

---

## License

MIT
