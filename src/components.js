'use strict';

const { vscode, path, fs,
        getActiveRoot, getValidIdfPath, getGlobalCtx, getProvider,
        checkBusy, warnNoProject, log,
} = require('./helpers');

// ─── Module-level state ──────────────────────────────────────────────────────
let _addComponentPanel = null;
let _editComponentPanel = null;

// ─── Component scanner ────────────────────────────────────────────────────────
function scanComponents(dir) {
    const INFRA_COMPONENTS = new Set(['esptool_py', 'partition_table', 'bootloader']);
    if (!dir || !fs.existsSync(dir)) return [];
    try {
        return fs.readdirSync(dir)
            .filter(name => {
                if (INFRA_COMPONENTS.has(name)) return false;
                const sub = path.join(dir, name);
                if (!fs.statSync(sub).isDirectory()) return false;
                const cmake = path.join(sub, 'CMakeLists.txt');
                if (!fs.existsSync(cmake)) return false;
                const content = fs.readFileSync(cmake, 'utf8');
                return /idf_component_register|register_component|set\s*\(\s*srcs/i.test(content);
            })
            .sort();
    } catch { return []; }
}

async function pickComponents(currentRequires, root, excludeSelf = '') {
    const idfPath = getValidIdfPath();
    const sdkComps = idfPath ? scanComponents(path.join(idfPath, 'components')) : [];
    const projComps = root ? scanComponents(path.join(root, 'components')) : [];

    const projSet = new Set(projComps);
    const allComps = [...projComps, ...sdkComps.filter(c => !projSet.has(c))].filter(c => c !== excludeSelf);

    const currentArr = (currentRequires || '')
        .split(/[\s,]+/)
        .map(s => s.trim())
        .filter(Boolean);

    const CUSTOM_ITEM = { label: '$(edit) Type custom component name...', description: 'Enter a component not in the list', alwaysShow: true };

    const items = [
        CUSTOM_ITEM,
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        ...allComps.map(name => {
            const isProj = projSet.has(name);
            const isCurrent = currentArr.includes(name);
            return {
                label: name,
                description: isProj ? '$(cube) project' : '$(package) SDK',
                picked: isCurrent,
            };
        }),
    ];

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Dependencies',
        placeHolder: 'Select components this depends on (type to search)',
        canPickMany: true,
    });
    if (selected === undefined) return undefined;

    const pickedCustom = selected.find(i => i === CUSTOM_ITEM);
    const pickedNames = selected
        .filter(i => i !== CUSTOM_ITEM && i.kind !== vscode.QuickPickItemKind.Separator)
        .map(i => i.label);

    let customNames = [];
    if (pickedCustom) {
        const customInput = await vscode.window.showInputBox({
            title: 'Custom Component Names',
            prompt: 'Enter component names (comma or space separated)',
            placeHolder: 'my_custom_lib, another_dep',
        });
        if (customInput === undefined) return undefined;
        customNames = customInput.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    }

    const result = [...pickedNames];
    for (const n of customNames) {
        if (!result.includes(n)) result.push(n);
    }
    return result;
}

async function pickExcludedComponents(root) {
    const idfPath = getValidIdfPath();
    const sdkComps = idfPath ? scanComponents(path.join(idfPath, 'components')) : [];
    const sdkSet = new Set(sdkComps);

    const currentExcluded = root ? readExcludedComponents(root) : [];
    const preservedProjExcluded = currentExcluded.filter(c => !sdkSet.has(c));

    const CUSTOM_ITEM = { label: '$(edit) Type custom component name...', description: 'Enter a component not in the list', alwaysShow: true };

    const items = [
        CUSTOM_ITEM,
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        ...sdkComps.map(name => ({
            label: name,
            description: '$(package) SDK',
            picked: currentExcluded.includes(name),
        })),
    ];

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Exclude Components',
        placeHolder: 'Select SDK components to exclude from build (type to search)',
        canPickMany: true,
    });
    if (selected === undefined) return undefined;

    const pickedCustom = selected.find(i => i === CUSTOM_ITEM);
    const pickedNames = selected
        .filter(i => i !== CUSTOM_ITEM && i.kind !== vscode.QuickPickItemKind.Separator)
        .map(i => i.label);

    let customNames = [];
    if (pickedCustom) {
        const customInput = await vscode.window.showInputBox({
            title: 'Custom Component Names',
            prompt: 'Enter component names to exclude (comma or space separated)',
            placeHolder: 'my_unused_sdk_component',
        });
        if (customInput === undefined) return undefined;
        customNames = customInput.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    }

    const result = [...preservedProjExcluded, ...pickedNames];
    for (const n of customNames) {
        if (!result.includes(n)) result.push(n);
    }
    return result;
}

