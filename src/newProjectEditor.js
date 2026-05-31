'use strict';

const { vscode, path, fs,
        getActiveRoot, setActiveRoot, getValidIdfPath, getGlobalCtx, getProvider,
        checkBusy, warnNoProject, setPortCache, log,
} = require('./helpers');

const { scanComponents, pickExcludedComponents } = require('./components');
const StatusBar = require('./statusBar');

// ╔══════════════════════════════════════════════════════════════════╗
// ║  MODULE-LEVEL STATE                                                 ║
// ╚══════════════════════════════════════════════════════════════════╝
let _newProjectPanel = null;

// ╔══════════════════════════════════════════════════════════════════╗
// ║  COMMANDS                                                           ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Open the New Project webview editor.
 */
function cmdNewProjectEditor() {
    if (checkBusy()) return;
    if (_newProjectPanel) {
        _newProjectPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    // Gather available SDK components for the excluded components picker
    const idfPath = getValidIdfPath();
    const sdkComps = idfPath ? scanComponents(path.join(idfPath, 'components')) : [];

    // Create webview panel
    const panel = vscode.window.createWebviewPanel(
        'espNewProjectEditor',
        'ESP — Create New Project',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(getGlobalCtx().extensionPath, 'media')),
            ],
        }
    );

    _newProjectPanel = panel;

    // Build HTML
    panel.webview.html = _getNewProjectHtml(sdkComps);

    // ─── Message handler ──────────────────────────────────────────────
    panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'pickParentFolder') {
            try {
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    title: 'Select Parent Folder for New Project',
                    openLabel: 'Select Folder',
                });
                if (uris && uris.length > 0) {
                    panel.webview.postMessage({
                        command: 'setParentFolder',
                        path: uris[0].fsPath,
                    });
                }
            } catch (e) {
                vscode.window.showErrorMessage(`ESP: Folder picker failed: ${e.message}`);
            }
            return;
        }

        if (msg.command === 'checkFolderExists') {
            const { parentDir, projectName } = msg;
            const exists = parentDir && fs.existsSync(path.join(parentDir, projectName));
            panel.webview.postMessage({
                command: 'folderExistsResult',
                exists: !!exists,
            });
            return;
        }

        if (msg.command === 'pickExcludedComponents') {
            try {
                const excluded = await pickExcludedComponents(null);
                if (excluded === undefined) return; // cancelled
                panel.webview.postMessage({
                    command: 'setPickedComponents',
                    type: 'exclude',
                    components: excluded,
                });
            } catch (e) {
                vscode.window.showErrorMessage(`ESP: Component picker failed: ${e.message}`);
            }
            return;
        }

        if (msg.command === 'createProject') {
            try {
                const { parentDir, projectName, cmakeStyle, headersChoice, excludeComponents } = msg.data;

                // Final validation
                if (!parentDir || !projectName) {
                    vscode.window.showErrorMessage('ESP: Parent folder and project name are required.');
                    return;
                }
                if (!projectName.match(/^[a-zA-Z0-9_-]+$/)) {
                    vscode.window.showErrorMessage('ESP: Invalid project name.');
                    return;
                }
                const projectDir = path.join(parentDir, projectName);
                if (fs.existsSync(projectDir)) {
                    vscode.window.showErrorMessage(`ESP: Folder already exists: ${projectDir}`);
                    return;
                }

                // Create the project
                _createRtosProject(projectDir, projectName, cmakeStyle || 'legacy', headersChoice, excludeComponents);

                log(`New project created: ${projectDir}`);

                // Refresh tree provider
                const provider = getProvider();
                if (provider) provider.refresh();

                // Close the webview panel
                panel.dispose();

                // Automatically add project folder to workspace and switch to it
                _openProjectInWorkspace(projectDir);

                // Show simple info message (no button — workspace was already updated)
                vscode.window.showInformationMessage(
                    `✅ Project "${projectName}" created and added to workspace.`
                );

            } catch (e) {
                panel.webview.postMessage({
                    command: 'projectCreateError',
                    error: e.message,
                });
                vscode.window.showErrorMessage(`ESP: Failed to create project: ${e.message}`);
            }
            return;
        }
    });

    // ─── Panel lifecycle ──────────────────────────────────────────────
    panel.onDidDispose(() => {
        _newProjectPanel = null;
    }, null, []);
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  PROJECT CREATION                                                   ║
// ╚══════════════════════════════════════════════════════════════════╝

