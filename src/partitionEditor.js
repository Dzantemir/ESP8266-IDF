'use strict';

const { vscode, path, fs,
        log,
        getActiveRoot, getValidIdfPath, getGlobalCtx,
        checkBusy, warnNoProject,
        getGlobalBusyName,
        getPartitionPanel, setPartitionPanel,
        getPushSdkconfigUpdate, setPushSdkconfigUpdate,
        getSdkconfigValue, getPartitionCsvFilename,
        FLASH_SIZE_MAP,
} = require('./helpers');

const { runIdf } = require('./flash');

// ╔══════════════════════════════════════════════════════════════════╗
// ║  HELPERS: CMake path resolution                                    ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Resolve a CMake-style bin path to an absolute filesystem path.
 * Handles ${CMAKE_CURRENT_SOURCE_DIR}/ prefix and plain relative paths.
 *
 * @param {string} binPath  Path from CMakeLists.txt (may contain ${CMAKE_CURRENT_SOURCE_DIR})
 * @param {string} root     Project root directory (CMAKE_CURRENT_SOURCE_DIR value)
 * @returns {string} Absolute filesystem path
 */
function _resolveCmakeBinPath(binPath, root) {
    if (!binPath) return '';
    // Replace ${CMAKE_CURRENT_SOURCE_DIR} with project root
    let resolved = binPath.replace(/\$\{CMAKE_CURRENT_SOURCE_DIR\}/g, root.replace(/\\/g, '/'));
    // Replace $(CMAKE_CURRENT_SOURCE_DIR) variant
    resolved = resolved.replace(/\$\(CMAKE_CURRENT_SOURCE_DIR\)/g, root.replace(/\\/g, '/'));
    // If it's already an absolute path, return as-is (normalize separators)
    if (path.isAbsolute(resolved)) {
        return path.normalize(resolved);
    }
    // Relative path: resolve from project root
    return path.resolve(root, resolved);
}

/**
 * Convert an absolute filesystem path to a CMake-style path relative to project root.
 * Uses ${CMAKE_CURRENT_SOURCE_DIR} prefix for cross-platform compatibility.
 *
 * @param {string} absPath   Absolute filesystem path to the bin file
 * @param {string} root      Project root directory
 * @returns {string} CMake-style path, e.g. "${CMAKE_CURRENT_SOURCE_DIR}/data.bin"
 */
function _toCmakeBinPath(absPath, root) {
    const normalizedAbs = path.resolve(absPath).replace(/\\/g, '/');
    const normalizedRoot = path.resolve(root).replace(/\\/g, '/');
    if (normalizedAbs.startsWith(normalizedRoot + '/')) {
        const relPath = normalizedAbs.substring(normalizedRoot.length + 1);
        return '${CMAKE_CURRENT_SOURCE_DIR}/' + relPath;
    }
    // Fallback: if somehow not under root, just use the absolute path
    // (this shouldn't happen after copy-to-project logic)
    return normalizedAbs;
}

/**
 * Check if a file path is inside the project root directory.
 *
 * @param {string} absPath   Absolute filesystem path
 * @param {string} root      Project root directory
 * @returns {boolean} True if the file is inside the project root
 */
function _isInProjectDir(absPath, root) {
    const normalizedAbs = path.resolve(absPath).replace(/\\/g, '/');
    const normalizedRoot = path.resolve(root).replace(/\\/g, '/');
    return normalizedAbs.startsWith(normalizedRoot + '/');
}

/**
 * Copy a bin file to the project root directory if it's not already there.
 * Handles name collisions by adding a numeric suffix.
 *
 * @param {string} srcPath   Source file path (absolute)
 * @param {string} root      Project root directory
 * @returns {{ cmakePath: string, actualPath: string, copied: boolean }}
 *   cmakePath: CMake-style path for CMakeLists.txt
 *   actualPath: Absolute path where the file now lives
 *   copied: Whether the file was copied (vs already in project)
 */