// ─── EXCLUDE_COMPONENTS: read/write from root CMakeLists.txt ──────────────────
function readExcludedComponents(rootDir) {
    const cmakePath = path.join(rootDir, 'CMakeLists.txt');
    if (!fs.existsSync(cmakePath)) return [];
    const cmake = fs.readFileSync(cmakePath, 'utf8');
    const lines = cmake.split('\n');
    let setStartLine = -1;
    let parenDepth = 0;
    let valueStr = '';
    for (let i = 0; i < lines.length; i++) {
        const stripped = lines[i].trim();
        if (setStartLine === -1) {
            if (/^set\s*\(\s*EXCLUDE_COMPONENTS\s/i.test(stripped)) {
                setStartLine = i;
                for (const ch of stripped) {
                    if (ch === '(') parenDepth++;
                    if (ch === ')') parenDepth--;
                }
                const valMatch = stripped.match(/^set\s*\(\s*EXCLUDE_COMPONENTS\s+([\s\S]*)/i);
                if (valMatch) valueStr = valMatch[1];
                if (parenDepth <= 0) break;
            }
        } else {
            valueStr += ' ' + lines[i];
            for (const ch of lines[i]) {
                if (ch === '(') parenDepth++;
                if (ch === ')') parenDepth--;
            }
            if (parenDepth <= 0) break;
        }
    }
    if (setStartLine === -1) return [];
    const fullMatch = valueStr.match(/^([\s\S]*?)\)/);
    if (!fullMatch) return [];
    const valuePart = fullMatch[1].split('\n').map(line => {
        let inQuote = false;
        let result = '';
        for (let ci = 0; ci < line.length; ci++) {
            const ch = line[ci];
            if (ch === '"' && (ci === 0 || line[ci - 1] !== '\\')) {
                inQuote = !inQuote;
                result += ch;
            } else if (ch === '#' && !inQuote) {
                break;
            } else {
                result += ch;
            }
        }
        return result;
    }).join(' ');
    return valuePart.trim().split(/\s+/).map(c => c.replace(/^"|"$/g, '')).filter(Boolean);
}

function writeExcludedComponents(rootDir, excludedList) {
    const cmakePath = path.join(rootDir, 'CMakeLists.txt');
    if (!fs.existsSync(cmakePath)) return;
    let cmake = fs.readFileSync(cmakePath, 'utf8');

    const lines = cmake.split('\n');
    const result = [];
    let skipUntilParenClose = false;
    let parenDepth = 0;

    for (const line of lines) {
        if (skipUntilParenClose) {
            for (const ch of line) {
                if (ch === '(') parenDepth++;
                if (ch === ')') parenDepth--;
            }
            if (parenDepth <= 0) {
                skipUntilParenClose = false;
            }
            continue;
        }
        const stripped = line.trim();
        if (/^set\s*\(\s*EXCLUDE_COMPONENTS\s/i.test(stripped)) {
            parenDepth = 0;
            for (const ch of stripped) {
                if (ch === '(') parenDepth++;
                if (ch === ')') parenDepth--;
            }
            if (parenDepth > 0) {
                skipUntilParenClose = true;
            }
            continue;
        }
        result.push(line);
    }

    cmake = result.join('\n');

    if (excludedList.length > 0) {
        const compsStr = excludedList.join(' ');
        const excludeLine = `set(EXCLUDE_COMPONENTS ${compsStr})\n`;
        const includeMatch = cmake.match(/(include\s*\(\s*\$ENV\{IDF_PATH\}[^)]*project\.cmake\s*\)\s*\n?)/i);
        if (includeMatch) {
            cmake = cmake.replace(includeMatch[0], `${includeMatch[0]}${excludeLine}`);
        } else {
            cmake = cmake.replace(/(project\s*\()/i, `${excludeLine}$1`);
        }
    }

    fs.writeFileSync(cmakePath, cmake, 'utf8');
}

async function cmdDeleteComponent(item) {
    if (checkBusy()) return;
    const root = getActiveRoot();
    if (!root) return;

    const compName = item?._compName || item?.label;
    if (!compName) { vscode.window.showErrorMessage('ESP: Cannot determine component name.'); return; }

    const compDir = path.join(root, 'components', compName);
    if (!fs.existsSync(compDir)) {
        vscode.window.showErrorMessage(`ESP: Component folder not found: ${compDir}`);
        return;
    }

    const choice = await vscode.window.showWarningMessage(
        `Delete component "${compName}"? This will remove the entire folder.`,
        { modal: true },
        'Delete'
    );
    if (choice !== 'Delete') return;

    try {
        fs.rmSync(compDir, { recursive: true, force: true });
        vscode.window.showInformationMessage(`✅ Component "${compName}" deleted.`);
    } catch (e) {
        vscode.window.showErrorMessage(`ESP: Failed to delete component: ${e.message}`);
    }
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  ADD COMPONENT — WEBVIEW EDITOR                                   ║
// ╚══════════════════════════════════════════════════════════════════╝

function cmdAddComponent() {
    if (checkBusy()) return;
    const root = getActiveRoot();
    if (!root) {
        warnNoProject();
        return;
    }

    if (_addComponentPanel) {
        _addComponentPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    // Gather available SDK components for the REQUIRES picker
    const idfPath = getValidIdfPath();
    const sdkComps = idfPath ? scanComponents(path.join(idfPath, 'components')) : [];
    const projComps = root ? scanComponents(path.join(root, 'components')) : [];
    const projSet = new Set(projComps);
    const allComps = [...projComps, ...sdkComps.filter(c => !projSet.has(c))].sort();

    // Create webview panel
    const panel = vscode.window.createWebviewPanel(
        'espAddComponent',
        'ESP — Add New Component',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(getGlobalCtx().extensionPath, 'media')),
            ],
        }
    );

    _addComponentPanel = panel;

    // Build HTML
    panel.webview.html = _getAddComponentHtml(allComps, root);

    // ─── Message handler ──────────────────────────────────────────────
    panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'checkComponentExists') {
            const { compName } = msg;
            const root = getActiveRoot();
            const exists = root && compName && fs.existsSync(path.join(root, 'components', compName));
            panel.webview.postMessage({
                command: 'componentExistsResult',
                exists: !!exists,
            });
            return;
        }

        if (msg.command === 'createComponent') {
            try {
                const { compName, cmakeStyle, srcs, headersChoice, requires } = msg.data;

                // Final validation
                const root = getActiveRoot();
                if (!root) {
                    vscode.window.showErrorMessage('ESP: No active project.');
                    return;
                }
                if (!compName || !compName.match(/^[a-zA-Z0-9_]+$/)) {
                    vscode.window.showErrorMessage('ESP: Invalid component name.');
                    return;
                }
                const compDir = path.join(root, 'components', compName);
                if (fs.existsSync(compDir)) {
                    vscode.window.showErrorMessage(`ESP: Component already exists: ${compName}`);
                    return;
                }
                if (!srcs || srcs.length === 0) {
                    vscode.window.showErrorMessage('ESP: At least one source file is required.');
                    return;
                }

                // Create the component
                _createComponent(compDir, compName, cmakeStyle || 'modern', srcs, headersChoice, requires);

                log(`New component created: ${compDir}`);

                // Refresh tree provider
                const provider = getProvider();
                if (provider) provider.refresh();

                // Close the webview panel
                panel.dispose();

                vscode.window.showInformationMessage(
                    `✅ Component "${compName}" created in components/${compName}/`
                );

            } catch (e) {
                panel.webview.postMessage({
                    command: 'componentCreateError',
                    error: e.message,
                });
                vscode.window.showErrorMessage(`ESP: Failed to create component: ${e.message}`);
            }
            return;
        }
    });

    // ─── Panel lifecycle ──────────────────────────────────────────────
    panel.onDidDispose(() => {
        _addComponentPanel = null;
    }, null, []);
}

