'use strict';

const { vscode, path, fs,
        getActiveRoot, getValidIdfPath, getProvider,
        getMonitorRunning, getGlobalCtx,
        expandHome, getSdkVersion, cfg,
} = require('./helpers');

const { readExcludedComponents } = require('./components');

class EspItem extends vscode.TreeItem {
    constructor(label, opts = {}) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.command     = opts.command ? { command: opts.command, title: label } : undefined;
        this.iconPath    = opts.icon
            ? new vscode.ThemeIcon(opts.icon, opts.iconColor ? new vscode.ThemeColor(opts.iconColor) : undefined)
            : undefined;
        this.description = opts.desc   || '';
        this.tooltip     = opts.tooltip || label;
        if (opts.contextValue) this.contextValue = opts.contextValue;
        if (opts._compName)    this._compName    = opts._compName;
        if (opts.checkboxState !== undefined) {
            this.checkboxState = opts.checkboxState;
        }
    }
}

class EspGroup extends vscode.TreeItem {
    constructor(id, label, children, contextValue = undefined, defaultState = vscode.TreeItemCollapsibleState.Collapsed) {
        let state = defaultState;
        const _ctx = getGlobalCtx();
        if (_ctx) {
            const saved = _ctx.workspaceState.get(`espGroupState_${id}`);
            if (saved !== undefined) state = saved;
        }
        super(label, state);
        this.id = id;
        this._children = children;
        if (contextValue) this.contextValue = contextValue;
    }
}

class EspProvider {
    constructor() {
        this._emitter    = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;
        this.envWarnings = [];
    }
    refresh()                 { this._emitter.fire(undefined); }
    setEnvWarnings(warnings)  { this.envWarnings = warnings; this.refresh(); }
    getTreeItem(el)           { return el; }

