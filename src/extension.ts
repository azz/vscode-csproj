'use strict';

import * as vscode from 'vscode'
import * as fs from 'mz/fs'
import * as path from 'path'

import {CsprojAndFile, Csproj, ActionArgs, ItemType} from './types'
import * as CsprojUtil from './csproj'
import * as StatusBar from './statusbar'

const {window, commands, workspace} = vscode
const debounce = require('lodash.debounce')

const [YES, NO, NEVER] = ['Yes', 'Not Now', 'Never For This File']
const _debounceDeleteTime = 2000

let _csprojRemovals: CsprojAndFile[] = []

export function activate(context: vscode.ExtensionContext) {
    const config = getConfig()
    if (!config.get<boolean>('enabled', true))
        return

    console.log('extension.csproj#activate')

    const csprojWatcher = workspace.createFileSystemWatcher('**/*.csproj')
    const deleteFileWatcher = workspace.createFileSystemWatcher('**/*', true, true, false)

    context.subscriptions.push(
        commands.registerCommand('extension.csproj.add',
            csprojCommand.bind(context)),
        commands.registerCommand('extension.csproj.remove',
            csprojRemoveCommand.bind(context)),
        commands.registerCommand('extension.csproj.clearIgnoredPaths',
            clearIgnoredPathsCommand.bind(context)),

        workspace.onDidSaveTextDocument(async (e: vscode.TextDocument) => {
            if (ignoreEvent(context, e.uri)) return

            await commands.executeCommand('extension.csproj.add',
                e.uri, true)
        }),

        window.onDidChangeActiveTextEditor(async (e: vscode.TextEditor) => {
            if (!e) return

            StatusBar.hideItem()
            if (ignoreEvent(context, e.document.uri)) return

            await commands.executeCommand('extension.csproj.add',
                e.document.uri, true)
        }),

        csprojWatcher.onDidChange(uri => {
            // Clear cache entry if file is modified
            CsprojUtil.invalidate(uri.fsPath)
        }),

        deleteFileWatcher.onDidDelete(handleFileDeletion),

        csprojWatcher, deleteFileWatcher,

        StatusBar.createItem()
    )
}

export function deactivate() {
    console.log('extension.csproj#deactivate')
    CsprojUtil.invalidateAll()
    StatusBar.hideItem()
}

function ignoreEvent(context: vscode.ExtensionContext, uri: vscode.Uri) {
    if (!isDesiredFile(context.globalState, uri.fsPath))
        return true

    if (StatusBar.isVisible())
        return true

    return false
}

function getConfig() {
    return workspace.getConfiguration("csproj")
}

async function csprojCommand(
    this: vscode.ExtensionContext,
    // Use file path from context or fall back to active document
    {fsPath}: vscode.Uri = window.activeTextEditor.document.uri,
    promptAction = false,
    bulkMode = false
): Promise<Csproj | void> {
    if (!fsPath) return

    // Skip if we're saving a csproj file, or we are a standalone file without a path.
    if (fsPath.endsWith('.csproj') || !/(\/|\\)/.test(fsPath))
        return

    if (fs.lstatSync(fsPath).isDirectory()) {
        return await csprojAddDirectory.call(this, fsPath)
    }

    const fileName = path.basename(fsPath)
    console.log(`extension.csproj#trigger(${fileName})`)

    try {
        const csproj = await CsprojUtil.forFile(fsPath)

        if (CsprojUtil.hasFile(csproj, fsPath)) {
            StatusBar.displayItem(csproj.name, true)
            if (!promptAction && !bulkMode) {
                window.showWarningMessage(`${fileName} is already in ${csproj.name}`)
            }
            console.log(`extension.csproj#trigger(${fileName}): already in csproj`)
            return
        }

        let pickResult = (promptAction === true)
            ? await window.showInformationMessage(
                `${fileName} is not in ${csproj.name}, would you like to add it?`,
                YES, NEVER)
            : YES

        // Default to "No" action if user blurs the picker
        const added = await (pickActions[pickResult] || pickActions[NO])({
            filePath: fsPath,
            fileName,
            bulkMode,
            csproj,
            globalState: this.globalState
        })

        if (added) return csproj

    } catch (err) {
        if (!(err instanceof CsprojUtil.NoCsprojError)) {
            window.showErrorMessage(err.toString())
            console.trace(err)
        } else {
            console.log(`extension.csproj#trigger(${fileName}): no csproj found`)
        }
    }
}

const pickActions = {
    async [YES]({ filePath, fileName, csproj, bulkMode }: ActionArgs) {
        const config = workspace.getConfiguration("csproj")
        const itemType = config.get<ItemType>('itemType', {
            '*': 'Content',
            '.cs': 'Compile',
            '.ts': 'TypeScriptCompile'
        })
        CsprojUtil.addFile(csproj, filePath, getTypeForFile(fileName, itemType))
        if (!bulkMode) {
            await CsprojUtil.persist(csproj)
            StatusBar.displayItem(csproj.name, true)
            // window.showInformationMessage(`Added ${fileName} to ${csproj.name}`)
        }

        return true
    },
    [NO]({ csproj }: ActionArgs) {
        StatusBar.displayItem(csproj.name, false)
    },
    async [NEVER]({ filePath, globalState, fileName }: ActionArgs) {
        await updateIgnoredPaths(globalState, filePath)

        StatusBar.hideItem()
        window.showInformationMessage(
            `Added ${fileName} to ignore list, to clear list, ` +
            `run the "csproj: Clear ignored paths"`)
    }
}