function _createComponent(compDir, compName, cmakeStyle, srcs, headersChoice, requires) {
    fs.mkdirSync(compDir, { recursive: true });
    if (headersChoice === 'include') {
        fs.mkdirSync(path.join(compDir, 'include'), { recursive: true });
    }

    const srcsLine = srcs.map(s => `"${s}"`).join(' ');
    let cmakeContent;

    if (cmakeStyle === 'legacy') {
        // Legacy (ESP8266 RTOS SDK v3.x): set(COMPONENT_SRCS ...) + register_component()
        let out = '';
        if (srcs.length > 0) {
            out += `set(COMPONENT_SRCS ${srcsLine})\n`;
        }
        if (headersChoice === 'include') {
            out += 'set(COMPONENT_ADD_INCLUDEDIRS "include")\n';
        } else if (headersChoice === 'dot') {
            out += 'set(COMPONENT_ADD_INCLUDEDIRS ".")\n';
        }
        if (requires.length) {
            out += `set(COMPONENT_REQUIRES ${requires.join(' ')})\n`;
        }
        out += '\nregister_component()\n';
        cmakeContent = out;
    } else {
        // Modern (ESP-IDF v4.x/v5.x): idf_component_register(SRCS ... INCLUDE_DIRS ... REQUIRES ...)
        const incLine  = headersChoice === 'include' ? '\n                       INCLUDE_DIRS "include"'
                      : headersChoice === 'dot'     ? '\n                       INCLUDE_DIRS "."'
                      : '';
        const reqLine  = requires.length ? `\n                       REQUIRES ${requires.join(' ')}` : '';
        cmakeContent = `idf_component_register(SRCS ${srcsLine}${incLine}${reqLine}\n)\n`;
    }

    fs.writeFileSync(path.join(compDir, 'CMakeLists.txt'), cmakeContent);

    for (const src of srcs) {
        const srcPath = path.join(compDir, src);
        if (!fs.existsSync(srcPath)) {
            const baseName = src.replace(/\.c$/, '');
            fs.writeFileSync(srcPath,
`#include "${baseName}.h"

// TODO: implement ${baseName}
`);
        }
    }

    if (headersChoice !== 'none') {
        const headerDir = headersChoice === 'include'
            ? path.join(compDir, 'include')
            : compDir;
        const headerPath = path.join(headerDir, `${compName}.h`);
        if (!fs.existsSync(headerPath)) {
            const guard = compName.toUpperCase() + '_H';
            fs.writeFileSync(headerPath,
`#ifndef ${guard}
#define ${guard}

// TODO: declare ${compName} API

#endif // ${guard}
`);
        }
    }
}