    getChildren(el) {
        if (el instanceof EspGroup) return el._children;
        if (el) return [];

        const root          = getActiveRoot();
        const port          = cfg('comPort') || '—';
        const configuredIdf = expandHome(cfg('idfPath'));
        const validIdf      = getValidIdfPath();
        const folders       = vscode.workspace.workspaceFolders || [];
        const projectName   = root ? path.basename(root) : 'folder not found';

        const projectGroup = new EspGroup('projectGroup', '📁  Project Folder', [
            new EspItem(projectName, {
                command: 'esp.selectProject',
                icon:    root ? (folders.length > 1 ? 'folder-active' : 'folder') : 'error',
                tooltip: root || 'Select project workspace folder',
                desc:    root ? (folders.length > 1 ? 'click to change' : '') : 'click to select',
            }),
            ...( (() => {
                if (!root) return [];
                const compDir = path.join(root, 'components');
                let comps = [];
                try {
                    if (fs.existsSync(compDir))
                        comps = fs.readdirSync(compDir).filter(n => fs.statSync(path.join(compDir, n)).isDirectory());
                } catch {}
                const excludedComps = readExcludedComponents(root);
                const compItems = comps.map(name => {
                    const isExcluded = excludedComps.includes(name);
                    const item = new EspItem(name, {
                        icon:    isExcluded ? 'circle-slash' : 'package',
                        tooltip: isExcluded
                            ? `Component: ${name} (EXCLUDED from build)\n${path.join(compDir, name)}\n\nUncheck to include in build`
                            : `Component: ${name}\n${path.join(compDir, name)}\n\nUncheck to exclude from build`,
                        checkboxState: isExcluded
                            ? vscode.TreeItemCheckboxState.Unchecked
                            : vscode.TreeItemCheckboxState.Checked,
                    });
                    item.contextValue = 'componentItem';
                    item._compName = name;
                    item.description = isExcluded ? 'excluded' : '';
                    return item;
                });
                const compGroup = new EspGroup('componentsGroup', '📦  Components', compItems, undefined,
                    vscode.TreeItemCollapsibleState.Expanded);
                compGroup.contextValue = 'componentsGroup';
                return [ compGroup ];
            })() )
        ]);
        projectGroup.contextValue = root ? 'projectFolderGroupActive' : 'projectFolderGroup';

        const createProjectItem = new EspItem('Create New Project', {
            command: 'esp.createProject',
            icon: 'new-folder',
            tooltip: 'Create a new ESP8266 project from template'
        });

        const overrideFlash = cfg('overrideFlashConfig');
        const flashBaud   = cfg('flashBaud')            || 115200;
        const flashMode   = cfg('flashMode')            || 'dio';
        const flashFreq   = cfg('flashFreq')            || '40m';
        const flashSize   = cfg('flashSize')            || '2MB';
        const compressed  = cfg('useCompressedUpload')  ?? true;
        const beforeFlash = cfg('beforeFlashing')       || 'default_reset';
        const afterFlash  = cfg('afterFlashing')        || 'hard_reset';

        let idfLabel   = 'not set';
        let idfDesc    = 'click to specify';
        let idfTooltip = 'Click to specify ESP8266_RTOS_SDK folder';

        if (validIdf) {
            idfLabel   = path.basename(validIdf);
            idfTooltip = validIdf;
            idfDesc    = configuredIdf ? '' : '(from environment)';
            const sdkVer = getSdkVersion(validIdf);
            if (sdkVer) {
                idfDesc = sdkVer + (configuredIdf ? '' : ' (env)');
            }
        } else if (configuredIdf) {
            idfLabel   = path.basename(configuredIdf);
            idfDesc    = 'error (invalid path)';
            idfTooltip = 'tools/idf_tools.py not found';
        }

        const manualSettings = [
            new EspItem(`Port: ${port}`,                             { command: 'esp.selectPort',           icon: 'plug',            tooltip: 'Click to select port', desc: port === '—' ? 'not selected' : '' }),
            new EspItem(`Baud rate: ${flashBaud}`,                   { command: 'esp.selectFlashBaud',      icon: 'dashboard',       tooltip: 'Flash speed' }),
            new EspItem(`Flash Mode: ${flashMode}`,                  { command: 'esp.selectFlashMode',      icon: 'chip',            tooltip: 'SPI Flash mode' }),
            new EspItem(`Flash Freq: ${flashFreq}`,                  { command: 'esp.selectFlashFreq',      icon: 'pulse',           tooltip: 'SPI Flash frequency' }),
            new EspItem(`Flash Size: ${flashSize}`,                  { command: 'esp.selectFlashSize',      icon: 'database',        tooltip: 'SPI Flash size' }),
            new EspItem(`Compression: ${compressed ? 'Yes' : 'No'}`, { command: 'esp.toggleCompressedUpload', icon: 'file-zip',      tooltip: 'Use compression when flashing' }),
            new EspItem(`Esptool --before: ${beforeFlash}`,     { command: 'esp.selectBeforeFlashing', icon: 'debug-step-over', tooltip: 'Chip reset mode before flash (esptool --before)' }),
            new EspItem(`Esptool --after: ${afterFlash}`,       { command: 'esp.selectAfterFlashing',  icon: 'debug-step-out',  tooltip: 'Chip reset mode after flash (esptool --after)' }),
        ];

        let sourceItem;
        if (overrideFlash) {
            sourceItem = new EspGroup('sourceGroup', 'Source: Manual', manualSettings, 'sourceItem', vscode.TreeItemCollapsibleState.Expanded);
        } else {
            sourceItem = new EspItem('Source: Menuconfig', {
                command: 'esp.toggleOverride',
                icon: 'settings',
                tooltip: 'Click to switch to Manual settings',
                contextValue: 'sourceItem'
            });
        }
        if (!(sourceItem instanceof EspGroup)) {
            sourceItem.iconPath = new vscode.ThemeIcon('settings');
        }

        const pythonManualPath = cfg('pythonPath') || '';
        const pythonLabel = pythonManualPath
            ? `Python 3.7: ${pythonManualPath}`
            : 'Python 3.7: auto-detect';

        const manualToolpathGroup = new EspGroup('manualToolpathGroup', '🐍  Python Path Settings', [
            new EspItem(pythonLabel, {
                command: 'esp.setPythonPath',
                icon:    'symbol-misc',
                tooltip: pythonManualPath
                    ? `Manual: ${pythonManualPath}\nClick to change or switch to auto-detect`
                    : 'Auto-detect Python 3.7\nClick to set folder manually',
                desc: pythonManualPath ? '' : 'auto',
            }),
        ]);

        const pathSettingsGroup = (extraItems = []) => new EspGroup('pathSettingsGroup', '🔗  SDK Path Settings', [
            new EspItem(`RTOS IDF: ${idfLabel}`, { command: 'esp.selectIdf', icon: 'folder-opened', tooltip: idfTooltip, desc: idfDesc, contextValue: 'rtosIdfItem' }),
            ...extraItems,
        ]);

        const vscodeUtilitiesGroup = new EspGroup('vscodeUtilitiesGroup', '🔧  VScode Utilities', [
            new EspItem('Generate IntelliSense', { command: 'esp.generateIntelliSense', icon: 'symbol-class', tooltip: 'Generate .vscode/c_cpp_properties.json' }),
            new EspItem('Generate tasks.json',   { command: 'esp.generateTasks',        icon: 'tasklist',     tooltip: 'Generate .vscode/tasks.json (Ctrl+Shift+B → ESP: Build)' }),
        ]);

        const warningItems = this.envWarnings.map(w =>
            new EspItem(w.label, { command: w.command, icon: 'warning', tooltip: w.tooltip })
        );

        const _monitorRunning = getMonitorRunning();
        return [
            createProjectItem,
            projectGroup,

            new EspGroup('buildGroup', '⚙️  Build', [
                new EspItem('Build',             { command: 'esp.build',           icon: 'tools',       iconColor: 'charts.green', tooltip: 'idf.py build\nBuild the project',          contextValue: 'buildItem' }),
                new EspItem('Build App',         { command: 'esp.buildApp',        icon: 'file-binary', iconColor: 'charts.green', tooltip: 'idf.py app\nBuild only the app',            contextValue: 'buildItemSimple' }),
                new EspItem('Build Bootloader',  { command: 'esp.buildBootloader', icon: 'file-binary', iconColor: 'charts.green', tooltip: 'idf.py bootloader\nBuild only bootloader',     contextValue: 'buildItemSimple' }),
                new EspItem('Build Part. Table', { command: 'esp.buildPartition',  icon: 'file-binary', iconColor: 'charts.green', tooltip: 'idf.py partition_table\nBuild only partition table', contextValue: 'buildItemSimple' }),
            ]),

            new EspGroup('flashGroup', '⚡  Flash', [
                new EspItem('Flash',               { command: 'esp.flash',           icon: 'zap',   iconColor: 'charts.blue', tooltip: 'idf.py flash\nFlash the project',              contextValue: 'flashItem' }),
                new EspItem('Flash App',           { command: 'esp.flashApp',        icon: 'zap',   iconColor: 'charts.blue', tooltip: 'idf.py app-flash\nFlash the app only',          contextValue: 'flashAppItem' }),
                new EspItem('Flash Bootloader',    { command: 'esp.flashBootloader', icon: 'zap',   iconColor: 'charts.blue', tooltip: 'idf.py bootloader-flash\nFlash bootloader only',          contextValue: 'flashAppItem' }),
                new EspItem('Flash Part. Table',   { command: 'esp.flashPartition',  icon: 'zap',   iconColor: 'charts.blue', tooltip: 'idf.py partition_table-flash\nFlash partition table only', contextValue: 'flashAppItem' }),
                new EspItem('Flash File System',   { command: 'esp.flashFileSystem', icon: 'zap', iconColor: 'charts.blue', tooltip: 'esptool.py write_flash — flash filesystem .bin to partition\nAuto-detects type from CMakeLists.txt', contextValue: 'flashFsItem' }),
                new EspItem('Erase Flash',         { command: 'esp.eraseFlash',      icon: 'trash', iconColor: 'charts.blue', tooltip: 'idf.py erase_flash\nErase entire flash chip' }),
            ]),

            new EspGroup('monitorGroup', '🖥️  Monitor', [
                new EspItem('Monitor', _monitorRunning
                    ? { command: 'esp.stopMonitor', icon: 'debug-stop', iconColor: 'charts.purple', tooltip: 'Stop Monitor' }
                    : { command: 'esp.monitor',     icon: 'terminal',   iconColor: 'charts.purple', tooltip: 'Start Monitor\nidf.py monitor' }),
            ]),

            new EspGroup('cleanGroup', '🗑️  Clean', [
                new EspItem('Clean',      { command: 'esp.clean',     icon: 'trash',     iconColor: 'charts.red', tooltip: 'idf.py clean\nDelete build output files from the build directory' }),
                new EspItem('Full Clean', { command: 'esp.fullclean', icon: 'clear-all', iconColor: 'charts.red', tooltip: 'idf.py fullclean\nDelete the entire build directory contents' }),
            ]),

            new EspGroup('analysisGroup', '📊  Analysis', [
                new EspItem('Size',            { command: 'esp.size',           icon: 'graph', iconColor: 'charts.yellow', tooltip: 'idf.py size\nPrint basic size information about the app' }),
                new EspItem('Size Components', { command: 'esp.sizeComponents', icon: 'graph', iconColor: 'charts.yellow', tooltip: 'idf.py size-components\nPrint per-component size information' }),
                new EspItem('Size Files',      { command: 'esp.sizeFiles',      icon: 'graph', iconColor: 'charts.yellow', tooltip: 'idf.py size-files\nPrint per-source-file size information' }),
            ]),

            new EspGroup('settingsGroup', '⚙️  Serial Source Settings', [sourceItem]),

            new EspGroup('configureGroup', '🔩  SDK Configure', [
                new EspItem('Menuconfig',      { command: 'esp.menuconfig',  icon: 'settings-gear', iconColor: 'charts.orange', tooltip: 'idf.py menuconfig\nRun "menuconfig" project configuration tool\n⚠️ Requires terminal: min 80 columns × 19 rows' }),
                new EspItem('Reconfigure',     { command: 'esp.reconfigure', icon: 'refresh',       iconColor: 'charts.orange', tooltip: 'idf.py reconfigure\nRe-run CMake' }),
                new EspItem('Reset Projectconfig', { command: 'esp.resetConfig', icon: 'discard',       iconColor: 'charts.orange', tooltip: 'Delete sdkconfig — reset to defaults on next build' }),
            ]),

            pathSettingsGroup(),
            manualToolpathGroup,

            new EspGroup('utilsGroup', '🛠️  Utilities', [
                new EspItem('Make SPIFFS',              { command: 'esp.spiffs',          icon: 'database', iconColor: 'charts.foreground', tooltip: 'mkspiffs — pack data/ folder into SPIFFS image' }),
                new EspItem('Make FATFS',              { command: 'esp.fatfs',           icon: 'database', iconColor: 'charts.green',      tooltip: 'fatfsgen — pack data/ folder into FAT filesystem image' }),
                new EspItem('Make LittleFS',            { command: 'esp.littlefs',        icon: 'database', iconColor: 'charts.blue',       tooltip: 'littlefsgen — pack data/ folder into LittleFS image' }),
                new EspItem('Custom Partitions', { command: 'esp.partitionEditor', icon: 'layout',   iconColor: 'charts.foreground', tooltip: 'Open visual partition table editor' }),
            ]),

            new EspGroup('otaGroup', '📡  OTA Partition Mgmt (Serial)', [
                new EspItem('OTA Flash',        { command: 'esp.otaFlash',        icon: 'cloud-upload', iconColor: 'charts.green',  tooltip: 'Write firmware .bin to OTA partition via serial (otatool.py)\nRequires OTA partition table (ota_0/ota_1 + ota data)' }),
                new EspItem('OTA Switch',       { command: 'esp.otaSwitch',       icon: 'arrow-swap',   iconColor: 'charts.yellow', tooltip: 'Switch boot partition to ota_0 or ota_1\nDevice will boot from selected slot after reset' }),
                new EspItem('OTA Read Status',  { command: 'esp.otaRead',         icon: 'eye',          iconColor: 'charts.blue',   tooltip: 'Read OTA data partition from device\nShows which slot is currently selected for boot' }),
                new EspItem('OTA Erase',        { command: 'esp.otaErase',        icon: 'trash',        iconColor: 'charts.red',    tooltip: 'Erase OTA partition or otadata\nReset boot selection or clear OTA slot' }),
            ]),
            vscodeUtilitiesGroup,
        ];
    }
}

module.exports = {
    EspItem, EspGroup, EspProvider,
};
