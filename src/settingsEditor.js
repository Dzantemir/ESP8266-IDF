'use strict';

const { vscode, path, fs,
        getActiveRoot, getValidIdfPath, getGlobalCtx, getProvider,
        checkBusy, warnNoProject, log, cfg, setCfg,
} = require('./helpers');

let _settingsPanel = null;

function cmdSettingsEditor(mode = 'build') {
    if (checkBusy()) return;
    const root = getActiveRoot();
    if (!root) { warnNoProject(); return; }

    if (_settingsPanel) {
        _settingsPanel.reveal(vscode.ViewColumn.One);
        // Send mode switch message
        _settingsPanel.webview.postMessage({ command: 'switchMode', mode });
        return;
    }

    // Gather current settings
    const currentSettings = {
        preBuildAction:    cfg('preBuildAction')    || 'none',
        postBuildAction:   cfg('postBuildAction')   || 'none',
        postBuildAnalysis: cfg('postBuildAnalysis') || [],
        preBuildAppAction:    cfg('preBuildAppAction')    || 'none',
        postBuildAppAction:   cfg('postBuildAppAction')   || 'none',
        preBuildBootloaderAction:    cfg('preBuildBootloaderAction')    || 'none',
        postBuildBootloaderAction:   cfg('postBuildBootloaderAction')   || 'none',
        preBuildPartitionAction:    cfg('preBuildPartitionAction')    || 'none',
        postBuildPartitionAction:   cfg('postBuildPartitionAction')   || 'none',
        preFlashAction:    cfg('preFlashAction')    || 'none',
        postFlashAction:   cfg('postFlashAction')   || 'none',
        postFlashAppAction:   cfg('postFlashAppAction')   || 'none',
        postFlashBootloaderAction:   cfg('postFlashBootloaderAction')   || 'none',
        postFlashPartitionAction:   cfg('postFlashPartitionAction')   || 'none',
        postFlashFsAction: cfg('postFlashFsAction') || 'none',
    };

    const panel = vscode.window.createWebviewPanel(
        'espSettingsEditor',
        'ESP — Settings',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(getGlobalCtx().extensionPath, 'media')),
            ],
        }
    );

    _settingsPanel = panel;

    // Build HTML
    panel.webview.html = _getSettingsHtml(currentSettings, mode);

    // Message handler
    panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'saveSettings') {
            try {
                const s = msg.data;
                // Save all settings
                if (s.preBuildAction !== undefined) await setCfg('preBuildAction', s.preBuildAction);
                if (s.postBuildAction !== undefined) await setCfg('postBuildAction', s.postBuildAction);
                if (s.postBuildAnalysis !== undefined) await setCfg('postBuildAnalysis', s.postBuildAnalysis);
                if (s.preBuildAppAction !== undefined) await setCfg('preBuildAppAction', s.preBuildAppAction);
                if (s.postBuildAppAction !== undefined) await setCfg('postBuildAppAction', s.postBuildAppAction);
                if (s.preBuildBootloaderAction !== undefined) await setCfg('preBuildBootloaderAction', s.preBuildBootloaderAction);
                if (s.postBuildBootloaderAction !== undefined) await setCfg('postBuildBootloaderAction', s.postBuildBootloaderAction);
                if (s.preBuildPartitionAction !== undefined) await setCfg('preBuildPartitionAction', s.preBuildPartitionAction);
                if (s.postBuildPartitionAction !== undefined) await setCfg('postBuildPartitionAction', s.postBuildPartitionAction);
                if (s.preFlashAction !== undefined) await setCfg('preFlashAction', s.preFlashAction);
                if (s.postFlashAction !== undefined) await setCfg('postFlashAction', s.postFlashAction);
                if (s.postFlashAppAction !== undefined) await setCfg('postFlashAppAction', s.postFlashAppAction);
                if (s.postFlashBootloaderAction !== undefined) await setCfg('postFlashBootloaderAction', s.postFlashBootloaderAction);
                if (s.postFlashPartitionAction !== undefined) await setCfg('postFlashPartitionAction', s.postFlashPartitionAction);
                if (s.postFlashFsAction !== undefined) await setCfg('postFlashFsAction', s.postFlashFsAction);

                vscode.window.showInformationMessage('✅ ESP settings saved.');
                if (getProvider()) getProvider().refresh();
                const { refreshStatusBar } = require('./statusBar');
                refreshStatusBar();
            } catch (e) {
                vscode.window.showErrorMessage(`ESP: Failed to save settings: ${e.message}`);
            }
            return;
        }

        if (msg.command === 'refreshSettings') {
            // Re-read current settings and send back
            const freshSettings = {
                preBuildAction:    cfg('preBuildAction')    || 'none',
                postBuildAction:   cfg('postBuildAction')   || 'none',
                postBuildAnalysis: cfg('postBuildAnalysis') || [],
                preBuildAppAction:    cfg('preBuildAppAction')    || 'none',
                postBuildAppAction:   cfg('postBuildAppAction')   || 'none',
                preBuildBootloaderAction:    cfg('preBuildBootloaderAction')    || 'none',
                postBuildBootloaderAction:   cfg('postBuildBootloaderAction')   || 'none',
                preBuildPartitionAction:    cfg('preBuildPartitionAction')    || 'none',
                postBuildPartitionAction:   cfg('postBuildPartitionAction')   || 'none',
                preFlashAction:    cfg('preFlashAction')    || 'none',
                postFlashAction:   cfg('postFlashAction')   || 'none',
                postFlashAppAction:   cfg('postFlashAppAction')   || 'none',
                postFlashBootloaderAction:   cfg('postFlashBootloaderAction')   || 'none',
                postFlashPartitionAction:   cfg('postFlashPartitionAction')   || 'none',
                postFlashFsAction: cfg('postFlashFsAction') || 'none',
            };
            panel.webview.postMessage({ command: 'settingsUpdate', data: freshSettings });
            return;
        }
    });

    panel.onDidDispose(() => {
        _settingsPanel = null;
    }, null, []);
}

function _getSettingsHtml(currentSettings, mode) {
    const templatePath = path.join(getGlobalCtx().extensionPath, 'media', 'settings-editor.html');
    let html;
    if (fs.existsSync(templatePath)) {
        html = fs.readFileSync(templatePath, 'utf8');
    } else {
        html = '<!DOCTYPE html><html><body><h2>Settings template not found</h2></body></html>';
    }
    html = html.replace(/\{\{INITIAL_SETTINGS\}\}/g, JSON.stringify(currentSettings));
    html = html.replace(/\{\{INITIAL_MODE\}\}/g, mode);
    return html;
}

function closeSettingsPanel() {
    if (_settingsPanel) {
        _settingsPanel.dispose();
        _settingsPanel = null;
    }
}

module.exports = {
    cmdSettingsEditor,
    closeSettingsPanel,
};