/**
 * Close the Add Component webview panel if open.
 */
function closeAddComponentPanel() {
    if (_addComponentPanel) {
        _addComponentPanel.dispose();
        _addComponentPanel = null;
    }
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  HTML TEMPLATE                                                      ║
// ╚══════════════════════════════════════════════════════════════════╝

function _getAddComponentHtml(availableComponents, projectRoot) {
    const templatePath = path.join(getGlobalCtx().extensionPath, 'media', 'new-component.html');

    let html;
    if (fs.existsSync(templatePath)) {
        html = fs.readFileSync(templatePath, 'utf8');
    } else {
        html = _getDefaultAddComponentHtml();
    }

    // Replace placeholders
    html = html.replace(/\{\{AVAILABLE_COMPONENTS\}\}/g, JSON.stringify(availableComponents));
    html = html.replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot.replace(/\\/g, '\\\\'));

    return html;
}

function _getDefaultAddComponentHtml() {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body><h2>Add Component template not found</h2><p>Please reinstall the extension.</p></body>
</html>`;
}

function cmdEditComponent(item) {
    if (checkBusy()) return;
    const root = getActiveRoot();
    if (!root) {
        warnNoProject();
        return;
    }

    const compName = item?._compName || item?.label;
    if (!compName) { vscode.window.showErrorMessage('ESP: Cannot determine component name.'); return; }

    const compDir = path.join(root, 'components', compName);
    if (!fs.existsSync(compDir)) {
        vscode.window.showErrorMessage(`ESP: Component folder not found: ${compDir}`);
        return;
    }

    if (_editComponentPanel) {
        _editComponentPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    // Parse existing CMakeLists.txt for initial data
    let existingSrcs = [`${compName}.c`];
    let existingHeaderVal = 'include';
    let existingRequires = [];

    const cmakePath = path.join(compDir, 'CMakeLists.txt');
    if (fs.existsSync(cmakePath)) {
        const cmake = fs.readFileSync(cmakePath, 'utf8');

        const srcsMatch = cmake.match(/SRCS\s+((?:"[^"]*"\s*)+)/);
        if (srcsMatch) {
            existingSrcs = srcsMatch[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, '')) ?? [`${compName}.c`];
        }

        if (/INCLUDE_DIRS\s+"\."/.test(cmake))            existingHeaderVal = 'dot';
        else if (/INCLUDE_DIRS\s+"include"/.test(cmake)) existingHeaderVal = 'include';
        else if (!cmake.includes('INCLUDE_DIRS'))        existingHeaderVal = 'none';

        const reqMatch = cmake.match(/REQUIRES[^\S\n]+([^)\n]+)/);
        if (reqMatch) {
            existingRequires = reqMatch[1].trim().split(/\s+/).filter(Boolean);
        }
    }

    // Gather available SDK components for the REQUIRES picker
    const idfPath = getValidIdfPath();
    const sdkComps = idfPath ? scanComponents(path.join(idfPath, 'components')) : [];
    const projComps = root ? scanComponents(path.join(root, 'components')) : [];
    const projSet = new Set(projComps);
    const allComps = [...projComps, ...sdkComps.filter(c => !projSet.has(c))].sort();

    // Build initial data payload
    const initialData = {
        compName,
        srcs: existingSrcs,
        headersChoice: existingHeaderVal,
        requires: existingRequires,
        compDir,
    };

    // Create webview panel
    const panel = vscode.window.createWebviewPanel(
        'espEditComponent',
        `ESP — Edit: ${compName}`,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(getGlobalCtx().extensionPath, 'media')),
            ],
        }
    );

    _editComponentPanel = panel;

    // Build HTML
    panel.webview.html = _getEditComponentHtml(allComps, root, initialData);

    // ─── Message handler ──────────────────────────────────────────────
    panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'checkComponentExists') {
            const { compName: checkName } = msg;
            const root = getActiveRoot();
            const exists = root && checkName && fs.existsSync(path.join(root, 'components', checkName));
            panel.webview.postMessage({
                command: 'componentExistsResult',
                exists: !!exists,
                compName: checkName,
            });
            return;
        }

        if (msg.command === 'scanDirectory') {
            const root = getActiveRoot();
            if (!root) return;
            // Use compDir from the initial data or reconstruct it
            const scanDir = initialData.compDir || path.join(root, 'components', initialData.compName);
            let cFiles = [];
            try {
                cFiles = fs.readdirSync(scanDir)
                    .filter(f => f.endsWith('.c'))
                    .sort();
            } catch {}
            panel.webview.postMessage({
                command: 'scanDirectoryResult',
                files: cFiles,
            });
            return;
        }

        if (msg.command === 'saveComponent') {
            try {
                const { compName, originalName, srcs, headersChoice, requires, compDir: savedCompDir } = msg.data;

                // Final validation
                const root = getActiveRoot();
                if (!root) {
                    vscode.window.showErrorMessage('ESP: No active project.');
                    return;
                }
                if (!compName || !compName.match(/^[a-zA-Z0-9_]+$/)) {
                    vscode.window.showErrorMessage('ESP: Invalid component name.');
                    return;
                }
                if (compName !== originalName && fs.existsSync(path.join(root, 'components', compName))) {
                    vscode.window.showErrorMessage(`ESP: Component already exists: ${compName}`);
                    return;
                }
                if (!srcs || srcs.length === 0) {
                    vscode.window.showErrorMessage('ESP: At least one source file is required.');
                    return;
                }

                // Build CMakeLists.txt content
                const srcsLine = srcs.map(s => `"${s}"`).join(' ');
                const incLine  = headersChoice === 'include' ? '\n                       INCLUDE_DIRS "include"'
                               : headersChoice === 'dot'     ? '\n                       INCLUDE_DIRS "."'
                               : '';
                const reqLine  = requires.length ? `\n                       REQUIRES ${requires.join(' ')}` : '';
                const cmakeContent = `idf_component_register(SRCS ${srcsLine}${incLine}${reqLine}\n)\n`;

                let finalCompDir = savedCompDir || path.join(root, 'components', originalName);
                let finalCmakePath = path.join(finalCompDir, 'CMakeLists.txt');

                // Handle rename
                if (compName !== originalName) {
                    const newCompDir = path.join(root, 'components', compName);
                    fs.renameSync(finalCompDir, newCompDir);
                    finalCompDir   = newCompDir;
                    finalCmakePath = path.join(newCompDir, 'CMakeLists.txt');
                }

                // Write CMakeLists.txt
                fs.writeFileSync(finalCmakePath, cmakeContent);

                // Create missing .c files
                for (const src of srcs) {
                    const srcPath = path.join(finalCompDir, src);
                    if (!fs.existsSync(srcPath)) {
                        const baseName = src.replace(/\.c$/, '');
                        fs.writeFileSync(srcPath,
`#include "${baseName}.h"

// TODO: implement ${baseName}
`);
                    }
                }

                // Create include directory if needed
                if (headersChoice === 'include') {
                    fs.mkdirSync(path.join(finalCompDir, 'include'), { recursive: true });
                }

                // Create missing .h files
                if (headersChoice !== 'none') {
                    const headerDir = headersChoice === 'include'
                        ? path.join(finalCompDir, 'include')
                        : finalCompDir;
                    const headerPath = path.join(headerDir, `${compName}.h`);
                    if (!fs.existsSync(headerPath)) {
                        const guard = compName.toUpperCase() + '_H';
                        fs.writeFileSync(headerPath,
`#ifndef ${guard}
#define ${guard}

// TODO: declare ${compName} API

#endif // ${guard}
`);
                    }
                }

                log(`Component updated: ${finalCompDir}`);

                // Refresh tree provider
                const provider = getProvider();
                if (provider) provider.refresh();

                // Close the webview panel
                panel.dispose();

                const renamed = compName !== originalName ? ` (renamed → "${compName}")` : '';
                vscode.window.showInformationMessage(
                    `✅ Component "${originalName}" updated${renamed}.`
                );

            } catch (e) {
                panel.webview.postMessage({
                    command: 'componentSaveError',
                    error: e.message,
                });
                vscode.window.showErrorMessage(`ESP: Failed to update component: ${e.message}`);
            }
            return;
        }
    });

    // ─── Panel lifecycle ──────────────────────────────────────────────
    panel.onDidDispose(() => {
        _editComponentPanel = null;
    }, null, []);
}

// ─── EDIT COMPONENT — HTML TEMPLATE ─────────────────────────────────────────

function _getEditComponentHtml(availableComponents, projectRoot, initialData) {
    const templatePath = path.join(getGlobalCtx().extensionPath, 'media', 'edit-component.html');

    let html;
    if (fs.existsSync(templatePath)) {
        html = fs.readFileSync(templatePath, 'utf8');
    } else {
        html = _getDefaultEditComponentHtml();
    }

    // Replace placeholders
    html = html.replace(/\{\{AVAILABLE_COMPONENTS\}\}/g, JSON.stringify(availableComponents));
    html = html.replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot.replace(/\\/g, '\\\\'));
    html = html.replace(/\{\{INITIAL_DATA\}\}/g, JSON.stringify(initialData));

    return html;
}

function _getDefaultEditComponentHtml() {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body><h2>Edit Component template not found</h2><p>Please reinstall the extension.</p></body>
</html>`;
}

/**
 * Close the Edit Component webview panel if open.
 */
function closeEditComponentPanel() {
    if (_editComponentPanel) {
        _editComponentPanel.dispose();
        _editComponentPanel = null;
    }
}

module.exports = {
    scanComponents, pickComponents, pickExcludedComponents,
    readExcludedComponents, writeExcludedComponents,
    cmdDeleteComponent, cmdAddComponent, cmdEditComponent,
    closeAddComponentPanel, closeEditComponentPanel,
};
