'use strict';

const { vscode,
        cfg,
        getProvider,
        getMonitorRunning,
        getStatusBarPort, getStatusBarMonitor,
} = require('./helpers');

// ─── Status Bar ───────────────────────────────────────────────────────────────
function createStatusBar(ctx) {
    // Busy indicator — priority 106 → leftmost
    const _statusBarBusy = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 106);
    _statusBarBusy.command = 'workbench.action.terminal.focus';
    ctx.subscriptions.push(_statusBarBusy);

    // Build button — priority 105
    const _statusBarBuild = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 105);
    _statusBarBuild.text    = '$(tools) Build';
    _statusBarBuild.tooltip = 'ESP: Build project (idf.py build)';
    _statusBarBuild.command = 'esp.build';
    _statusBarBuild.show();
    ctx.subscriptions.push(_statusBarBuild);

    // Flash button — priority 104
    const _statusBarFlash = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 104);
    _statusBarFlash.text    = '$(zap) Flash';
    _statusBarFlash.tooltip = 'ESP: Flash project (idf.py flash)';
    _statusBarFlash.command = 'esp.flash';
    _statusBarFlash.show();
    ctx.subscriptions.push(_statusBarFlash);

    // Clean button — priority 103
    const _statusBarClean = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 103);
    _statusBarClean.text    = '$(trash) Clean';
    _statusBarClean.tooltip = 'ESP: Clean build output (idf.py clean)';
    _statusBarClean.command = 'esp.clean';
    _statusBarClean.show();
    ctx.subscriptions.push(_statusBarClean);

    // Monitor toggle button — priority 102
    const _statusBarMonitor = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
    refreshMonitorButton();
    ctx.subscriptions.push(_statusBarMonitor);

    // Menuconfig button — priority 101
    const _statusBarMenuconfig = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    _statusBarMenuconfig.text    = '$(settings-gear) Menuconfig';
    _statusBarMenuconfig.tooltip = 'ESP: Menuconfig (idf.py menuconfig)\nRun "menuconfig" project configuration tool\n⚠️ Requires terminal: min 80 columns × 19 rows';
    _statusBarMenuconfig.command = 'esp.menuconfig';
    _statusBarMenuconfig.show();
    ctx.subscriptions.push(_statusBarMenuconfig);

    // Port — priority 100 → last
    const _statusBarPort = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    _statusBarPort.command = 'esp.selectPort';
    ctx.subscriptions.push(_statusBarPort);

    // Store references in helpers state
    // (these are set via the module-level variables in helpers)
    // We need to update helpers' internal references — use setters
    require('./helpers')._setStatusBarItems({
        port: _statusBarPort,
        busy: _statusBarBusy,
        build: _statusBarBuild,
        flash: _statusBarFlash,
        monitor: _statusBarMonitor,
        clean: _statusBarClean,
        menuconfig: _statusBarMenuconfig,
    });

    refreshStatusBar();
}

function refreshMonitorButton() {
    const _statusBarMonitor = getStatusBarMonitor();
    if (!_statusBarMonitor) return;
    const _monitorRunning = getMonitorRunning();
    if (_monitorRunning) {
        _statusBarMonitor.text            = '$(debug-stop) Monitor';
        _statusBarMonitor.tooltip         = 'Stop Monitor';
        _statusBarMonitor.command         = 'esp.stopMonitor';
        _statusBarMonitor.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
        _statusBarMonitor.text            = '$(terminal) Monitor';
        _statusBarMonitor.tooltip         = 'Start Monitor\nidf.py monitor';
        _statusBarMonitor.command         = 'esp.monitor';
        _statusBarMonitor.backgroundColor = undefined;
    }
    _statusBarMonitor.show();
    vscode.commands.executeCommand('setContext', 'esp.monitorRunning', _monitorRunning);
    if (getProvider()) getProvider().refresh();
}

function refreshStatusBar() {
    const _statusBarPort = getStatusBarPort();
    if (!_statusBarPort) return;
    const port          = cfg('comPort');
    const overrideFlash = cfg('overrideFlashConfig');
    const modeLabel     = overrideFlash ? 'Manual' : 'Menuconfig';
    if (port) {
        _statusBarPort.text            = `$(plug) ${port}`;
        _statusBarPort.tooltip         = `ESP port: ${port} [${modeLabel} mode]\nClick to change port`;
        _statusBarPort.backgroundColor = undefined;
    } else {
        _statusBarPort.text            = `$(plug) No port`;
        _statusBarPort.tooltip         = `ESP: No port selected  [${modeLabel} mode]\nClick to select port`;
        _statusBarPort.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    _statusBarPort.show();
}

module.exports = {
    createStatusBar, refreshMonitorButton, refreshStatusBar,
};