async function _copyBinToProject(srcPath, root) {
    // If already in project, just return the CMake path
    if (_isInProjectDir(srcPath, root)) {
        return {
            cmakePath: _toCmakeBinPath(srcPath, root),
            actualPath: srcPath,
            copied: false,
        };
    }

    const baseName = path.basename(srcPath);
    let destName = baseName;
    let destPath = path.join(root, destName);

    // Check for name collision — ask user what to do
    if (fs.existsSync(destPath)) {
        // Check if it's the same file (same size + same content hash would be ideal, but same size is a good quick check)
        const srcSize = fs.statSync(srcPath).size;
        const destSize = fs.statSync(destPath).size;
        if (srcSize === destSize) {
            // Could be the same file — ask user
            const choice = await vscode.window.showWarningMessage(
                `ESP: File "${baseName}" already exists in the project root. Overwrite it?`,
                'Overwrite', 'Keep existing', 'Cancel'
            );
            if (choice === 'Keep existing') {
                // Use the existing file
                return {
                    cmakePath: _toCmakeBinPath(destPath, root),
                    actualPath: destPath,
                    copied: false,
                };
            }
            if (choice !== 'Overwrite') {
                return null; // Cancelled
            }
        } else {
            // Different file with same name — auto-rename with suffix
            let suffix = 1;
            const ext = path.extname(baseName);
            const nameNoExt = path.basename(baseName, ext);
            while (fs.existsSync(path.join(root, nameNoExt + '_' + suffix + ext))) {
                suffix++;
            }
            destName = nameNoExt + '_' + suffix + ext;
            destPath = path.join(root, destName);
            vscode.window.showInformationMessage(
                `ESP: Renamed "${baseName}" → "${destName}" to avoid conflict.`
            );
        }
    }

    // Copy the file
    try {
        fs.copyFileSync(srcPath, destPath);
        log(`[partition] copied bin: ${srcPath} → ${destPath}`);
    } catch (e) {
        vscode.window.showErrorMessage(`ESP: Failed to copy "${baseName}" to project: ${e.message}`);
        return null;
    }

    return {
        cmakePath: _toCmakeBinPath(destPath, root),
        actualPath: destPath,
        copied: true,
    };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  PARTITION TABLE EDITOR: Webview                                   ║
// ╚══════════════════════════════════════════════════════════════════╝
function cmdPartitionEditor() {
    if (checkBusy()) return;
    const root = getActiveRoot();
    if (!root) { warnNoProject(); return; }

    if (getPartitionPanel()) {
        getPartitionPanel().reveal(vscode.ViewColumn.One);
        return;
    }

    // Detect partition table mode
    const isSingleApp  = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_SINGLE_APP') === 'y';
    const isTwoOta     = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_TWO_OTA') === 'y';
    const isCustom     = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_CUSTOM') === 'y';
    const isBuiltIn    = (isSingleApp || isTwoOta) && !isCustom;

    // For built-in tables, the CSV lives in the SDK; for custom, in the project root
    const csvFilename = getPartitionCsvFilename(root);
    let csvPath = path.join(root, csvFilename);

    const panel = vscode.window.createWebviewPanel(
        'espPartitionEditor',
        'ESP Partition Editor',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    // Try to read CSV: first from project, then from SDK built-in
    let existingCsv = '';
    if (fs.existsSync(csvPath)) {
        try { existingCsv = fs.readFileSync(csvPath, 'utf8'); } catch {}
    }
    if (!existingCsv && isBuiltIn) {
        // Try SDK built-in partition table
        const idfPath = getValidIdfPath();
        if (idfPath) {
            const sdkCsv = path.join(idfPath, 'components', 'partition_table', csvFilename);
            if (fs.existsSync(sdkCsv)) {
                try { existingCsv = fs.readFileSync(sdkCsv, 'utf8'); } catch {}
            }
        }
    }
    // Also resolve $(IDF_PATH) in filename if needed
    if (!existingCsv && csvFilename.includes('$')) {
        const idfPath = getValidIdfPath();
        if (idfPath) {
            const expanded = csvFilename.replace(/\$\(IDF_PATH\)/g, idfPath.replace(/\\/g, '/')).replace(/\$\{IDF_PATH\}/g, idfPath.replace(/\\/g, '/'));
            if (path.isAbsolute(expanded) && fs.existsSync(expanded)) {
                try { existingCsv = fs.readFileSync(expanded, 'utf8'); } catch {}
            }
        }
    }

    // Determine save filename: for built-in tables, use CUSTOM filename
    const customFilename = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME') || 'partitions.csv';
    const saveFilename = isBuiltIn ? customFilename : csvFilename;

    // Determine mode label for the UI
    let modeLabel, modeHint;
    if (isSingleApp) {
        modeLabel = 'Single factory app (built-in)';
        modeHint = 'Saving will switch to Custom partition table mode and create "' + saveFilename + '" in your project.';
    } else if (isTwoOta) {
        modeLabel = 'Factory + Two OTA (built-in)';
        modeHint = 'Saving will switch to Custom partition table mode and create "' + saveFilename + '" in your project.';
    } else {
        modeLabel = 'Custom partition table';
        modeHint = '';
    }

    const rawPtOffset  = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_OFFSET') || '0x8000';
    const rawFlashSize = getSdkconfigValue(root, 'CONFIG_ESPTOOLPY_FLASHSIZE') || null;
    const ptOffsetVal  = rawPtOffset;
    const flashSizeVal = (rawFlashSize && FLASH_SIZE_MAP[rawFlashSize]) ? FLASH_SIZE_MAP[rawFlashSize] : '1048576';

    let _restoredLinks = [];
    const _cmakePath = path.join(root, 'CMakeLists.txt');
    if (fs.existsSync(_cmakePath)) {
        try {
            const _cmakeContent = fs.readFileSync(_cmakePath, 'utf8').replace(/\r\n/g, '\n');
            const _blockMatch = _cmakeContent.match(/# ESP8266 Tools: partition bin links -- BEGIN([\s\S]*?)# ESP8266 Tools: partition bin links -- END/);
            if (_blockMatch) {
                const _csvLines = existingCsv.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
                const _nameToIdx = {};
                _csvLines.forEach((l, i) => { const p = l.split(',')[0]?.trim(); if (p) _nameToIdx[p] = i; });
                const _linkRe = /esptool_py_flash_project_args\s*\(\s*(\S+)\s+\S+\s+"([^"]+)"/g;
                let _m;
                while ((_m = _linkRe.exec(_blockMatch[1])) !== null) {
                    const _name = _m[1], _rawPath = _m[2];
                    // Migrate old absolute paths to CMake-style ${CMAKE_CURRENT_SOURCE_DIR}/ paths
                    let _binPath = _rawPath;
                    if (_rawPath && !_rawPath.includes('${CMAKE_CURRENT_SOURCE_DIR}') && !_rawPath.includes('$(CMAKE_CURRENT_SOURCE_DIR)')) {
                        // Check if it's an absolute path pointing to a file inside the project
                        if (path.isAbsolute(_rawPath) && _isInProjectDir(_rawPath, root)) {
                            _binPath = _toCmakeBinPath(_rawPath, root);
                            log(`[partition] migrated bin path: ${_rawPath} → ${_binPath}`);
                        }
                        // If absolute but outside project, keep as-is (user may need to re-link)
                    }
                    if (_name in _nameToIdx) _restoredLinks[_nameToIdx[_name]] = _binPath;
                }
            }
        } catch {}
    }

    panel.webview.html = getPartitionEditorHtml(existingCsv, saveFilename, ptOffsetVal, flashSizeVal, _restoredLinks, modeLabel, modeHint, isBuiltIn);

    if (_restoredLinks.length > 0) {
        const BLOCK_OPEN = 4096;
        const _csvLinesOpen = existingCsv.replace(/\r\n/g, '\n').split('\n')
            .filter(l => l.trim() && !l.trim().startsWith('#'));
        const _sizeUpdates = [];
        _restoredLinks.forEach((binPath, i) => {
            if (!binPath) return;
            try {
                // Resolve CMake path to absolute for file operations
                const absPath = _resolveCmakeBinPath(binPath, root);
                const fileSize   = fs.statSync(absPath).size;
                const newSize    = Math.ceil(fileSize / BLOCK_OPEN) * BLOCK_OPEN;
                const parts      = (_csvLinesOpen[i] || '').split(',').map(s => s.trim());
                const currentSz  = parseInt(parts[3] || '0', 16) || parseInt(parts[3] || '0');
                if (newSize !== currentSz && newSize > 0) {
                    _sizeUpdates.push({ index: i, fileSize, newSize });
                    log(`[partitions] open: updated size for index ${i}: ${currentSz} → ${newSize}`);
                }
            } catch { }
        });
        if (_sizeUpdates.length > 0) {
            setTimeout(() => {
                panel.webview.postMessage({ command: 'applySizeUpdatesOnOpen', updates: _sizeUpdates });
            }, 300);
        }
    }

    let _lastSavedLinks = _restoredLinks.length ? JSON.parse(JSON.stringify(_restoredLinks)) : null;

    function patchCMakeWithLinks(binLinks, partitionsCsv) {
        const cmakePath = path.join(root, 'CMakeLists.txt');
        if (!fs.existsSync(cmakePath)) return;
        try {
            let cmake = fs.readFileSync(cmakePath, 'utf8');
            cmake = cmake.replace(/\n?# ESP8266 Tools: partition bin links -- BEGIN[\s\S]*?# ESP8266 Tools: partition bin links -- END\n?/g, '');
            const links = (binLinks || []).map((binPath, i) => binPath ? { binPath, i } : null).filter(Boolean);
            if (links.length > 0) {
                const csvLines = (partitionsCsv || '').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
                const entries = links.map(({ binPath, i }) => {
                    const parts = (csvLines[i] || '').split(',').map(s => s.trim());
                    const name   = parts[0] || ('part' + i);
                    const offset = parts[3] || '0x0';
                    // Ensure path uses forward slashes (CMake convention)
                    const cmakeSafePath = binPath.replace(/\\/g, '/');
                    return '    esptool_py_flash_project_args(' + name + ' ' + offset + ' "' + cmakeSafePath + '" FLASH_IN_PROJECT)';
                }).filter(Boolean);
                if (entries.length > 0) {
                    cmake += '\n# ESP8266 Tools: partition bin links -- BEGIN\nif(CONFIG_PARTITION_TABLE_CUSTOM)\n' + entries.join('\n') + '\nendif()\n# ESP8266 Tools: partition bin links -- END\n';
                }
            }
            fs.writeFileSync(cmakePath, cmake, 'utf8');
        } catch (e) {
            vscode.window.showErrorMessage(`ESP: Failed to patch CMakeLists.txt: ${e.message}`);
        }
    }

    // Helper: switch sdkconfig from built-in to Custom mode
    function switchToCustomMode(saveFilename) {
        const sdkconfigPath = path.join(root, 'sdkconfig');
        if (!fs.existsSync(sdkconfigPath)) return;
        let content = fs.readFileSync(sdkconfigPath, 'utf8');
        // Disable built-in modes
        content = content.replace(/^CONFIG_PARTITION_TABLE_SINGLE_APP=y$/m, '# CONFIG_PARTITION_TABLE_SINGLE_APP is not set');
        content = content.replace(/^CONFIG_PARTITION_TABLE_TWO_OTA=y$/m, '# CONFIG_PARTITION_TABLE_TWO_OTA is not set');
        // Enable custom mode
        content = content.replace(/^# CONFIG_PARTITION_TABLE_CUSTOM is not set$/m, 'CONFIG_PARTITION_TABLE_CUSTOM=y');
        if (!content.includes('CONFIG_PARTITION_TABLE_CUSTOM=y') && !content.includes('CONFIG_PARTITION_TABLE_CUSTOM=')) {
            content += '\nCONFIG_PARTITION_TABLE_CUSTOM=y\n';
        }
        // Update filenames
        content = content.replace(/^CONFIG_PARTITION_TABLE_FILENAME=".*"$/m, `CONFIG_PARTITION_TABLE_FILENAME="${saveFilename}"`);
        if (content.includes('CONFIG_PARTITION_TABLE_CUSTOM_FILENAME=')) {
            content = content.replace(/^CONFIG_PARTITION_TABLE_CUSTOM_FILENAME=".*"$/m, `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="${saveFilename}"`);
        } else {
            content += `\nCONFIG_PARTITION_TABLE_CUSTOM_FILENAME="${saveFilename}"\n`;
        }
        fs.writeFileSync(sdkconfigPath, content, 'utf8');
        log(`[partition] switched sdkconfig to Custom mode, save file: ${saveFilename}`);
    }

    // Helper: resolve current save path (checks current sdkconfig state at save time)
    function resolveSavePath() {
        const nowIsCustom = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_CUSTOM') === 'y';
        const nowIsBuiltIn = !nowIsCustom;
        const nowCsvFilename = getPartitionCsvFilename(root);
        const nowCustomFilename = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME') || 'partitions.csv';
        const nowSaveFilename = nowIsBuiltIn ? nowCustomFilename : nowCsvFilename;
        return { filename: nowSaveFilename, filePath: path.join(root, nowSaveFilename), isBuiltIn: nowIsBuiltIn };
    }

    // Helper: perform save with optional Custom mode switch
    async function performSave(csv, binLinksArr) {
        const saveInfo = resolveSavePath();
        fs.writeFileSync(saveInfo.filePath, csv, 'utf8');
        const linksChanged = JSON.stringify(binLinksArr) !== JSON.stringify(_lastSavedLinks);
        patchCMakeWithLinks(binLinksArr, csv);
        _lastSavedLinks = JSON.parse(JSON.stringify(binLinksArr || []));
        if (saveInfo.isBuiltIn) {
            switchToCustomMode(saveInfo.filename);
            vscode.window.showInformationMessage(`✅ Saved: ${saveInfo.filename} (switched to Custom partition table mode)`);
        } else {
            vscode.window.showInformationMessage(`✅ Saved: ${saveInfo.filename}`);
            if (linksChanged) await runIdf(['reconfigure'], 'ESP › Reconfigure', false).catch(() => {});
        }
    }

    let _panelIsDirty = false;

    panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'setDirty') { _panelIsDirty = msg.dirty; return; }

        if (msg.command === 'linkBin') {
            try {
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                    filters: { 'Binary files': ['bin'], 'All files': ['*'] },
                    title: 'Link .bin file to partition', openLabel: 'Link',
                });
                if (!uris || !uris[0]) return;
                const rawBinPath = uris[0].fsPath;

                // ── NEW LOGIC: Ensure bin file is in the project directory ──
                const copyResult = await _copyBinToProject(rawBinPath, root);
                if (!copyResult) return; // User cancelled or error

                const binPath = copyResult.cmakePath;  // CMake-style path for storage
                const absPath = copyResult.actualPath;  // Absolute path for file ops

                if (copyResult.copied) {
                    vscode.window.showInformationMessage(
                        `✅ Copied "${path.basename(rawBinPath)}" to project root.`
                    );
                }

                let fileSize = 0;
                try { fileSize = fs.statSync(absPath).size; } catch { }

                const BLOCK = 4096;
                const requiredSize = Math.ceil(fileSize / BLOCK) * BLOCK;

                const idx        = msg.index;
                const parts      = msg.partitions || [];
                const flashSize  = msg.flashSize  || 1048576;

                const parseHex = s => {
                    if (!s) return NaN;
                    s = String(s).trim().replace(/_/g, '');
                    if (/^0[xX]/.test(s)) return parseInt(s, 16);
                    const m = s.match(/^(\d+(?:\.\d+)?)\s*([KkMm]?)$/);
                    if (!m) return NaN;
                    const n = parseFloat(m[1]);
                    return Math.floor(m[2].toUpperCase() === 'K' ? n*1024 : m[2].toUpperCase() === 'M' ? n*1048576 : n);
                };

                const thisOffset = parseHex(parts[idx]?.offset);

                let nextStart = flashSize;
                parts.forEach((p, j) => {
                    if (j === idx) return;
                    const off = parseHex(p.offset);
                    if (!isNaN(off) && off > thisOffset) nextStart = Math.min(nextStart, off);
                });

                const freeBytes = isNaN(thisOffset) ? flashSize : nextStart - thisOffset;

                if (requiredSize > freeBytes) {
                    vscode.window.showErrorMessage(
                        `ESP: File "${path.basename(absPath)}" requires ${(requiredSize/1024).toFixed(1)} KB ` +
                        `but only ${(freeBytes/1024).toFixed(1)} KB is available for this partition. Operation cancelled.`
                    );
                    return;
                }

                // Send CMake-style path to webview (not the absolute path)
                panel.webview.postMessage({ command: 'setBinLink', index: idx, binPath, fileSize, newSize: requiredSize });
            } catch (e) {
                vscode.window.showErrorMessage(`ESP: Link bin failed: ${e.message}`);
            }
        }

        if (msg.command === 'save') {
            const BLOCK_SAVE = 4096;
            const flashBytesStr = getSdkconfigValue(root, 'CONFIG_ESPTOOLPY_FLASHSIZE') || '2MB';
            const flashBytesMap = { '512KB':524288,'1MB':1048576,'2MB':2097152,'4MB':4194304,'8MB':8388608,'16MB':16777216,
                                    '512K':524288,'1M':1048576,'2M':2097152,'4M':4194304,'8M':8388608,'16M':16777216 };
            const flashTotal = flashBytesMap[flashBytesStr] || 2097152;
            const csvPartitions = (msg.csv || '').split('\n')
                .filter(l => l.trim() && !l.trim().startsWith('#'))
                .map(l => { const p = l.split(',').map(s => s.trim()); const off = (p[3] && (p[3].startsWith('0x') || p[3].startsWith('0X'))) ? parseInt(p[3], 16) : parseInt(p[3], 10); return { name: p[0], offset: off || 0 }; });
            const sizeErrors = (msg.binLinks || []).map((binPath, i) => {
                if (!binPath) return null;
                try {
                    // Resolve CMake path to absolute for file size check
                    const absPath = _resolveCmakeBinPath(binPath, root);
                    const fileSize  = fs.statSync(absPath).size;
                    const required  = Math.ceil(fileSize / BLOCK_SAVE) * BLOCK_SAVE;
                    const part      = csvPartitions[i];
                    if (!part) return null;
                    const nextStart = csvPartitions
                        .filter((p, j) => j !== i && p.offset > part.offset)
                        .reduce((min, p) => Math.min(min, p.offset), flashTotal);
                    const freeArea  = nextStart - part.offset;
                    if (required > freeArea) {
                        return `"${path.basename(absPath)}" (${(required/1024).toFixed(0)} KB) exceeds free area of "${part.name}" (${(freeArea/1024).toFixed(0)} KB)`;
                    }
                } catch { return null; }
                return null;
            }).filter(Boolean);
            if (sizeErrors.length > 0) {
                vscode.window.showErrorMessage(
                    `ESP: Bin file too large — ${sizeErrors.join('; ')}. Resize the partition first.`
                );
                return;
            }
            try {
                await performSave(msg.csv, msg.binLinks);
            } catch (e) {
                vscode.window.showErrorMessage(`ESP: Failed to save CSV: ${e.message}`);
            }
        }
        if (msg.command === 'saveWithErrors') {
            const choice = await vscode.window.showWarningMessage(
                `ESP: Partition table has validation errors. Save anyway?`,
                'Save', 'Cancel'
            );
            if (choice === 'Save') {
                try {
                    await performSave(msg.csv, msg.binLinks);
                } catch (e) {
                    vscode.window.showErrorMessage(`ESP: Failed to save CSV: ${e.message}`);
                }
            }
        }
        if (msg.command === 'open') {
            const saveInfo = resolveSavePath();
            if (!fs.existsSync(saveInfo.filePath)) {
                vscode.window.showWarningMessage(`CSV file not found: ${saveInfo.filename}. Save first.`);
                return;
            }
            vscode.workspace.openTextDocument(saveInfo.filePath).then(doc =>
                vscode.window.showTextDocument(doc, vscode.ViewColumn.Two)
            );
        }
        if (msg.command === 'refresh') { pushSdkconfigUpdate(); }

        if (msg.command === 'binSizeWarnings') {
            vscode.window.showInformationMessage(
                `ESP Partitions: ${msg.warnings.join(' | ')}`
            );
            return;
        }
    });

    function pushSdkconfigUpdate() {
        const newPtOffset  = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_OFFSET') || '0x8000';
        const newFlashRaw  = getSdkconfigValue(root, 'CONFIG_ESPTOOLPY_FLASHSIZE') || null;
        const newFlashSize = (newFlashRaw && FLASH_SIZE_MAP[newFlashRaw]) ? FLASH_SIZE_MAP[newFlashRaw] : '1048576';
        const newCsvFilename = getPartitionCsvFilename(root);

        const BLOCK = 4096;
        const binSizeUpdates = (_lastSavedLinks || []).map((binPath, i) => {
            if (!binPath) return null;
            try {
                const absPath = _resolveCmakeBinPath(binPath, root);
                const fileSize = fs.statSync(absPath).size;
                const newSize  = Math.ceil(fileSize / BLOCK) * BLOCK;
                return { index: i, fileSize, newSize };
            } catch {
                return { index: i, fileSize: 0, newSize: 0, missing: true };
            }
        }).filter(Boolean);

        panel.webview.postMessage({
            command: 'sdkconfigUpdate',
            ptOffset: newPtOffset,
            flashSize: newFlashSize,
            csvFilename: newCsvFilename,
            binSizeUpdates
        });
    }

    setPartitionPanel(panel);
    setPushSdkconfigUpdate(pushSdkconfigUpdate);

    panel.onDidChangeViewState(e => {
        if (e.webviewPanel.visible) {
            pushSdkconfigUpdate();
            if (getGlobalBusyName()) {
                panel.webview.postMessage({ command: 'setBusy', busy: true, task: getGlobalBusyName() });
            }
        }
    });
    panel.onDidDispose(() => {
        if (_panelIsDirty) {
            vscode.window.showWarningMessage(
                'ESP Partition Editor was closed with unsaved changes.'
            );
        }
        setPartitionPanel(null);
        setPushSdkconfigUpdate(null);
    }, null, []);
}

