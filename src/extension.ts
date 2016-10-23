'use strict';

import * as vscode from 'vscode'
import * as fs from 'mz/fs'
import * as path from 'path'

const etree = require('elementtree')
const stripBom = require('strip-bom')

let _cacheXml: { [path: string]: XML } = Object.create(null)
let _cacheIndent: { [path: string]: number } = Object.create(null)
let _addedSinceActivate: string[] = []
let _statusBarItem: vscode.StatusBarItem
let _statusBarItemVisible = false;

const [YES, NO, NEVER] = ['Yes', 'Not Now (Move to Status Bar)', 'Never For This File']

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration("csproj")
    if (!config.get<boolean>('enabled', true))
        return

    console.log('extension.csproj#activate')

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.csproj',
            csprojCommand.bind(context)),

        vscode.commands.registerCommand('extension.csproj_clearIgnoredPaths',
            clearIgnoredPathsCommand.bind(context)),

        vscode.workspace.onDidSaveTextDocument(() => {
            if (ignoreEvent(context)) return

            vscode.commands.executeCommand('extension.csproj',
                undefined, true)
        }),

        vscode.window.onDidChangeActiveTextEditor(() => {
            hideStatusBarItem()
            if (ignoreEvent(context)) return

            vscode.commands.executeCommand('extension.csproj',
                undefined, true)
        }),

        _statusBarItem = createStatusBarItem()
    );
    _statusBarItemVisible = false
}

export function deactivate() {
    console.log('extension.csproj#deactivate');
    _addedSinceActivate = []
    _cacheXml = Object.create(null)
    _cacheIndent = Object.create(null)
    hideStatusBarItem()
}

function ignoreEvent(context: vscode.ExtensionContext) {
    const {fileName} = vscode.window.activeTextEditor.document;
    if (!isDesiredFile(context.globalState, fileName))
        return true

    if (_statusBarItemVisible)
        return true

    return false
}

async function csprojCommand(
    this: vscode.ExtensionContext,
    uri: vscode.Uri | undefined = undefined,
    prompt = false
) {
    // Use file path from context menu or fall back to active document
    const filePath = uri ? uri.fsPath : vscode.window.activeTextEditor.document.fileName
    const fileName = path.basename(filePath)
    console.log(`extension.csproj#trigger(${fileName})`)

    // Skip if we're saving a csproj file, or we are a standalone file without a path.
    if (filePath.endsWith('.csproj') || !/(\/|\\)/.test(filePath))
        return

    try {
        const csprojPath = await getCsprojPath(path.dirname(filePath))
        const csprojName = path.basename(csprojPath)
        const filePathRel = path.relative(path.dirname(csprojPath), filePath)

        if (!(csprojPath in _cacheXml) || !(csprojPath in _cacheIndent)) {
            const csprojContent = await readFile(csprojPath)
            _cacheXml[csprojPath] = <XML>etree.parse(csprojContent)
            _cacheIndent[csprojPath] = detectIndent(csprojContent)
        }

        if (_addedSinceActivate.indexOf(filePathRel) > -1
            || csprojHasFile(_cacheXml[csprojPath], filePathRel))
            return

        let pickResult = (prompt === true)
            ? await vscode.window.showQuickPick([YES, NO, NEVER], {
                placeHolder: `${fileName} is not in ${csprojName}, would you like to add it?`
              })
            : YES

        // Default to "No" action if user blurs the picker
        await (pickActions[pickResult] || pickActions[NO])({
            filePathRel,
            filePathAbs: filePath,
            fileName,
            csprojName,
            csprojPath,
            csprojXml: _cacheXml[csprojPath],
            indent: _cacheIndent[csprojPath],
            globalState: this.globalState
        })

    } catch (err) {
        if (!(err instanceof NoCsprojError))
            vscode.window.showErrorMessage(err.toString())
    }
}

interface ActionArgs {
    filePathRel: string
    filePathAbs: string
    fileName: string
    csprojPath: string
    csprojXml: XML
    csprojName: string
    indent: number
    globalState: vscode.Memento
}