function _createRtosProject(projectDir, name, cmakeStyle = 'modern', headersChoice = 'dot', excluded = []) {
    fs.mkdirSync(path.join(projectDir, 'main'), { recursive: true });

    if (headersChoice === 'include') {
        fs.mkdirSync(path.join(projectDir, 'main', 'include'), { recursive: true });
    }

    // ── Root CMakeLists.txt ─────────────────────────────────────
    const cmakeMinVer = cmakeStyle === 'modern' ? '3.16' : '3.5';
    let rootCmake = `cmake_minimum_required(VERSION ${cmakeMinVer})\n\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\n`;
    if (excluded.length) {
        rootCmake += `set(EXCLUDE_COMPONENTS ${excluded.join(' ')})\n`;
    }
    rootCmake += `project(${name})\n`;
    fs.writeFileSync(path.join(projectDir, 'CMakeLists.txt'), rootCmake);

    // ── main/CMakeLists.txt — depends on style ──────────────────
    let mainCmake;

    if (cmakeStyle === 'modern') {
        // Modern (ESP-IDF v4.x/v5.x): idf_component_register(SRCS ... INCLUDE_DIRS ...)
        const includeDir = headersChoice === 'include' ? '"include"'
                        : headersChoice === 'dot'     ? '"."'
                        : null;
        if (includeDir) {
            mainCmake = `idf_component_register(\n    SRCS "main.c"\n    INCLUDE_DIRS ${includeDir}\n)\n`;
        } else {
            mainCmake = `idf_component_register(\n    SRCS "main.c"\n)\n`;
        }
    } else {
        // Legacy (ESP8266 RTOS SDK v3.x): register_component() + COMPONENT_SRCS
        const incLineLegacy = headersChoice === 'include' ? '\nset(COMPONENT_ADD_INCLUDEDIRS "include")'
                      : headersChoice === 'dot'     ? '\nset(COMPONENT_ADD_INCLUDEDIRS ".")'
                      : '';
        mainCmake = `set(COMPONENT_SRCS "main.c")${incLineLegacy}\n\nregister_component()\n`;
    }

    fs.writeFileSync(path.join(projectDir, 'main', 'CMakeLists.txt'), mainCmake);

    // ── Header file ─────────────────────────────────────────────
    if (headersChoice !== 'none') {
        const headerDir = headersChoice === 'include'
            ? path.join(projectDir, 'main', 'include')
            : path.join(projectDir, 'main');
        const guard = name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_H';
        fs.writeFileSync(path.join(headerDir, `${name}.h`),
`#ifndef ${guard}
#define ${guard}

// TODO: declare ${name} API

#endif // ${guard}
`);
    }

    // ── main.c ──────────────────────────────────────────────────
    fs.writeFileSync(path.join(projectDir, 'main', 'main.c'),
`#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void app_main()
{
    printf("Hello from ${name}!\\n");
    while (1) {
        vTaskDelay(1000 / portTICK_PERIOD_MS);
    }
}
`);
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  OPEN PROJECT IN WORKSPACE                                          ║
// ╚══════════════════════════════════════════════════════════════════╝

function _openProjectInWorkspace(projectDir) {
    try {
        if (!projectDir || !fs.existsSync(projectDir)) return;

        const n = vscode.workspace.workspaceFolders?.length || 0;
        vscode.workspace.updateWorkspaceFolders(n, 0, { uri: vscode.Uri.file(projectDir) });

        // Set as active root
        setActiveRoot(projectDir);
        setPortCache({ data: [], timestamp: 0 });
        if (getGlobalCtx()) getGlobalCtx().workspaceState.update('espActiveRoot', projectDir);

        // Refresh
        const provider = getProvider();
        if (provider) provider.refresh();
        StatusBar.refreshStatusBar();

    } catch (e) {
        vscode.window.showErrorMessage(`ESP: Failed to open project: ${e.message}`);
    }
}

/**
 * Close the New Project webview panel if open.
 * Called when the active workspace root changes.
 */
function closeNewProjectPanel() {
    if (_newProjectPanel) {
        _newProjectPanel.dispose();
        _newProjectPanel = null;
    }
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  HTML TEMPLATE                                                      ║
// ╚══════════════════════════════════════════════════════════════════╝

function _getNewProjectHtml(availableComponents) {
    const templatePath = path.join(getGlobalCtx().extensionPath, 'media', 'new-project.html');

    let html;
    if (fs.existsSync(templatePath)) {
        html = fs.readFileSync(templatePath, 'utf8');
    } else {
        html = _getDefaultHtmlTemplate();
    }

    // Replace placeholders
    html = html.replace(/\{\{AVAILABLE_COMPONENTS\}\}/g, JSON.stringify(availableComponents));

    return html;
}

/**
 * Default inline HTML template used when media/new-project.html
 * does not exist yet.
 */
function _getDefaultHtmlTemplate() {
    // Fallback: media/new-project.html should always exist.
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body><h2>New Project template not found</h2><p>Please reinstall the extension.</p></body>
</html>`;
}
// ╔══════════════════════════════════════════════════════════════════╗
// ║  EXPORTS                                                            ║
// ╚══════════════════════════════════════════════════════════════════╝

module.exports = {
    cmdNewProjectEditor,
    closeNewProjectPanel,
};