function getPartitionEditorHtml(existingCsv, csvFilename, ptOffsetVal, flashSizeVal, restoredLinks = [], modeLabel, modeHint, isBuiltIn) {
    const existingData       = JSON.stringify(parseCsvToPartitions(existingCsv));
    const restoredLinksData  = JSON.stringify(restoredLinks || []);
    const safePtOffset  = String(ptOffsetVal  || '0x8000').replace(/[^0-9xa-fA-F]/g,'');
    const safeFlashSize = String(flashSizeVal || '1048576').replace(/[^0-9]/g,'');
    const safeFilename = (csvFilename || 'partitions.csv').replace(/[<>"'&]/g, '');
    const safeModeLabel = (modeLabel || '').replace(/[<>"'&]/g, '');
    const safeModeHint = (modeHint || '').replace(/[<>"'&]/g, '');
    const flashSizeLabels = {'524288':'512 KB','1048576':'1 MB','2097152':'2 MB','4194304':'4 MB','8388608':'8 MB','16777216':'16 MB'};
    const flashSizeLabel = flashSizeLabels[safeFlashSize] || (safeFlashSize + ' B');

    // Read the HTML template from media/partition-editor.html
    const templatePath = path.join(getGlobalCtx().extensionPath, 'media', 'partition-editor.html');
    let html;
    if (fs.existsSync(templatePath)) {
        html = fs.readFileSync(templatePath, 'utf8');
    } else {
        html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><h2>Partition Editor template not found</h2><p>Please reinstall the extension.</p></body></html>';
    }

    // Replace placeholders with dynamic values
    html = html.replace('{{SAFE_FILENAME}}', safeFilename);
    html = html.replace('{{SAFE_PT_OFFSET}}', safePtOffset);
    html = html.replace('{{SAFE_FLASH_SIZE}}', safeFlashSize);
    html = html.replace('{{FLASH_SIZE_LABEL}}', flashSizeLabel);
    html = html.replace('{{EXISTING_DATA}}', existingData);
    html = html.replace('{{RESTORED_LINKS_DATA}}', restoredLinksData);
    html = html.replace('{{MODE_LABEL}}', safeModeLabel);
    html = html.replace('{{MODE_HINT}}', safeModeHint);
    html = html.replace('{{IS_BUILTIN}}', isBuiltIn ? '1' : '0');

    return html;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  PARTITION TABLE EDITOR: CSV Parser                                ║
// ╚══════════════════════════════════════════════════════════════════╝

// Normalize numeric type/subtype to named equivalents used by the editor
function _normalizeType(rawType) {
    if (!rawType) return 'data';
    const t = rawType.trim().toLowerCase();
    if (t === 'app' || t === 'data') return t;
    // Numeric type: 0 = app, 1 = data
    const num = parseInt(t, 0);
    if (!isNaN(num)) return num === 0 ? 'app' : num === 1 ? 'data' : rawType.trim();
    return rawType.trim();
}

function _normalizeSubtype(rawSubtype, normalizedType) {
    if (!rawSubtype) return 'nvs';
    const s = rawSubtype.trim().toLowerCase();
    // Named subtypes — return as-is (with special mappings)
    if (s === 'spiffs') return 'spiffs/littlefs';
    if (s === 'fat') return 'fatfs';
    if (s === 'factory' || s === 'ota_0' || s === 'ota_1' || s === 'ota' || s === 'nvs' || s === 'phy' || s === 'fatfs' || s === 'test') return s;
    // Numeric subtype for app type
    if (normalizedType === 'app') {
        const num = parseInt(s, 0);
        if (!isNaN(num)) {
            if (num === 0x00) return 'factory';
            if (num === 0x10) return 'ota_0';
            if (num === 0x11) return 'ota_1';
            if (num === 0x20) return 'test';
            return rawSubtype.trim(); // keep numeric for unknown app subtypes
        }
    }
    // Numeric subtype for data type
    if (normalizedType === 'data') {
        const num = parseInt(s, 0);
        if (!isNaN(num)) {
            if (num === 0x01) return 'ota';
            if (num === 0x02) return 'nvs';
            if (num === 0x04) return 'phy';
            if (num === 0x81) return 'fatfs';
            if (num === 0x82) return 'spiffs/littlefs';
            return rawSubtype.trim();
        }
    }
    return rawSubtype.trim();
}

function parseCsvToPartitions(csv) {
    if (!csv) return [];
    const partitions = [];
    const lines = csv.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split(',').map(s => s.trim());
        if (parts.length < 5) continue;
        const type = _normalizeType(parts[1]);
        partitions.push({
            name:      parts[0] || '',
            type:      type,
            subtype:   _normalizeSubtype(parts[2], type),
            offset:    parts[3] || '0x0',
            size:      parts[4] || '0x1000',
        });
    }
    return partitions;
}

module.exports = {
    cmdPartitionEditor, parseCsvToPartitions,
};