const pickActions = {
    async [YES]({ filePathRel, fileName, csprojPath, csprojXml, indent }: ActionArgs) {
        const config = vscode.workspace.getConfiguration("csproj")
        const itemType = config.get<string>('itemType', 'Content')
        addFileToCsproj(csprojXml, filePathRel, itemType)
        _addedSinceActivate.push(filePathRel)
        await writeXml(csprojXml, csprojPath, indent)

        hideStatusBarItem()
        await vscode.window.showInformationMessage(`Added ${fileName} to ${csprojPath}`)
    },
    [NO]({ csprojName }: ActionArgs) {
        displayStatusBarItem(csprojName)
    },
    async [NEVER]({ filePathAbs, globalState, fileName }: ActionArgs) {
        await updateIgnoredPaths(globalState, filePathAbs)

        hideStatusBarItem()
        await vscode.window.showInformationMessage(
            `Added ${fileName} to ignore list, to clear list, ` +
            `run the "csproj: Clear ignored paths"`)
    }
}

function displayStatusBarItem(csprojName: string) {
    _statusBarItem.text = `Add to ${csprojName}`
    _statusBarItem.show()
    _statusBarItemVisible = true
}

function hideStatusBarItem() {
    _statusBarItem.text = ''
    _statusBarItem.hide()
    _statusBarItemVisible = false
}

function createStatusBarItem() {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
    item.tooltip = "Add to csproj"
    item.command = 'extension.csproj'
    return item
}

async function updateIgnoredPaths(globalState: vscode.Memento, addPath: string) {
    const list = globalState.get<string[]>('csproj.ignorePaths') || []
    list.push(addPath)
    await globalState.update('csproj.ignorePaths', list)
}

function isDesiredFile(globalState: vscode.Memento, queryPath: string) {
    const config = vscode.workspace.getConfiguration("csproj")

    const ignorePaths = globalState.get<string[]>('csproj.ignorePaths') || [];
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

class NoCsprojError extends Error {}

async function getCsprojPath(fileDir: string, walkUp = true): Promise<string> {
    if (!path.isAbsolute(fileDir))
        fileDir = path.resolve(fileDir)

    const files = await fs.readdir(fileDir)
    const csproj = files.find(file => file.endsWith('.csproj'))
    if (csproj)
        return path.resolve(fileDir, csproj)
    if (walkUp) {
        const parent = path.resolve(fileDir, '..')
        if (parent === fileDir)
            throw new NoCsprojError('Reached fs root, no csproj found')
        return getCsprojPath(parent)
    }
    throw new NoCsprojError(`No csproj found in current directory: ${fileDir}`)
}

function csprojHasFile(xml: XML, filePathRel: string) {
    const project = xml.getroot()
    const content = project.find(`./ItemGroup/Content[@Include='${filePathRel}']`)
    const tsc = project.find(`./ItemGroup/TypeScriptCompile[@Include='${filePathRel}']`)
    return !!content || !!tsc
}

async function addFileToCsproj(xml: XML, filePathRel: string, itemType: string) {
    const itemGroup = xml.getroot().find('./ItemGroup')
    const itemElement = etree.SubElement(itemGroup, itemType)
    itemElement.set('Include', filePathRel)
}

interface XMLElement {
    find(xpath: string): XMLElement
    findall(xpath: string): XMLElement[]
}

interface XML {
    getroot(): XMLElement
}

async function readFile(path: string): Promise<string> {
    return stripBom(await fs.readFile(path, 'utf8'))
}

function detectIndent(content: string, defaultIndent = 2): number {
    const firstIndentedLine = content.split('\n')[2]
    if (!firstIndentedLine.startsWith(' '))
        return defaultIndent
    return firstIndentedLine.replace(/[^ ].*/, '').length
}

async function writeXml(xml: XML, path: string, indent: number) {
    return await fs.writeFile(path, etree.tostring(xml.getroot(), { indent }))
}