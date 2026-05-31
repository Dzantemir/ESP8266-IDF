'use strict';

const { vscode, path, fs,
        getActiveRoot, getValidIdfPath, getGlobalCtx,
        checkBusy, warnNoProject, getGlobalBusyName,
} = require('./helpers');

const { scanComponents, pickComponents } = require('./components');

// ╔══════════════════════════════════════════════════════════════════╗
// ║  MODULE-LEVEL STATE                                                 ║
// ╚══════════════════════════════════════════════════════════════════╝
// Map of cmakePath -> { panel, isDirty }
let _cmakePanels = new Map();

// ╔══════════════════════════════════════════════════════════════════╗
// ║  CMAKE PARSER: idf_component_register()                             ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Parse a component CMakeLists.txt and extract all parameters from
 * `idf_component_register()`.  Handles multi-line calls, quoted strings,
 * and inline comments.
 *
 * @param {string} content  The full text of the CMakeLists.txt file.
 * @returns {object} Parsed parameter object.
 */
function parseCmakeComponentRegister(content) {
    const result = _emptyComponentParsed();

    if (!content) return result;

    const normalised = content.replace(/\r\n/g, '\n');

    // Remove comment lines but preserve quoted content
    const lines = normalised.split('\n');
    const cleaned = [];
    for (const line of lines) {
        cleaned.push(_stripComment(line));
    }
    const text = cleaned.join('\n');

    // Find idf_component_register( ... )
    const startIdx = text.search(/idf_component_register\s*\(/);
    if (startIdx === -1) {
        // No modern format found — try legacy format (set(COMPONENT_*) + register_component())
        return parseCmakeLegacyRegister(content);
    }

    // #50: Preserve everything BEFORE idf_component_register() as preambleBlock
    // This captures if()/set()/endif() blocks, comments, and any other CMake logic.
    // Use the ORIGINAL (non-cleaned) content to preserve comments verbatim.
    // normalised holds the original content with CRLF→LF; 'text' (below) is the comment-stripped version.
    const originalStartIdx = normalised.search(/idf_component_register\s*\(/);
    if (originalStartIdx > 0) {
        const preambleRaw = normalised.substring(0, originalStartIdx);
        // Only keep non-empty preamble (skip if it's just whitespace/newlines)
        if (preambleRaw.trim().length > 0) {
            result.preambleBlock = preambleRaw.trimEnd() + '\n\n';
        }
    }

    // Extract the balanced parenthesised block
    let depth = 0;
    let argsStart = -1;
    let argsEnd = -1;
    for (let i = startIdx; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') {
            if (depth === 0) argsStart = i + 1;
            depth++;
        }
        if (ch === ')') {
            depth--;
            if (depth === 0) {
                argsEnd = i;
                break;
            }
        }
    }
    if (argsStart === -1 || argsEnd === -1) return result;

    const argsText = text.substring(argsStart, argsEnd);

    // Tokenise: split into keyword-value pairs.
    // Multi-value keywords: each keyword is followed by values until the next keyword or end.
    const KEYWORDS = [
        'SRCS', 'SRC_DIRS', 'EXCLUDE_SRCS',
        'INCLUDE_DIRS', 'PRIV_INCLUDE_DIRS',
        'LDFRAGMENTS',
        'REQUIRES', 'PRIV_REQUIRES',
        'REQUIRED_IDF_TARGETS',
        'EMBED_FILES', 'EMBED_TXTFILES',
    ];
    const kwSet = new Set(KEYWORDS);

    // Tokenise into atoms (respecting quotes)
    const atoms = _tokeniseCmakeArgs(argsText);

    // Walk atoms: keyword consumes following atoms until next keyword
    let currentKw = null;
    for (const atom of atoms) {
        const upper = atom.toUpperCase();
        if (kwSet.has(upper)) {
            currentKw = upper;
            continue;
        }
        if (currentKw === null) continue; // stray atom before any keyword
        const val = atom.replace(/^"|"$/g, ''); // strip surrounding quotes
        _pushToResult(result, currentKw, val);
    }

    // #50: Detect variable references (${...}) in REQUIRES/PRIV_REQUIRES
    // Mark them so the UI can warn the user and handle them specially.
    result.hasVariableRefs = _detectVariableRefs(result);

    result.cmakeFormat = 'modern';
    return result;
}

/**
 * Parse a component CMakeLists.txt using the legacy ESP8266 RTOS SDK format:
 *   set(COMPONENT_SRCS ...)
 *   set(COMPONENT_ADD_INCLUDEDIRS ...)
 *   register_component()
 *
 * @param {string} content  The full text of the CMakeLists.txt file.
 * @returns {object} Parsed parameter object with cmakeFormat: 'legacy'.
 */
function parseCmakeLegacyRegister(content) {
    const result = _emptyComponentParsed();
    result.cmakeFormat = 'legacy';

    if (!content) return result;

    const normalised = content.replace(/\r\n/g, '\n');

    // Check if register_component() exists
    if (!/register_component\s*\(/.test(normalised)) {
        // No register_component() found either — return default empty result
        // but still mark as legacy since idf_component_register wasn't found
        return result;
    }

    // Map legacy variable names to result fields
    const LEGACY_MAP = {
        'COMPONENT_SRCS':           { field: 'srcs',           mode: 'srcs' },
        'COMPONENT_SRCDIRS':        { field: 'srcDirs',         mode: 'srcDirs' },
        'COMPONENT_SRCEXCLUDE':     { field: 'excludeSrcs',     mode: null },
        'COMPONENT_ADD_INCLUDEDIRS':    { field: 'includeDirs',     mode: null },
        'COMPONENT_PRIV_INCLUDEDIRS':   { field: 'privIncludeDirs', mode: null },
        'COMPONENT_REQUIRES':       { field: 'requires',        mode: null },
        'COMPONENT_PRIV_REQUIRES':  { field: 'privRequires',    mode: null },
        'COMPONENT_ADD_LDFRAGMENTS':    { field: 'ldfragments',     mode: null },
        'COMPONENT_EMBED_FILES':    { field: 'embedFiles',      mode: null },
        'COMPONENT_EMBED_TXTFILES': { field: 'embedTxtFiles',   mode: null },
    };

    for (const [varName, mapping] of Object.entries(LEGACY_MAP)) {
        const values = _extractSetValues(normalised, varName);
        if (values.length > 0) {
            result[mapping.field] = values;
            if (mapping.mode) {
                result.sourceMode = mapping.mode;
            }
        }
    }

    // #50: For legacy format, capture any CMake code that is NOT a set(COMPONENT_*) line
    // and is NOT register_component(). This preserves if()/endif() blocks, etc.
    const legacyPreambleLines = [];
    const legacySetRe = /^set\s*\(\s*COMPONENT_\w+\s/i;
    const legacyRegisterRe = /^register_component\s*\(/i;
    for (const line of normalised.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue; // skip blank lines (we'll re-add spacing)
        if (legacySetRe.test(trimmed)) continue;
        if (legacyRegisterRe.test(trimmed)) continue;
        legacyPreambleLines.push(line);
    }
    if (legacyPreambleLines.length > 0) {
        result.preambleBlock = legacyPreambleLines.join('\n').trimEnd() + '\n\n';
    }

    // #50: Detect variable references
    result.hasVariableRefs = _detectVariableRefs(result);

    return result;
}

/**
 * Parse root-level CMakeLists.txt, extracting project name,
 * EXCLUDE_COMPONENTS, EXTRA_COMPONENT_DIRS, and preserving any
 * partition bin links block.
 *
 * @param {string} content  The full text of root CMakeLists.txt.
 * @returns {object} Parsed root data.
 */
function parseCmakeRoot(content) {
    const result = {
        projectName: '',
        excludeComponents: [],
        extraComponentDirs: [],
        partitionBinLinksBlock: '',   // preserved verbatim (legacy)
        postambleBlock: '',          // ALL content after project() — preserved verbatim
    };

    if (!content) return result;

    const normalised = content.replace(/\r\n/g, '\n');

    // Extract partition bin links block (BEGIN...END) — legacy support
    const blockMatch = normalised.match(
        /(# ESP8266 Tools: partition bin links -- BEGIN[\s\S]*?# ESP8266 Tools: partition bin links -- END)/
    );
    if (blockMatch) {
        result.partitionBinLinksBlock = blockMatch[1];
    }

    // Extract project name and find where project() ends
    const projMatch = normalised.match(/project\s*\(/);
    if (projMatch) {
        // Find the closing ) of project() — handle nested parens
        const projStartIdx = projMatch.index;
        let depth = 0;
        let projEndIdx = -1;
        for (let i = projStartIdx; i < normalised.length; i++) {
            if (normalised[i] === '(') depth++;
            if (normalised[i] === ')') {
                depth--;
                if (depth === 0) {
                    projEndIdx = i;
                    break;
                }
            }
        }
        if (projEndIdx !== -1) {
            // Extract project name from inside the parens
            const projInner = normalised.substring(projStartIdx + projMatch[0].length, projEndIdx);
            const nameMatch = projInner.match(/^([^\s)]+)/);
            if (nameMatch) {
                result.projectName = nameMatch[1].replace(/^"|"$/g, '');
            }

            // Extract everything after project() as postambleBlock
            const afterProject = normalised.substring(projEndIdx + 1);
            if (afterProject.trim().length > 0) {
                result.postambleBlock = '\n' + afterProject.trimEnd() + '\n';
            }
        }
    } else {
        // Fallback: just extract project name if project() has unusual format
        const simpleProjMatch = normalised.match(/project\s*\(\s*([^\s)]+)/);
        if (simpleProjMatch) {
            result.projectName = simpleProjMatch[1].replace(/^"|"$/g, '');
        }
    }

    // Extract EXCLUDE_COMPONENTS from set() command
    result.excludeComponents = readExcludedComponentsFromText(normalised);

    // Extract EXTRA_COMPONENT_DIRS from set() command
    result.extraComponentDirs = _extractSetValues(normalised, 'EXTRA_COMPONENT_DIRS');

    return result;
}

/**
 * Read EXCLUDE_COMPONENTS from raw CMakeLists text (not from disk).
 * Reuses the same logic as components.js readExcludedComponents but works on text.
 */
function readExcludedComponentsFromText(cmakeText) {
    if (!cmakeText) return [];
    const lines = cmakeText.split('\n');
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

// ╔══════════════════════════════════════════════════════════════════╗
// ║  CMAKE GENERATOR                                                    ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Generate a component CMakeLists.txt from a parsed object.
 * Only includes non-empty parameters.
 * SRCS values are always quoted.  REQUIRES/PRIV_REQUIRES values are
 * space-separated (not quoted).  Directory paths and filenames with
 * spaces must be quoted.
 *
 * @param {object} parsed  The parsed parameter object.
 * @returns {string} Formatted CMakeLists.txt content.
 */
function generateCmakeComponentRegister(parsed) {
    const parts = [];
    const mode = parsed.sourceMode || 'srcs';

    // #50: Prepend preamble block (if()/set()/endif() and other CMake logic before idf_component_register)
    let preamble = '';
    if (parsed.preambleBlock && parsed.preambleBlock.trim().length > 0) {
        preamble = parsed.preambleBlock.trimEnd() + '\n\n';
    }

    // SRCS (always quoted) — only in SRCS mode
    if (mode === 'srcs' && parsed.srcs && parsed.srcs.length > 0) {
        parts.push('    SRCS ' + parsed.srcs.map(s => _quoteIfNeeded(s, true)).join(' '));
    }

    // SRC_DIRS — only in srcDirs mode
    if (mode === 'srcDirs' && parsed.srcDirs && parsed.srcDirs.length > 0) {
        parts.push('    SRC_DIRS ' + parsed.srcDirs.map(s => _quoteIfNeeded(s)).join(' '));
    }

    // EXCLUDE_SRCS — only makes sense with SRC_DIRS
    if (mode === 'srcDirs' && parsed.excludeSrcs && parsed.excludeSrcs.length > 0) {
        parts.push('    EXCLUDE_SRCS ' + parsed.excludeSrcs.map(s => _quoteIfNeeded(s, true)).join(' '));
    }

    // INCLUDE_DIRS
    if (parsed.includeDirs && parsed.includeDirs.length > 0) {
        parts.push('    INCLUDE_DIRS ' + parsed.includeDirs.map(s => _quoteIfNeeded(s)).join(' '));
    }

    // PRIV_INCLUDE_DIRS
    if (parsed.privIncludeDirs && parsed.privIncludeDirs.length > 0) {
        parts.push('    PRIV_INCLUDE_DIRS ' + parsed.privIncludeDirs.map(s => _quoteIfNeeded(s)).join(' '));
    }

    // LDFRAGMENTS
    if (parsed.ldfragments && parsed.ldfragments.length > 0) {
        parts.push('    LDFRAGMENTS ' + parsed.ldfragments.map(s => _quoteIfNeeded(s, true)).join(' '));
    }

    // REQUIRES (space-separated, not quoted)
    if (parsed.requires && parsed.requires.length > 0) {
        parts.push('    REQUIRES ' + parsed.requires.join(' '));
    }

    // PRIV_REQUIRES (space-separated, not quoted)
    if (parsed.privRequires && parsed.privRequires.length > 0) {
        parts.push('    PRIV_REQUIRES ' + parsed.privRequires.join(' '));
    }

    // EMBED_FILES (always quoted — may be paths)
    if (parsed.embedFiles && parsed.embedFiles.length > 0) {
        parts.push('    EMBED_FILES ' + parsed.embedFiles.map(s => _quoteIfNeeded(s, true)).join(' '));
    }

    // EMBED_TXTFILES (always quoted — may be paths)
    if (parsed.embedTxtFiles && parsed.embedTxtFiles.length > 0) {
        parts.push('    EMBED_TXTFILES ' + parsed.embedTxtFiles.map(s => _quoteIfNeeded(s, true)).join(' '));
    }

    if (parts.length === 0) {
        return preamble + 'idf_component_register()\n';
    }

    return preamble + 'idf_component_register(\n' + parts.join('\n') + '\n)\n';
}

/**
 * Generate a component CMakeLists.txt using the legacy ESP8266 RTOS SDK format:
 *   set(COMPONENT_SRCS ...)
 *   set(COMPONENT_ADD_INCLUDEDIRS ...)
 *   register_component()
 *
 * @param {object} parsed  The parsed parameter object.
 * @returns {string} Formatted CMakeLists.txt content in legacy format.
 */
function generateCmakeLegacyRegister(parsed) {
    const mode = parsed.sourceMode || 'srcs';
    let out = '';

    // #50: Prepend preamble block
    if (parsed.preambleBlock && parsed.preambleBlock.trim().length > 0) {
        out += parsed.preambleBlock.trimEnd() + '\n\n';
    }

    // SRCS mode: set(COMPONENT_SRCS "file1.c" "file2.c")
    if (mode === 'srcs' && parsed.srcs && parsed.srcs.length > 0) {
        out += 'set(COMPONENT_SRCS ' + parsed.srcs.map(s => _quoteIfNeeded(s, true)).join(' ') + ')\n';
    }

    // SRC_DIRS mode: set(COMPONENT_SRCDIRS dir1 dir2)
    if (mode === 'srcDirs' && parsed.srcDirs && parsed.srcDirs.length > 0) {
        out += 'set(COMPONENT_SRCDIRS ' + parsed.srcDirs.map(s => _quoteIfNeeded(s)).join(' ') + ')\n';
    }

    // EXCLUDE_SRCS (only with SRC_DIRS)
    if (mode === 'srcDirs' && parsed.excludeSrcs && parsed.excludeSrcs.length > 0) {
        out += 'set(COMPONENT_SRCEXCLUDE ' + parsed.excludeSrcs.map(s => _quoteIfNeeded(s, true)).join(' ') + ')\n';
    }

    // INCLUDE_DIRS
    if (parsed.includeDirs && parsed.includeDirs.length > 0) {
        out += 'set(COMPONENT_ADD_INCLUDEDIRS ' + parsed.includeDirs.map(s => _quoteIfNeeded(s)).join(' ') + ')\n';
    }

    // PRIV_INCLUDE_DIRS
    if (parsed.privIncludeDirs && parsed.privIncludeDirs.length > 0) {
        out += 'set(COMPONENT_PRIV_INCLUDEDIRS ' + parsed.privIncludeDirs.map(s => _quoteIfNeeded(s)).join(' ') + ')\n';
    }

    // REQUIRES
    if (parsed.requires && parsed.requires.length > 0) {
        out += 'set(COMPONENT_REQUIRES ' + parsed.requires.join(' ') + ')\n';
    }

    // PRIV_REQUIRES
    if (parsed.privRequires && parsed.privRequires.length > 0) {
        out += 'set(COMPONENT_PRIV_REQUIRES ' + parsed.privRequires.join(' ') + ')\n';
    }

    // LDFRAGMENTS
    if (parsed.ldfragments && parsed.ldfragments.length > 0) {
        out += 'set(COMPONENT_ADD_LDFRAGMENTS ' + parsed.ldfragments.map(s => _quoteIfNeeded(s, true)).join(' ') + ')\n';
    }

    // EMBED_FILES
    if (parsed.embedFiles && parsed.embedFiles.length > 0) {
        out += 'set(COMPONENT_EMBED_FILES ' + parsed.embedFiles.map(s => _quoteIfNeeded(s, true)).join(' ') + ')\n';
    }

    // EMBED_TXTFILES
    if (parsed.embedTxtFiles && parsed.embedTxtFiles.length > 0) {
        out += 'set(COMPONENT_EMBED_TXTFILES ' + parsed.embedTxtFiles.map(s => _quoteIfNeeded(s, true)).join(' ') + ')\n';
    }

    // Always end with register_component()
    out += '\nregister_component()\n';

    return out;
}

/**
 * Generate a root CMakeLists.txt from parsed root data.
 * Preserves any partition bin links block.
 *
 * @param {object} parsed  The parsed root data object.
 * @returns {string} Formatted root CMakeLists.txt content.
 */
function generateCmakeRoot(parsed) {
    let out = '';

    out += 'cmake_minimum_required(VERSION 3.5)\n\n';
    out += 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\n';

    if (parsed.excludeComponents && parsed.excludeComponents.length > 0) {
        out += 'set(EXCLUDE_COMPONENTS ' + parsed.excludeComponents.join(' ') + ')\n';
    }

    if (parsed.extraComponentDirs && parsed.extraComponentDirs.length > 0) {
        out += 'set(EXTRA_COMPONENT_DIRS ' + parsed.extraComponentDirs.map(d => _quoteIfNeeded(d)).join(' ') + ')\n';
    }

    out += 'project(' + (parsed.projectName || 'my_project') + ')\n';

    // Append preserved post-project content
    // postambleBlock takes priority (contains ALL content after project()),
    // but fall back to partitionBinLinksBlock for backward compatibility
    if (parsed.postambleBlock && parsed.postambleBlock.trim().length > 0) {
        out += parsed.postambleBlock.trimEnd() + '\n';
    } else if (parsed.partitionBinLinksBlock) {
        out += '\n' + parsed.partitionBinLinksBlock + '\n';
    }

    return out;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  COMMANDS                                                           ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Open CMake Editor for main/CMakeLists.txt.
 */
function cmdCmakeEditorMain() {
    if (checkBusy()) return;
    const root = getActiveRoot();
    if (!root) { warnNoProject(); return; }

    const cmakePath = path.join(root, 'main', 'CMakeLists.txt');
    const componentDir = path.join(root, 'main');
    _openCmakeEditor(cmakePath, 'main', root, componentDir, false);
}

/**
 * Open CMake Editor for a specific component's CMakeLists.txt.
 *
 * @param {object} item  Tree item with _compName or label.
 */
function cmdCmakeEditorComponent(item) {
    if (checkBusy()) return;
    const root = getActiveRoot();
    if (!root) { warnNoProject(); return; }

    const compName = item?._compName || item?.label;
    if (!compName) {
        vscode.window.showErrorMessage('ESP: Cannot determine component name.');
        return;
    }

    const componentDir = path.join(root, 'components', compName);
    const cmakePath = path.join(componentDir, 'CMakeLists.txt');
    _openCmakeEditor(cmakePath, compName, root, componentDir, false);
}

/**
 * Open CMake Editor for root CMakeLists.txt.
 */
function cmdCmakeEditorRoot() {
    if (checkBusy()) return;
    const root = getActiveRoot();
    if (!root) { warnNoProject(); return; }

    const cmakePath = path.join(root, 'CMakeLists.txt');
    _openCmakeEditor(cmakePath, path.basename(root), root, root, true);
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  WEBVIEW PANEL CREATION                                            ║
// ╚══════════════════════════════════════════════════════════════════╝

function _openCmakeEditor(cmakePath, componentName, root, componentDir, isRoot) {
    // If a panel is already open for the SAME file — just reveal it
    const existing = _cmakePanels.get(cmakePath);
    if (existing && existing.panel) {
        existing.panel.reveal(vscode.ViewColumn.One);
        return;
    }

    // Check file existence
    if (!fs.existsSync(cmakePath)) {
        vscode.window.showErrorMessage(`ESP: CMakeLists.txt not found: ${cmakePath}`);
        return;
    }

    // Read existing content
    let existingContent = '';
    try {
        existingContent = fs.readFileSync(cmakePath, 'utf8');
    } catch (e) {
        vscode.window.showErrorMessage(`ESP: Failed to read ${cmakePath}: ${e.message}`);
        return;
    }

    // Parse content
    let parsed;
    if (isRoot) {
        parsed = parseCmakeRoot(existingContent);
    } else {
        parsed = parseCmakeComponentRegister(existingContent);
    }

    // Gather available components
    const idfPath = getValidIdfPath();
    const sdkComps = idfPath ? scanComponents(path.join(idfPath, 'components')) : [];
    const projComps = root ? scanComponents(path.join(root, 'components')) : [];
    const projSet = new Set(projComps);
    const allComps = [...projComps, ...sdkComps.filter(c => !projSet.has(c) && c !== componentName)];

    // Create webview panel
    const title = isRoot
        ? `CMake Editor — ${path.basename(root)} (root)`
        : `CMake Editor — ${componentName}`;
    const panel = vscode.window.createWebviewPanel(
        'espCmakeEditor',
        title,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(getGlobalCtx().extensionPath, 'media')),
            ],
        }
    );

    // Build HTML
    panel.webview.html = _getCmakeEditorHtml(
        componentName,
        cmakePath,
        parsed,
        root,
        componentDir,
        allComps,
        isRoot
    );

    _cmakePanels.set(cmakePath, { panel, isDirty: false });

    // ─── Message handler ──────────────────────────────────────────────
    panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'setDirty') {
            const entry = _cmakePanels.get(cmakePath);
            if (entry) entry.isDirty = msg.dirty;
            return;
        }

        if (msg.command === 'save') {
            // Block saving during build/compilation
            const busyName = getGlobalBusyName();
            if (busyName) {
                vscode.window.showWarningMessage(
                    `ESP: Cannot save CMakeLists.txt while "${busyName}" is running. Wait for it to finish.`,
                    'Show Terminal'
                ).then(c => { if (c === 'Show Terminal') vscode.commands.executeCommand('workbench.action.terminal.focus'); });
                // Re-enable dirty state since save was rejected
                const entry = _cmakePanels.get(cmakePath);
                if (entry) entry.isDirty = true;
                panel.webview.postMessage({ command: 'setBusy', busy: true, task: busyName });
                return;
            }
            try {
                let newContent;
                if (isRoot) {
                    newContent = generateCmakeRoot(msg.data);
                } else if (msg.data.cmakeFormat === 'legacy') {
                    newContent = generateCmakeLegacyRegister(msg.data);
                } else {
                    newContent = generateCmakeComponentRegister(msg.data);
                }
                fs.writeFileSync(cmakePath, newContent, 'utf8');
                const entry = _cmakePanels.get(cmakePath);
                if (entry) entry.isDirty = false;
                vscode.window.showInformationMessage(`✅ Saved: ${cmakePath}`);
            } catch (e) {
                vscode.window.showErrorMessage(`ESP: Failed to save CMakeLists.txt: ${e.message}`);
            }
            return;
        }

        if (msg.command === 'pickFiles') {
            try {
                const filters = {};
                const field = msg.target || msg.field || '';
                const fieldUpper = field.toUpperCase();
                if (fieldUpper === 'SRCS' || field === 'srcs' || fieldUpper === 'EXCLUDE_SRCS' || field === 'excludeSrcs') {
                    filters['Source files'] = ['c', 'cpp', 'cc', 'cxx', 'S', 's'];
                    filters['All files'] = ['*'];
                } else if (fieldUpper === 'LDFRAGMENTS' || field === 'ldfragments') {
                    filters['Linker fragments'] = ['lf'];
                    filters['All files'] = ['*'];
                } else if (fieldUpper === 'EMBED_FILES' || field === 'embedFiles') {
                    filters['Binary files'] = ['bin'];
                    filters['All files'] = ['*'];
                } else if (fieldUpper === 'EMBED_TXTFILES' || field === 'embedTxtFiles') {
                    filters['Text files'] = ['html', 'htm', 'txt', 'json', 'xml', 'css', 'js'];
                    filters['All files'] = ['*'];
                } else {
                    filters['All files'] = ['*'];
                }

                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: true,
                    defaultUri: vscode.Uri.file(componentDir),
                    filters,
                    title: `Select files for ${field}`,
                    openLabel: 'Add',
                });
                if (!uris || uris.length === 0) return;

                // Make paths relative to component dir
                const relPaths = uris.map(u => {
                    const abs = u.fsPath;
                    if (abs.startsWith(componentDir + path.sep) || abs === componentDir) {
                        return path.relative(componentDir, abs).replace(/\\/g, '/');
                    }
                    return abs.replace(/\\/g, '/');
                });

                panel.webview.postMessage({
                    command: 'setPickedFiles',
                    target: field,
                    files: relPaths,
                });
            } catch (e) {
                vscode.window.showErrorMessage(`ESP: File picker failed: ${e.message}`);
            }
            return;
        }

        if (msg.command === 'pickFolder') {
            try {
                const folderField = msg.target || msg.field || '';
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: true,
                    defaultUri: vscode.Uri.file(componentDir),
                    title: `Select folder for ${folderField}`,
                    openLabel: 'Add',
                });
                if (!uris || uris.length === 0) return;

                const relPaths = uris.map(u => {
                    const abs = u.fsPath;
                    if (abs.startsWith(componentDir + path.sep) || abs === componentDir) {
                        return path.relative(componentDir, abs).replace(/\\/g, '/') || '.';
                    }
                    return abs.replace(/\\/g, '/');
                });

                panel.webview.postMessage({
                    command: 'setPickedFiles',
                    target: folderField,
                    files: relPaths,
                });
            } catch (e) {
                vscode.window.showErrorMessage(`ESP: Folder picker failed: ${e.message}`);
            }
            return;
        }

        if (msg.command === 'pickComponents') {
            try {
                const currentList = (msg.currentValues || []).join(', ');
                const selected = await pickComponents(currentList, root, componentName);
                if (selected === undefined) return; // cancelled

                const type = msg.type || 'requires';

                panel.webview.postMessage({
                    command: 'setPickedComponents',
                    type: type,
                    components: selected,
                });
            } catch (e) {
                vscode.window.showErrorMessage(`ESP: Component picker failed: ${e.message}`);
            }
            return;
        }

        if (msg.command === 'scanDirectory') {
            try {
                const dirs = msg.dirs || (msg.directory ? [msg.directory] : ['.']);
                const extensions = msg.extensions || ['.c', '.cpp', '.cc', '.cxx', '.S', '.s'];
                let allFiles = [];
                for (const dir of dirs) {
                    const absDir = path.resolve(componentDir, dir);
                    if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
                        const files = _scanDirRecursive(absDir, extensions, componentDir);
                        allFiles.push(...files);
                    }
                }
                // Remove duplicates
                allFiles = [...new Set(allFiles)].sort();
                panel.webview.postMessage({
                    command: 'setScannedFiles',
                    files: allFiles,
                });
            } catch (e) {
                panel.webview.postMessage({
                    command: 'setScannedFiles',
                    files: [],
                });
            }
            return;
        }

        if (msg.command === 'refresh') {
            try {
                let freshContent = '';
                try { freshContent = fs.readFileSync(cmakePath, 'utf8'); } catch {}
                let freshParsed;
                if (isRoot) {
                    freshParsed = parseCmakeRoot(freshContent);
                } else {
                    freshParsed = parseCmakeComponentRegister(freshContent);
                }
                panel.webview.postMessage({
                    command: 'refreshData',
                    data: freshParsed,
                });
            } catch (e) {
                vscode.window.showErrorMessage(`ESP: Refresh failed: ${e.message}`);
            }
            return;
        }
    });

    // ─── Panel visibility: sync busy state when panel becomes visible ───
    panel.onDidChangeViewState(e => {
        if (e.webviewPanel.visible) {
            const busyName = getGlobalBusyName();
            if (busyName) {
                panel.webview.postMessage({ command: 'setBusy', busy: true, task: busyName });
            }
        }
    });

    // ─── Panel lifecycle ──────────────────────────────────────────────
    panel.onDidDispose(() => {
        const entry = _cmakePanels.get(cmakePath);
        if (entry && entry.isDirty) {
            vscode.window.showWarningMessage(
                'ESP CMake Editor was closed with unsaved changes.'
            );
        }
        _cmakePanels.delete(cmakePath);
    }, null, []);
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  CLOSE ALL PANELS                                                   ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Close all open CMake editor panels.
 * Called when the active workspace root changes.
 */
