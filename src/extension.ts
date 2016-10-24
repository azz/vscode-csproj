'use strict';

import * as vscode from 'vscode'
import * as fs from 'mz/fs'
import * as path from 'path'

import XMLParser, {XML, XMLElement} from './parser'

const etree = require('elementtree')
const stripBom = require('strip-bom')

let _cacheXml: { [path: string]: XML } = Object.create(null)
let _statusBarItem: vscode.StatusBarItem
let _statusBarItemVisible = false;

const [YES, NO, NEVER] = ['Yes', 'Not Now (Move to Status Bar)', 'Never For This File']

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration("csproj")
    if (!config.get<boolean>('enabled', true))
        return

    console.log('extension.csproj#activate')

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.csproj',
            csprojCommand.bind(context)),

        vscode.commands.registerCommand('extension.csproj_clearIgnoredPaths',
            clearIgnoredPathsCommand.bind(context)),

        vscode.workspace.onDidSaveTextDocument(async (e: vscode.TextDocument) => {
            if (ignoreEvent(context, e.uri)) return

            await vscode.commands.executeCommand('extension.csproj',
                e.uri, true)
        }),

        vscode.window.onDidChangeActiveTextEditor(async (e: vscode.TextEditor) => {
            if (!e) return

            hideStatusBarItem()

            if (ignoreEvent(context, e.document.uri)) return

            await vscode.commands.executeCommand('extension.csproj',
                e.document.uri, true)
        }),

        watcher.onDidChange((uri: vscode.Uri) => {
            // Clear cache entry if file is modified
            delete _cacheXml[uri.fsPath]
        }),

        watcher,

        _statusBarItem = createStatusBarItem()
    );
    _statusBarItemVisible = false
}

export function deactivate() {
    console.log('extension.csproj#deactivate');
    _cacheXml = Object.create(null)
    hideStatusBarItem()
}

function ignoreEvent(context: vscode.ExtensionContext, uri: vscode.Uri) {
    if (!isDesiredFile(context.globalState, uri.fsPath))
        return true

    if (_statusBarItemVisible)
        return true

    return false
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
        const csprojPath = await getCsprojPath(path.dirname(fsPath))
        const csprojName = path.basename(csprojPath)
        const filePathRel = path.relative(path.dirname(csprojPath), fsPath)

        if (!(csprojPath in _cacheXml)) {
            const csprojContent = await readFile(csprojPath)
            _cacheXml[csprojPath] = <XML>etree.parse(csprojContent, new XMLParser)
        }

        if (csprojHasFile(_cacheXml[csprojPath], filePathRel)) {
            displayStatusBarItem(csprojName, true)
            return
        }

        let pickResult = (prompt === true)
            ? await vscode.window.showQuickPick([YES, NO, NEVER], {
                placeHolder: `${fileName} is not in ${csprojName}, would you like to add it?`
              })
            : YES

        // Default to "No" action if user blurs the picker
        await (pickActions[pickResult] || pickActions[NO])({
            filePathRel,
            filePathAbs: fsPath,
            fileName,
            csprojName,
            csprojPath,
            csprojXml: _cacheXml[csprojPath],
            globalState: this.globalState
        })

    } catch (err) {
        if (!(err instanceof NoCsprojError))
            vscode.window.showErrorMessage(err.toString())
        console.trace(err)
    }
}

interface ActionArgs {
    filePathRel: string
    filePathAbs: string
    fileName: string
    csprojPath: string
    csprojXml: XML
    csprojName: string
    globalState: vscode.Memento
}

const pickActions = {
    async [YES]({ filePathRel, fileName, csprojPath, csprojXml, csprojName }: ActionArgs) {
        const config = vscode.workspace.getConfiguration("csproj")
        const itemType = config.get<string>('itemType', 'Content')
        addFileToCsproj(csprojXml, filePathRel, itemType)
        await writeXml(csprojXml, csprojPath)

        displayStatusBarItem(csprojName, true)
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

function displayStatusBarItem(csprojName: string, contained = false) {
    _statusBarItem.text = contained ? `Contained in ${csprojName}` : `Add to ${csprojName}`
    _statusBarItem.tooltip = _statusBarItem.text
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
    const match = project.find(`./ItemGroup/*[@Include='${filePathRel}']`)
    return !!match
}

function addFileToCsproj(xml: XML, filePathRel: string, itemType: string) {
    const itemGroups = xml.getroot().findall('./ItemGroup')
    const itemGroup = itemGroups.length
        ? itemGroups[itemGroups.length - 1]
        : etree.SubElement(xml.getroot(), 'ItemGroup')
    const itemElement = etree.SubElement(itemGroup, itemType)
    itemElement.set('Include', filePathRel)
}

async function readFile(path: string): Promise<string> {
    return stripBom(await fs.readFile(path, 'utf8'))
}

async function writeXml(xml: XML, path: string, indent = 2) {
    const xmlString = xml.write({ indent })
    // This should be replaced with a regex lookahead on (?=-->) and (?!<!--),
    // or fixed in elementtree.
    const xmlFinal = xmlString
        .replace(/&#xA;/g, '\n')
        .replace(/&#xD;/g, '\r')
    await fs.writeFile(path, xmlFinal)
}
