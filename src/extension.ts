'use strict';

import * as vscode from 'vscode'
import * as fs from 'mz/fs'
import * as path from 'path'

import {CsprojAndFile, Csproj, ActionArgs, ItemType} from './types'
import * as CsprojUtil from './csproj'
import * as StatusBar from './statusbar'

const debounce = require('lodash.debounce')

const _debounceDeleteTime = 2000

let _csprojRemovals: CsprojAndFile[] = []

const [YES, NO, NEVER] = ['Yes', 'Not Now', 'Never For This File']

export function activate(context: vscode.ExtensionContext) {
    const config = getConfig()
    if (!config.get<boolean>('enabled', true))
        return

    console.log('extension.csproj#activate')

    const csprojWatcher = vscode.workspace.createFileSystemWatcher('**/*.csproj')
    const deleteFileWatcher = vscode.workspace.createFileSystemWatcher('**/*', true, true, false)

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.csproj.add',
            csprojCommand.bind(context)),
        vscode.commands.registerCommand('extension.csproj.remove',
            csprojRemoveCommand.bind(context)),
        vscode.commands.registerCommand('extension.csproj.clearIgnoredPaths',
            clearIgnoredPathsCommand.bind(context)),

        vscode.workspace.onDidSaveTextDocument(async (e: vscode.TextDocument) => {
            if (ignoreEvent(context, e.uri)) return

            await vscode.commands.executeCommand('extension.csproj.add',
                e.uri, true)
        }),

        vscode.window.onDidChangeActiveTextEditor(async (e: vscode.TextEditor) => {
            if (!e) return

            StatusBar.hideStatusBarItem()

            if (ignoreEvent(context, e.document.uri)) return

            await vscode.commands.executeCommand('extension.csproj.add',
                e.document.uri, true)
        }),

        csprojWatcher.onDidChange(uri => {
            // Clear cache entry if file is modified
            CsprojUtil.invalidateCsproj(uri.fsPath)
        }),

        deleteFileWatcher.onDidDelete(handleFileDeletion),

        csprojWatcher, deleteFileWatcher,

        StatusBar.createStatusBarItem()
    )
}

export function deactivate() {
    console.log('extension.csproj#deactivate')
    CsprojUtil.invalidateAllCsproj()
    StatusBar.hideStatusBarItem()
}

function ignoreEvent(context: vscode.ExtensionContext, uri: vscode.Uri) {
    if (!isDesiredFile(context.globalState, uri.fsPath))
        return true

    if (StatusBar.visible())
        return true

    return false
}

function getConfig() {
    return vscode.workspace.getConfiguration("csproj")
}

async function csprojCommand(
    this: vscode.ExtensionContext,
    // Use file path from context or fall back to active document
    {fsPath}: vscode.Uri = vscode.window.activeTextEditor.document.uri,
    prompt = false
) {
    if (!fsPath) return
    const fileName = path.basename(fsPath)
    console.log(`extension.csproj#trigger(${fileName})`)

    // Skip if we're saving a csproj file, or we are a standalone file without a path.
    if (fsPath.endsWith('.csproj') || !/(\/|\\)/.test(fsPath))
        return

    try {
        const csproj = await CsprojUtil.getCsprojForFile(fsPath)

        if (CsprojUtil.csprojHasFile(csproj, fsPath)) {
            StatusBar.displayStatusBarItem(csproj.name, true)
            if (!prompt) {
                await vscode.window.showWarningMessage(`${fileName} is already in ${csproj.name}`)
            }
            return
        }

        let pickResult = (prompt === true)
            ? await vscode.window.showInformationMessage(
                `${fileName} is not in ${csproj.name}, would you like to add it?`,
                YES, NO, NEVER)
            : YES

        // Default to "No" action if user blurs the picker
        await (pickActions[pickResult] || pickActions[NO])({
            filePath: fsPath,
            fileName,
            csproj,
            globalState: this.globalState
        })

    } catch (err) {
        if (!(err instanceof CsprojUtil.NoCsprojError)) {
            await vscode.window.showErrorMessage(err.toString())
            console.trace(err)
        } else {
            console.log(`extension.csproj#trigger(${fileName}): no csproj found`)
        }
    }
}

const pickActions = {
    async [YES]({ filePath, fileName, csproj }: ActionArgs) {
        const config = vscode.workspace.getConfiguration("csproj")
        const itemType = config.get<ItemType>('itemType', {
            '*': 'Content',
            '.ts': 'TypeScriptCompile'
        })
        CsprojUtil.addFileToCsproj(csproj, filePath, getTypeForFile(fileName, itemType))
        await CsprojUtil.persistCsproj(csproj)

        StatusBar.displayStatusBarItem(csproj.name, true)
        await vscode.window.showInformationMessage(`Added ${fileName} to ${csproj.name}`)
    },
    [NO]({ csproj }: ActionArgs) {
        StatusBar.displayStatusBarItem(csproj.name, false)
    },
    async [NEVER]({ filePath, globalState, fileName }: ActionArgs) {
        await updateIgnoredPaths(globalState, filePath)

        StatusBar.hideStatusBarItem()
        await vscode.window.showInformationMessage(
            `Added ${fileName} to ignore list, to clear list, ` +
            `run the "csproj: Clear ignored paths"`)
    }
}

async function handleFileDeletion({fsPath}: vscode.Uri) {
    try {
        const csproj = await CsprojUtil.getCsprojForFile(fsPath)
        if (!CsprojUtil.csprojHasFile(csproj, fsPath))
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

        CsprojUtil.disableInvalidation()

        const message = removals.length > 1
            ? multiDeleteMessage(removals.map(rem => rem.filePath))
            : singleDeleteMessage(removals[0].csproj, removals[0].filePath)

        const doDelete = getConfig().get('silentDeletion', false)
            || await vscode.window.showWarningMessage(message, YES) === YES

        if (doDelete) {
            for (const {filePath, csproj} of removals) {
                await vscode.commands.executeCommand('extension.csproj.remove', {fsPath: filePath}, csproj)
            }
        }

        CsprojUtil.enableInvalidation()
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
    const config = vscode.workspace.getConfiguration("csproj")

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
    {fsPath}: vscode.Uri = vscode.window.activeTextEditor.document.uri,
    csproj?: Csproj
) {
    const csprojProvided = !!csproj
    if (!csproj) {
        try {
            csproj = await CsprojUtil.getCsprojForFile(fsPath)
        } catch (err) {
            if (err instanceof CsprojUtil.NoCsprojError) {
                const fileName = path.basename(fsPath)
                await vscode.window.showErrorMessage(`Unable to locate csproj for file: ${fileName}`)
            } else {
                console.trace(err)
            }
            return
        }
    }

    try {
        CsprojUtil.removeFileFromCsproj(csproj, fsPath)
        await CsprojUtil.persistCsproj(csproj)
    } catch (err) {
        await vscode.window.showErrorMessage(err.toString())
        console.trace(err)
    }
}