function closeAllCmakePanels() {
    for (const [cmakePath, entry] of _cmakePanels) {
        if (entry && entry.panel) {
            entry.panel.dispose();
        }
    }
    _cmakePanels.clear();
}

/**
 * Notify all open CMake editor panels about busy state changes.
 * Called from helpers.js setBusy/clearBusy via the extension.js hook.
 *
 * @param {boolean} busy   Whether a task is running.
 * @param {string}  name   Name of the running task (empty when not busy).
 */
function notifyBusyState(busy, name) {
    for (const [, entry] of _cmakePanels) {
        if (entry && entry.panel) {
            entry.panel.webview.postMessage({
                command: 'setBusy',
                busy: busy,
                task: name || '',
            });
        }
    }
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  HTML TEMPLATE                                                      ║
// ╚══════════════════════════════════════════════════════════════════╝

function _getCmakeEditorHtml(componentName, cmakePath, parsed, root, componentDir, availableComponents, isRoot) {
    const templatePath = path.join(getGlobalCtx().extensionPath, 'media', 'cmake-editor.html');

    // Fallback: if the HTML template doesn't exist yet, generate inline HTML
    let html;
    if (fs.existsSync(templatePath)) {
        html = fs.readFileSync(templatePath, 'utf8');
    } else {
        html = _getDefaultHtmlTemplate();
    }

    // Replace placeholders — use _escJs for values inside <script> JS string literals
    // (_escHtml would produce &amp; &quot; etc which are NOT decoded inside <script> tags)
    html = html.replace(/\{\{COMPONENT_NAME\}\}/g, _escJs(componentName));
    html = html.replace(/\{\{CMAKE_PATH\}\}/g, _escJs(cmakePath));
    html = html.replace(/\{\{INITIAL_DATA\}\}/g, _escJsJson(parsed));
    html = html.replace(/\{\{PROJECT_ROOT\}\}/g, _escJs(root));
    html = html.replace(/\{\{COMPONENT_DIR\}\}/g, _escJs(componentDir));
    html = html.replace(/\{\{AVAILABLE_COMPONENTS\}\}/g, _escJsJson(availableComponents));
    html = html.replace(/\{\{IS_ROOT\}\}/g, isRoot ? 'true' : 'false');
    html = html.replace(/\{\{CMAKE_FORMAT\}\}/g, JSON.stringify(parsed.cmakeFormat || 'modern'));

    // Note: No longer need global </script>/<-- sanitization because
    // _escJsJson() already escapes </script sequences inside the JSON data.
    // The old approach (replacing ALL </script in the entire HTML) was a bug
    // that could break the legitimate closing </script> tag.

    return html;
}

/**
 * Default inline HTML template used when media/cmake-editor.html
 * does not exist yet.
 */
function _getDefaultHtmlTemplate() {
    // Fallback: media/cmake-editor.html should always exist.
    // This stub is only reached if the HTML template file is missing from the extension package.
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body><h2>CMake Editor template not found</h2><p>Please reinstall the extension.</p></body>
</html>`;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  INTERNAL HELPERS                                                   ║
// ╚══════════════════════════════════════════════════════════════════╝

function _emptyComponentParsed() {
    return {
        sourceMode: 'srcs',   // 'srcs' or 'srcDirs'
        srcs: [],
        srcDirs: [],
        excludeSrcs: [],
        includeDirs: [],
        privIncludeDirs: [],
        ldfragments: [],
        requires: [],
        privRequires: [],
        embedFiles: [],
        embedTxtFiles: [],    // Match HTML template naming (uppercase F)
        preambleBlock: '',    // #50: CMake code before idf_component_register() — preserved verbatim
        hasVariableRefs: false, // #50: true if ${...} refs found in REQUIRES/PRIV_REQUIRES
    };
}

function _pushToResult(result, keyword, value) {
    switch (keyword) {
        case 'SRCS':             result.srcs.push(value); break;
        case 'SRC_DIRS':         result.srcDirs.push(value); result.sourceMode = 'srcDirs'; break;
        case 'EXCLUDE_SRCS':     result.excludeSrcs.push(value); break;
        case 'INCLUDE_DIRS':     result.includeDirs.push(value); break;
        case 'PRIV_INCLUDE_DIRS': result.privIncludeDirs.push(value); break;
        case 'LDFRAGMENTS':      result.ldfragments.push(value); break;
        case 'REQUIRES':         result.requires.push(value); break;
        case 'PRIV_REQUIRES':    result.privRequires.push(value); break;
        case 'REQUIRED_IDF_TARGETS': break; // skip in UI
        case 'EMBED_FILES':      result.embedFiles.push(value); break;
        case 'EMBED_TXTFILES':   result.embedTxtFiles.push(value); break;
    }
}

/**
 * Tokenise CMake argument text into atoms, respecting quoted strings.
 */
function _tokeniseCmakeArgs(text) {
    const tokens = [];
    let i = 0;
    const len = text.length;

    while (i < len) {
        // Skip whitespace and newlines
        while (i < len && /\s/.test(text[i])) i++;
        if (i >= len) break;

        // Quoted string
        if (text[i] === '"') {
            let str = '"';
            i++;
            while (i < len && text[i] !== '"') {
                if (text[i] === '\\' && i + 1 < len) {
                    str += text[i] + text[i + 1];
                    i += 2;
                } else {
                    str += text[i];
                    i++;
                }
            }
            if (i < len) { str += '"'; i++; }
            // Extract the content inside quotes as a separate token
            const inner = str.slice(1, -1);
            tokens.push('"' + inner + '"');
            continue;
        }

        // Unquoted word
        let word = '';
        while (i < len && !/\s/.test(text[i]) && text[i] !== '(' && text[i] !== ')') {
            word += text[i];
            i++;
        }
        if (word) tokens.push(word);
    }

    return tokens;
}

/**
 * Strip comment from a line, respecting quoted strings.
 */
function _stripComment(line) {
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && (i === 0 || line[i - 1] !== '\\')) {
            inQuote = !inQuote;
        } else if (ch === '#' && !inQuote) {
            return line.substring(0, i);
        }
    }
    return line;
}

/**
 * Quote a CMake value if needed.  SRCS and file paths are always quoted.
 * REQUIRES/PRIV_REQUIRES values are never quoted by the generator.
 */
function _quoteIfNeeded(value, alwaysQuote) {
    if (alwaysQuote) {
        return '"' + value.replace(/"/g, '\\"') + '"';
    }
    // Quote if contains spaces or special chars
    if (/[\s()#;"']/.test(value)) {
        return '"' + value.replace(/"/g, '\\"') + '"';
    }
    return value;
}

/**
 * Extract values from a set(VAR ...) command in CMake text.
 */
function _extractSetValues(cmakeText, varName) {
    if (!cmakeText) return [];
    const lines = cmakeText.split('\n');
    let setStartLine = -1;
    let parenDepth = 0;
    let valueStr = '';
    const re = new RegExp('^set\\s*\\(\\s*' + varName + '\\s+', 'i');

    for (let i = 0; i < lines.length; i++) {
        const stripped = lines[i].trim();
        if (setStartLine === -1) {
            if (re.test(stripped)) {
                setStartLine = i;
                for (const ch of stripped) {
                    if (ch === '(') parenDepth++;
                    if (ch === ')') parenDepth--;
                }
                const valMatch = stripped.match(new RegExp('^set\\s*\\(\\s*' + varName + '\\s+([\\s\\S]*)', 'i'));
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

/**
 * #50: Detect if any REQUIRES/PRIV_REQUIRES values contain CMake variable references (${...}).
 * Returns an object describing which fields have variable refs and what they are.
 */
function _detectVariableRefs(result) {
    const fields = ['requires', 'privRequires'];
    for (const field of fields) {
        if (!result[field]) continue;
        for (const val of result[field]) {
            if (/\$\{[^}]+\}/.test(val)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Recursively scan a directory for files matching extensions.
 * Returns relative paths from baseDir.
 */
function _scanDirRecursive(dir, extensions, baseDir) {
    const results = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const sub = _scanDirRecursive(fullPath, extensions, baseDir);
                results.push(...sub);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (extensions.includes(ext) || extensions.length === 0) {
                    results.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
                }
            }
        }
    } catch {}
    return results.sort();
}

/**
 * Escape a string for safe inclusion inside a JavaScript string literal
 * within a <script> tag. Unlike HTML entities (&amp; etc), these escapes
 * are correctly interpreted by the JS parser.
 *
 * Handles: backslashes, quotes, newlines, tabs, line separators,
 * and the </script sequence that would break out of the script block.
 */
function _escJs(s) {
    return String(s)
        .replace(/\\/g, '\\\\')      // backslash → \\
        .replace(/"/g, '\\"')        // double quote → \"
        .replace(/'/g, "\\'")        // single quote → \'
        .replace(/\r/g, '\\r')       // carriage return
        .replace(/\n/g, '\\n')       // newline
        .replace(/\t/g, '\\t')       // tab
        .replace(/\u2028/g, '\\u2028') // Line separator (breaks JS strings)
        .replace(/\u2029/g, '\\u2029') // Paragraph separator
        .replace(/<\//g, '<\\/');    // </script → <\/script (prevent breaking out)
}

/**
 * JSON.stringify + escape any </script sequences in the result.
 * This is used for embedding parsed data into a <script> tag as a JS literal.
 * The JSON itself is valid JS, but </script inside a string literal would
 * prematurely close the script block.
 */
function _escJsJson(obj) {
    return JSON.stringify(obj).replace(/<\//g, '<\\/');
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  EXPORTS                                                            ║
// ╚══════════════════════════════════════════════════════════════════╝
module.exports = {
    cmdCmakeEditorMain,
    cmdCmakeEditorComponent,
    cmdCmakeEditorRoot,
    closeAllCmakePanels,
    notifyBusyState,
    parseCmakeComponentRegister,
    parseCmakeLegacyRegister,
    parseCmakeRoot,
    generateCmakeComponentRegister,
    generateCmakeLegacyRegister,
    generateCmakeRoot,
};
