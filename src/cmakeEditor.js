'use strict';

const { vscode, path, fs,
        getActiveRoot, getValidIdfPath, getGlobalCtx,
        checkBusy, warnNoProject, getGlobalBusyName, log,
} = require('./helpers');

const { scanComponents, pickComponents, readExcludedComponentsFromText } = require('./components');

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
    // If the preamble is ONLY comments and whitespace, skip it — such comments are
    // specific to the original file layout and become stale/misleading when regenerated.
    //
    // IMPORTANT: We must find idf_component_register() in the ORIGINAL text at the
    // SAME position as in the cleaned text — otherwise a commented-out
    // idf_component_register() inside a # comment would be matched incorrectly.
    const originalStartIdx = _mapCleanedPosToOriginal(lines, cleaned, startIdx);
    if (originalStartIdx > 0) {
        const preambleRaw = normalised.substring(0, originalStartIdx);
        // Only keep non-empty preamble that contains actual CMake code (not just comments)
        if (preambleRaw.trim().length > 0 && !_isOnlyComments(preambleRaw)) {
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

    // Variant C: Resolve preamble variables for SRCS
    const { vars: preambleVars, conditionalVars: preambleConditionalVars } = _resolvePreambleVars(result.preambleBlock);

    // Check if any SRCS value is a variable reference
    for (let i = 0; i < result.srcs.length; i++) {
        const src = result.srcs[i];
        const varMatch = src.match(/^\$\{(\w+)\}$/);
        if (varMatch) {
            const varName = varMatch[1];
            result.srcVarName = varName;
            result.srcsOriginalRef = src;

            // Replace the ${varName} entry with expanded values
            result.srcs.splice(i, 1); // remove "${srcs}"

            // Add non-conditional values
            if (preambleVars[varName]) {
                result.srcVarValues = [...preambleVars[varName]];
                result.srcs.push(...preambleVars[varName]);
            }

            // Add conditional values
            if (preambleConditionalVars[varName]) {
                result.conditionalSrcs = [...preambleConditionalVars[varName]];
                for (const cond of preambleConditionalVars[varName]) {
                    result.srcs.push(cond.file);
                }
            }

            break;
        }
    }

    // #50: Detect variable references (${...}) in REQUIRES/PRIV_REQUIRES
    // Mark them so the UI can warn the user and handle them specially.
    result.hasVariableRefs = _detectVariableRefs(result);

    // #50: Extract postamble (code after idf_component_register() closing paren)
    // Use originalStartIdx (already mapped from cleaned text) instead of
    // re-searching the original text, to avoid matching commented-out calls.
    if (originalStartIdx >= 0) {
        let origDepth = 0;
        let origEndIdx = -1;
        for (let i = originalStartIdx; i < normalised.length; i++) {
            if (normalised[i] === '(') origDepth++;
            if (normalised[i] === ')') {
                origDepth--;
                if (origDepth === 0) {
                    origEndIdx = i;
                    break;
                }
            }
        }
        if (origEndIdx !== -1) {
            const afterRegister = normalised.substring(origEndIdx + 1);
            // Skip postamble if it's only comments and whitespace
            if (afterRegister.trim().length > 0 && !_isOnlyComments(afterRegister)) {
                result.postambleBlock = '\n' + afterRegister.trim() + '\n';
            }
        }
    }

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

    // Check if register_component() exists (in comment-stripped text)
    const legacyCleaned = normalised.split('\n').map(l => _stripComment(l)).join('\n');
    if (!/register_component\s*\(/.test(legacyCleaned)) {
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

    // #50: For legacy format, capture CMake code BEFORE register_component() as preamble,
    // and code AFTER register_component() as postamble.
    const legacyPreambleLines = [];
    const legacySetRe = /^set\s*\(\s*COMPONENT_\w+\s/i;
    const legacyRegisterRe = /^register_component\s*\(/i;

    // Find the line index of register_component() — skip commented lines
    const lines = normalised.split('\n');
    let registerLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const cleanedLine = _stripComment(lines[i]).trim();
        if (legacyRegisterRe.test(cleanedLine)) {
            registerLineIdx = i;
            break;
        }
    }

    // Collect preamble lines (BEFORE register_component)
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue; // skip blank lines
        if (i >= registerLineIdx && registerLineIdx !== -1) break; // stop at register_component
        if (legacySetRe.test(trimmed)) continue;
        if (legacyRegisterRe.test(trimmed)) continue;
        legacyPreambleLines.push(lines[i]);
    }
    if (legacyPreambleLines.length > 0) {
        const legacyPreambleText = legacyPreambleLines.join('\n');
        // Skip preamble if it's only comments and whitespace
        if (!_isOnlyComments(legacyPreambleText)) {
            result.preambleBlock = legacyPreambleText.trimEnd() + '\n\n';
        }
    }

    // Collect postamble lines (AFTER register_component())
    if (registerLineIdx !== -1) {
        // Find register_component() in the comment-stripped text, then map back
        const regCompMatch = legacyCleaned.match(/register_component\s*\(\s*\)/);
        if (regCompMatch) {
            // Map the position from cleaned to original text
            const origLines = normalised.split('\n');
            const origCleaned = origLines.map(l => _stripComment(l));
            const origRegCompIdx = _mapCleanedPosToOriginal(origLines, origCleaned, regCompMatch.index);
            if (origRegCompIdx >= 0) {
                const afterRegComp = normalised.substring(origRegCompIdx + regCompMatch[0].length);
                // Skip postamble if it's only comments and whitespace
                if (afterRegComp.trim().length > 0 && !_isOnlyComments(afterRegComp)) {
                    result.postambleBlock = '\n' + afterRegComp.trim() + '\n';
                }
            }
        }
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
        components: [],              // set(COMPONENTS ...) — whitelist
        sdkconfig: '',               // set(SDKCONFIG ...) — single file path
        sdkconfigDefaults: [],        // set(SDKCONFIG_DEFAULTS ...) — list of file paths
        ccacheEnable: false,          // set(CCACHE_ENABLE 1)
        rootPreambleBlock: '',        // code between include() and project() — preserved verbatim
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

    // Extract EXCLUDE_COMPONENTS from set() command — uses shared implementation from components.js
    result.excludeComponents = readExcludedComponentsFromText(normalised);

    // Extract EXTRA_COMPONENT_DIRS from set() command
    result.extraComponentDirs = _extractSetValues(normalised, 'EXTRA_COMPONENT_DIRS');

    // Extract COMPONENTS from set() command (whitelist)
    result.components = _extractSetValues(normalised, 'COMPONENTS');

    // Extract SDKCONFIG (single value)
    const sdkconfigVals = _extractSetValues(normalised, 'SDKCONFIG');
    result.sdkconfig = sdkconfigVals.length > 0 ? sdkconfigVals[0] : '';

    // Extract SDKCONFIG_DEFAULTS
    result.sdkconfigDefaults = _extractSetValues(normalised, 'SDKCONFIG_DEFAULTS');

    // Extract CCACHE_ENABLE
    const ccacheVals = _extractSetValues(normalised, 'CCACHE_ENABLE');
    result.ccacheEnable = ccacheVals.length > 0 && (ccacheVals[0] === '1' || ccacheVals[0].toLowerCase() === 'on' || ccacheVals[0].toLowerCase() === 'true');

    // Extract root preamble (code between include() and project() that isn't a known set() command)
    if (projMatch) {
        const includeMatch = normalised.match(/include\s*\(\s*\$ENV\{IDF_PATH\}[\s\S]*?\)/);
        if (includeMatch) {
            const includeEnd = includeMatch.index + includeMatch[0].length;
            const projectStart = projMatch.index;
            const betweenText = normalised.substring(includeEnd, projectStart);

            // Remove the known set() commands from betweenText to get the custom preamble
            let customPreamble = betweenText;
            customPreamble = customPreamble.replace(/set\s*\(\s*COMPONENTS\s+[\s\S]*?\)\s*/gi, '');
            customPreamble = customPreamble.replace(/set\s*\(\s*EXCLUDE_COMPONENTS\s+[\s\S]*?\)\s*/gi, '');
            customPreamble = customPreamble.replace(/set\s*\(\s*EXTRA_COMPONENT_DIRS\s+[\s\S]*?\)\s*/gi, '');
            customPreamble = customPreamble.replace(/set\s*\(\s*SDKCONFIG\s+[\s\S]*?\)\s*/gi, '');
            customPreamble = customPreamble.replace(/set\s*\(\s*SDKCONFIG_DEFAULTS\s+[\s\S]*?\)\s*/gi, '');
            customPreamble = customPreamble.replace(/set\s*\(\s*CCACHE_ENABLE\s+[\s\S]*?\)\s*/gi, '');
            // Remove cmake_minimum_required and include lines (already auto-generated)
            customPreamble = customPreamble.replace(/cmake_minimum_required\s*\([\s\S]*?\)\s*/gi, '');
            customPreamble = customPreamble.replace(/include\s*\([\s\S]*?\)\s*/gi, '');

            if (customPreamble.trim().length > 0) {
                result.rootPreambleBlock = customPreamble.trimEnd() + '\n';
            }
        }
    }

    return result;
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

    // Variant C / #50: Prepend preamble block
    let preamble = '';
    if (parsed.preambleBlock && parsed.preambleBlock.trim().length > 0) {
        let preambleText = parsed.preambleBlock.trimEnd();
        // If flattening (srcVarName + srcsModified), strip set()/list(APPEND) for the variable
        if (parsed.srcVarName && parsed.srcsModified) {
            const varName = parsed.srcVarName;
            const escapedVarName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Remove set(varName ...)
            preambleText = preambleText.replace(new RegExp('set\\s*\\(\\s*' + escapedVarName + '\\s+[\\s\\S]*?\\)', 'g'), '');
            // Remove if()/endif() blocks containing list(APPEND varName ...)
            preambleText = preambleText.replace(new RegExp('if\\s*\\([^)]*\\)[\\s\\S]*?list\\s*\\(\\s*APPEND\\s+' + escapedVarName + '\\s+[\\s\\S]*?endif\\s*\\(\\s*\\)', 'g'), '');
            preambleText = preambleText.replace(/\n{3,}/g, '\n\n').trim();
        }
        if (preambleText.trim().length > 0) {
            preamble = preambleText.trimEnd() + '\n\n';
        }
    }

    // Variant C: SRCS line — preserve variable reference or flatten
    if (mode === 'srcs' && parsed.srcs && parsed.srcs.length > 0) {
        if (parsed.srcVarName && !parsed.srcsModified) {
            // Preserve original variable reference
            parts.push('    SRCS ${' + parsed.srcVarName + '}');
        } else {
            parts.push('    SRCS ' + parsed.srcs.map(s => _quoteIfNeeded(s, true)).join(' '));
        }
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

    // REQUIRED_IDF_TARGETS
    if (parsed.requiredIdfTargets && parsed.requiredIdfTargets.length > 0) {
        parts.push('    REQUIRED_IDF_TARGETS ' + parsed.requiredIdfTargets.join(' '));
    }

    if (parts.length === 0) {
        let output = preamble + 'idf_component_register()\n';
        // Append postamble
        if (parsed.postambleBlock && parsed.postambleBlock.trim().length > 0) {
            output += '\n' + parsed.postambleBlock.trim() + '\n';
        }
        return output;
    }

    let output = preamble + 'idf_component_register(\n' + parts.join('\n') + '\n)\n';
    // Append postamble
    if (parsed.postambleBlock && parsed.postambleBlock.trim().length > 0) {
        output += '\n' + parsed.postambleBlock.trim() + '\n';
    }
    return output;
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

    // Append postamble (code after register_component())
    if (parsed.postambleBlock && parsed.postambleBlock.trim().length > 0) {
        out += '\n' + parsed.postambleBlock.trim() + '\n';
    }

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

    // set(COMPONENTS ...) — whitelist
    if (parsed.components && parsed.components.length > 0) {
        out += 'set(COMPONENTS ' + parsed.components.join(' ') + ')\n';
    }

    if (parsed.excludeComponents && parsed.excludeComponents.length > 0) {
        out += 'set(EXCLUDE_COMPONENTS ' + parsed.excludeComponents.join(' ') + ')\n';
    }

    if (parsed.extraComponentDirs && parsed.extraComponentDirs.length > 0) {
        out += 'set(EXTRA_COMPONENT_DIRS ' + parsed.extraComponentDirs.map(d => _quoteIfNeeded(d)).join(' ') + ')\n';
    }

    // set(SDKCONFIG ...) — single file path
    if (parsed.sdkconfig && parsed.sdkconfig.trim()) {
        out += 'set(SDKCONFIG ' + _quoteIfNeeded(parsed.sdkconfig.trim()) + ')\n';
    }

    // set(SDKCONFIG_DEFAULTS ...) — list of file paths
    if (parsed.sdkconfigDefaults && parsed.sdkconfigDefaults.length > 0) {
        out += 'set(SDKCONFIG_DEFAULTS ' + parsed.sdkconfigDefaults.map(d => _quoteIfNeeded(d)).join(' ') + ')\n';
    }

    // set(CCACHE_ENABLE 1)
    if (parsed.ccacheEnable) {
        out += 'set(CCACHE_ENABLE 1)\n';
    }

    // Root preamble (custom code before project)
    if (parsed.rootPreambleBlock && parsed.rootPreambleBlock.trim().length > 0) {
        out += parsed.rootPreambleBlock.trimEnd() + '\n';
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
    let panel;
    try {
        panel = vscode.window.createWebviewPanel(
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
    } catch (e) {
        if (panel) try { panel.dispose(); } catch {}
        throw e;
    }

    _cmakePanels.set(cmakePath, { panel, isDirty: false, isRoot });

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
                let canSelectMany = true;  // default: allow multiple selection
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
                } else if (field === 'sdkconfig') {
                    filters['Config files'] = ['sdkconfig', 'config'];
                    filters['All files'] = ['*'];
                    canSelectMany = false;  // single file only
                } else if (field === 'sdkconfigDefaults') {
                    filters['Config files'] = ['sdkconfig', 'config', 'defaults'];
                    filters['All files'] = ['*'];
                } else {
                    filters['All files'] = ['*'];
                }

                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: canSelectMany,
                    defaultUri: vscode.Uri.file(componentDir),
                    filters,
                    title: `Select files for ${field}`,
                    openLabel: 'Add',
                });
                if (!uris || uris.length === 0) {
                    panel.webview.postMessage({ command: 'setPickedFiles', target: field, files: [], cancelled: true });
                    return;
                }

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

        // #FIX(1.85.0): removed dead pickComponents handler — the HTML
        // (cmake-editor.html) uses its own LOCAL component picker overlay
        // (function pickComponents opens an in-page overlay, never posts a
        // 'pickComponents' message to the host), so this branch was
        // unreachable dead code.

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

        if (msg.command === 'confirmRefresh') {
            const result = await vscode.window.showWarningMessage(
                'Discard unsaved changes and reload from disk?',
                { modal: true },
                'Discard Changes'
            );
            panel.webview.postMessage({ command: 'confirmRefreshResult', confirmed: result === 'Discard Changes' });
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

/**
 * Save all dirty CMake editor panels automatically.
 * Called before build/flash to ensure CMakeLists.txt files are up-to-date.
 * Requests current form data from each dirty webview and writes to disk.
 *
 * @returns {Promise<number>} Number of panels that were saved.
 */
async function saveAllDirtyCmakePanels() {
    let saved = 0;
    for (const [cmakePath, entry] of _cmakePanels) {
        if (!entry || !entry.isDirty || !entry.panel) continue;
        try {
            await new Promise((resolve, reject) => {
                // #FIX(1.85.0): The handler is referenced inside the timeout
                // callback below, so it must be declared before the timeout is
                // scheduled (TDZ-safe). On timeout we dispose the leaked
                // message listener before rejecting so repeated failed
                // auto-saves don't accumulate stale onDidReceiveMessage
                // listeners on the webview.
                let handler;
                const timeout = setTimeout(() => {
                    // #FIX(1.85.0): dispose the leaked handler before rejecting
                    // so the listener doesn't survive the failed auto-save.
                    if (handler) handler.dispose();
                    reject(new Error('timeout'));
                }, 3000);
                handler = entry.panel.webview.onDidReceiveMessage(async msg => {
                    if (msg.command === 'save') {
                        clearTimeout(timeout);
                        handler.dispose(); // #FIX(1.85.0): dispose on success path too
                        // Write the file using the same logic as the manual save handler
                        const { isRoot } = entry;
                        let newContent;
                        if (isRoot) {
                            newContent = generateCmakeRoot(msg.data);
                        } else if (msg.data.cmakeFormat === 'legacy') {
                            newContent = generateCmakeLegacyRegister(msg.data);
                        } else {
                            newContent = generateCmakeComponentRegister(msg.data);
                        }
                        fs.writeFileSync(cmakePath, newContent, 'utf8');
                        entry.isDirty = false;
                        entry.panel.webview.postMessage({ command: 'saved' });
                        saved++;
                        resolve();
                    }
                });
                // Ask the webview to send its current form data as a save
                entry.panel.webview.postMessage({ command: 'requestSave' });
            });
        } catch (e) {
            log(`[cmakeEditor] Auto-save failed for ${cmakePath}: ${e.message}`);
        }
    }
    if (saved > 0) {
        log(`[cmakeEditor] Auto-saved ${saved} dirty CMake editor(s) before build`);
    }
    return saved;
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
    // Legacy templates (kept for backward compat if HTML still references them):
    // #FIX(1.85.0): Use function replacements so user data containing $&, $`,
    // $', or $1–$9 is NOT interpreted as a special replacement pattern by
    // String.replace (which would corrupt the HTML/JS). Only literals that are
    // known to be safe (e.g. 'true'/'false') keep the plain string form.
    html = html.replace(/\{\{COMPONENT_NAME\}\}/g, () => _escJs(componentName));
    html = html.replace(/\{\{CMAKE_PATH\}\}/g, () => _escJs(cmakePath));
    html = html.replace(/\{\{INITIAL_DATA\}\}/g, () => _escJsJson(parsed));
    html = html.replace(/\{\{PROJECT_ROOT\}\}/g, () => _escJs(root));
    html = html.replace(/\{\{COMPONENT_DIR\}\}/g, () => _escJs(componentDir));
    html = html.replace(/\{\{AVAILABLE_COMPONENTS\}\}/g, () => _escJsJson(availableComponents));
    html = html.replace(/\{\{IS_ROOT\}\}/g, isRoot ? 'true' : 'false');
    html = html.replace(/\{\{CMAKE_FORMAT\}\}/g, () => JSON.stringify(parsed.cmakeFormat || 'modern'));
    // JSON-safe templates (new — for _JSON suffixed placeholders in HTML):
    html = html.replace(/\{\{COMPONENT_NAME_JSON\}\}/g, () => _escJsJson(componentName));
    html = html.replace(/\{\{CMAKE_PATH_JSON\}\}/g, () => _escJsJson(cmakePath));
    html = html.replace(/\{\{PROJECT_ROOT_JSON\}\}/g, () => _escJsJson(root));
    html = html.replace(/\{\{COMPONENT_DIR_JSON\}\}/g, () => _escJsJson(componentDir));
    html = html.replace(/\{\{AVAILABLE_COMPONENTS_JSON\}\}/g, () => _escJsJson(availableComponents));
    html = html.replace(/\{\{CMAKE_FORMAT_JSON\}\}/g, () => _escJsJson(parsed.cmakeFormat || 'modern'));

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
        requiredIdfTargets: [],   // REQUIRED_IDF_TARGETS values
        embedFiles: [],
        embedTxtFiles: [],    // Match HTML template naming (uppercase F)
        preambleBlock: '',    // #50: CMake code before idf_component_register() — preserved verbatim
        postambleBlock: '',   // CMake code after idf_component_register() / register_component() — preserved verbatim
        hasVariableRefs: false, // #50: true if ${...} refs found in REQUIRES/PRIV_REQUIRES
        srcVarName: null,         // Variant C: variable name (e.g. "srcs") if SRCS uses a variable
        srcVarValues: [],         // Variant C: non-conditional files resolved from the variable
        conditionalSrcs: [],      // Variant C: [{file, condition}] for files inside if/endif blocks
        srcsOriginalRef: null,    // Variant C: original reference string (e.g. "${srcs}")
        srcsModified: false,      // Variant C: tracks if user changed SRCS in the UI
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
        case 'REQUIRED_IDF_TARGETS': result.requiredIdfTargets.push(value); break;
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
 * Map a position in the comment-stripped (cleaned) text back to the
 * corresponding position in the original text.
 *
 * Since _stripComment only removes content AFTER '#' on each line,
 * the column position within a matching line is the same in both texts.
 * We just need to find which line the cleaned position falls on,
 * then calculate the original offset by summing original line lengths.
 *
 * @param {string[]} origLines   Original lines (from normalised.split('\n'))
 * @param {string[]} cleanLines  Comment-stripped lines (same length as origLines)
 * @param {number}   cleanPos    Position in the cleaned text
 * @returns {number} Corresponding position in the original text, or -1 if not found
 */
function _mapCleanedPosToOriginal(origLines, cleanLines, cleanPos) {
    let cumulClean = 0;
    let cumulOrig = 0;
    for (let i = 0; i < cleanLines.length; i++) {
        const cLine = cleanLines[i];
        const oLine = origLines[i];
        // +1 for the newline character that was used in join('\n')
        const cLineLen = cLine.length + 1;
        const oLineLen = oLine.length + 1;

        if (cleanPos >= cumulClean && cleanPos < cumulClean + cLineLen) {
            // The target position falls within this line
            const colOffset = cleanPos - cumulClean;
            return cumulOrig + colOffset;
        }
        cumulClean += cLineLen;
        cumulOrig += oLineLen;
    }
    return -1;
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
 * Check if a block of text contains only comment lines and whitespace,
 * with no actual CMake code (set(), if(), etc.).
 * Used to avoid preserving pure-comment preambles/postambles that would
 * become stale or misleading when the file is regenerated.
 *
 * @param {string} text  The text to check.
 * @returns {boolean} True if the text contains only comments and whitespace.
 */
function _isOnlyComments(text) {
    if (!text || !text.trim()) return true;
    const lines = text.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;           // blank line — ok
        if (trimmed.startsWith('#')) continue; // comment line — ok
        return false;                      // actual code found
    }
    return true;
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
 * Variant C: Parse preamble block for set(varName ...) and list(APPEND varName ...)
 * inside if()/endif() blocks.
 *
 * @param {string} preambleBlock  The preamble text before idf_component_register().
 * @returns {{ vars: object, conditionalVars: object }}
 *   vars: varName -> [values]
 *   conditionalVars: varName -> [{file, condition}]
 */
function _resolvePreambleVars(preambleBlock) {
    const vars = {};  // varName -> [values]
    const conditionalVars = {};  // varName -> [{file, condition}]

    if (!preambleBlock) return { vars, conditionalVars };

    const normalised = preambleBlock.replace(/\r\n/g, '\n');

    // Parse set(varName val1 val2 ...)
    // Handle multi-line set() with quoted values
    const setRegex = /set\s*\(\s*(\w+)\s+([\s\S]*?)\)/g;
    let match;
    while ((match = setRegex.exec(normalised)) !== null) {
        const varName = match[1];
        // Only lowercase variable names (convention for local vars like `srcs`)
        if (varName !== varName.toLowerCase()) continue;
        const valuesStr = match[2];
        const values = _tokeniseCmakeArgs(valuesStr).map(a => a.replace(/^"|"$/g, '')).filter(Boolean);
        vars[varName] = values;
    }

    // #FIX: Parse list(APPEND varName ...) inside if()/endif() blocks
    // Use balanced-depth parser instead of regex — the old regex with non-greedy
    // [\s\S]*? incorrectly matched the FIRST endif() (inner one for nested blocks)
    // instead of the matching outer endif().
    const ifBlocks = _extractBalancedIfBlocks(normalised);
    for (const { condition, body } of ifBlocks) {
        const listRegex = /list\s*\(\s*APPEND\s+(\w+)\s+([\s\S]*?)\)/g;
        let listMatch;
        while ((listMatch = listRegex.exec(body)) !== null) {
            const varName = listMatch[1];
            const valuesStr = listMatch[2];
            const values = _tokeniseCmakeArgs(valuesStr).map(a => a.replace(/^"|"$/g, '')).filter(Boolean);
            if (!conditionalVars[varName]) conditionalVars[varName] = [];
            for (const v of values) {
                conditionalVars[varName].push({ file: v, condition: condition });
            }
        }
    }

    // Also handle unconditional list(APPEND varName ...) outside if/endif blocks
    const globalListRegex = /list\s*\(\s*APPEND\s+(\w+)\s+([\s\S]*?)\)/g;
    while ((match = globalListRegex.exec(normalised)) !== null) {
        const varName = match[1];
        // Check if this occurrence is inside any if/endif block (using balanced blocks)
        const matchStart = match.index;
        let insideIf = false;
        for (const blk of ifBlocks) {
            if (matchStart >= blk.startIdx && matchStart < blk.startIdx + blk.length) {
                insideIf = true;
                break;
            }
        }
        if (insideIf) continue; // already handled by conditional vars

        const valuesStr = match[2];
        const values = _tokeniseCmakeArgs(valuesStr).map(a => a.replace(/^"|"$/g, '')).filter(Boolean);
        if (!vars[varName]) vars[varName] = [];
        vars[varName].push(...values);
    }

    return { vars, conditionalVars };
}

/**
 * Extract top-level if()/endif() blocks from CMake text using balanced depth
 * counting. Handles nested if()/endif() correctly — each block's body may
 * contain inner if()/endif() pairs which are NOT split.
 *
 * @param {string} text  CMake text (normalised, no CRLF)
 * @returns {Array<{condition: string, body: string, startIdx: number, length: number}>}
 */
function _extractBalancedIfBlocks(text) {
    const results = [];
    const ifRe = /\bif\s*\(/gi;

    let pos = 0;
    while (pos < text.length) {
        // Find the next top-level if()
        ifRe.lastIndex = pos;
        const ifMatch = ifRe.exec(text);
        if (!ifMatch) break;

        const ifStart = ifMatch.index;

        // Extract condition: find the matching ) after if(
        let condDepth = 0;
        let condEnd = -1;
        for (let i = ifStart + ifMatch[0].length - 1; i < text.length; i++) {
            if (text[i] === '(') condDepth++;
            if (text[i] === ')') {
                condDepth--;
                if (condDepth === 0) { condEnd = i; break; }
            }
        }
        if (condEnd === -1) { pos = ifStart + 1; continue; }

        const condition = text.substring(ifStart + ifMatch[0].length, condEnd).trim();

        // Now find the matching endif() at depth 0
        let depth = 1; // we're inside the if block
        let searchPos = condEnd + 1;
        let blockEndIdx = -1; // index of the closing ')' of the matching endif()

        while (searchPos < text.length && depth > 0) {
            const subIfRe = /\bif\s*\(/gi;
            const subEndifRe = /\bendif\s*\(/gi;

            subIfRe.lastIndex = searchPos;
            subEndifRe.lastIndex = searchPos;

            const subIfMatch = subIfRe.exec(text);
            const subEndifMatch = subEndifRe.exec(text);

            const ifPos = subIfMatch ? subIfMatch.index : Infinity;
            const endifPos = subEndifMatch ? subEndifMatch.index : Infinity;

            if (ifPos < endifPos) {
                depth++;
                // Skip past the if(...) opening parens
                let d = 0;
                for (let i = subIfMatch.index + subIfMatch[0].length - 1; i < text.length; i++) {
                    if (text[i] === '(') d++;
                    if (text[i] === ')') { d--; if (d === 0) { searchPos = i + 1; break; } }
                }
                if (d !== 0) searchPos = text.length;
            } else if (endifPos < Infinity) {
                depth--;
                // Find closing ) of endif(...)
                let d = 0;
                let endParenIdx = -1;
                for (let i = subEndifMatch.index + subEndifMatch[0].length - 1; i < text.length; i++) {
                    if (text[i] === '(') d++;
                    if (text[i] === ')') { d--; if (d === 0) { endParenIdx = i; break; } }
                }
                if (depth === 0 && endParenIdx !== -1) {
                    blockEndIdx = endParenIdx;
                }
                searchPos = endParenIdx !== -1 ? endParenIdx + 1 : text.length;
            } else {
                break; // no more if/endif found
            }
        }

        if (depth === 0 && blockEndIdx !== -1) {
            // Body is between the condition's closing ) and the endif keyword
            const endifKeywordStart = text.lastIndexOf('endif', blockEndIdx);
            const bodyText = text.substring(condEnd + 1, endifKeywordStart);
            results.push({
                condition,
                body: bodyText,
                startIdx: ifStart,
                length: blockEndIdx + 1 - ifStart,
            });
            pos = blockEndIdx + 1;
        } else {
            pos = ifStart + 1; // unmatched if, skip
        }
    }
    return results;
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
    saveAllDirtyCmakePanels,
    parseCmakeComponentRegister,
    parseCmakeLegacyRegister,
    parseCmakeRoot,
    generateCmakeComponentRegister,
    generateCmakeLegacyRegister,
    generateCmakeRoot,
};