async function csprojAddDirectory(this: vscode.ExtensionContext, fsPath: string) {
    const changedCsprojs: Csproj[] = []

    const files = await workspace.findFiles(
        path.join(workspace.asRelativePath(fsPath), '**/*'),
        ''
    )
    for (const file of files.filter(file => isDesiredFile(this.globalState, file.fsPath))) {
        const csproj: Csproj = await csprojCommand.call(this, file, false, true)
        if (csproj) {
            if (!changedCsprojs.find(_csproj => _csproj.fsPath === csproj.fsPath))
                changedCsprojs.push(csproj)
        }
    }

    for (const csproj of changedCsprojs)
        CsprojUtil.persist(csproj)
}

// How do we actually tell if a directory or file was deleted?
function wasDirectory(fsPath: string) {
    return path.extname(fsPath) === ''
}

async function handleFileDeletion({fsPath}: vscode.Uri) {
    try {
        const csproj = await CsprojUtil.forFile(fsPath)
        if (!wasDirectory(fsPath) && !CsprojUtil.hasFile(csproj, fsPath))
            return

        _csprojRemovals.push({ csproj, filePath: fsPath })
        await debouncedRemoveFromCsproj(
            _csprojRemovals,
            () => { _csprojRemovals = [] }
        )
    } catch (err) {
        console.trace(err)
    }
}

const debouncedRemoveFromCsproj = debounce(
    async (removals: CsprojAndFile[], onCall: Function) => {
        onCall()

        const message = removals.length > 1
            ? multiDeleteMessage(removals.map(rem => rem.filePath))
            : singleDeleteMessage(removals[0].csproj, removals[0].filePath)

        if (getConfig().get('silentDeletion', false)
            || await window.showWarningMessage(message, YES) !== YES) {
            return
        }

        for (const {filePath, csproj} of removals) {
            await commands.executeCommand('extension.csproj.remove',
                {fsPath: filePath}, csproj, true)
        }
    },
    _debounceDeleteTime
)

function getTypeForFile(fileName: string, itemType: ItemType): string {
    const extension = path.extname(fileName)
    return typeof itemType === 'string'
        ? itemType
        : itemType[extension] || itemType['*'] || 'Content'
}

function isDesiredFile(globalState: vscode.Memento, queryPath: string) {
    const config = workspace.getConfiguration('csproj')

    const ignorePaths = globalState.get<string[]>('csproj.ignorePaths') || []
    if (ignorePaths.indexOf(queryPath) > -1)
        return false

    const includeRegex = config.get('includeRegex', '.*')
    const excludeRegex = config.get('excludeRegex', null)

    if (includeRegex != null && !new RegExp(includeRegex).test(queryPath))
        return false

    if (excludeRegex != null && new RegExp(excludeRegex).test(queryPath))
        return false

    return true
}

function clearIgnoredPathsCommand(this: vscode.ExtensionContext) {
    this.globalState.update('csproj.ignorePaths', [])
}

async function updateIgnoredPaths(globalState: vscode.Memento, addPath: string) {
    const list = globalState.get<string[]>('csproj.ignorePaths') || []
    list.push(addPath)
    await globalState.update('csproj.ignorePaths', list)
}

function singleDeleteMessage(csproj: Csproj, filePath: string) {
    const fileName = path.basename(filePath)
    return `${fileName} was deleted. Remove it from ${csproj.name}?`
}

function multiDeleteMessage(filePaths: string[]) {
    return `${filePaths.length} files were deleted. Remove them from csproj?`
}

async function csprojRemoveCommand(
    this: vscode.ExtensionContext,
    // Use file path from context or fall back to active document
    {fsPath}: vscode.Uri = window.activeTextEditor.document.uri,
    csproj?: Csproj,
    bulkMode = false
): Promise<Csproj | void> {
    const wasDir = wasDirectory(fsPath)
    const fileName = path.basename(fsPath)
    console.log(`extension.csproj#remove(${fileName})`)

    const csprojProvided = !!csproj
    if (csproj) {
        csproj = CsprojUtil.ensureValid(csproj)
    } else {
        csproj = await getCsprojForFile(fsPath)
    }

    if (!csproj) return

    try {
        const removed = CsprojUtil.removeFile(csproj, fsPath, wasDir)
        await CsprojUtil.persist(csproj)
        if (!removed && !bulkMode) {
            window.showWarningMessage(`${fileName} was not found in ${csproj.name}`)
        }
    } catch (err) {
        window.showErrorMessage(err.toString())
        console.trace(err)
    }
}

async function getCsprojForFile(fsPath: string) {
    try {
        return await CsprojUtil.forFile(fsPath)
    } catch (err) {
        if (err instanceof CsprojUtil.NoCsprojError) {
            const fileName = path.basename(fsPath)
            await window.showErrorMessage(`Unable to locate csproj for file: ${fileName}`)
        } else {
            console.trace(err)
        }
        return
    }
}