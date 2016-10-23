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
    const config = vscode.workspace.getConfiguration("addToCsproj")
    if (!config.get<boolean>('enabled'))
        return

    console.log('extension.addToCsproj#activate')

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.addToCsproj',
            addToCsprojCommand.bind(context)),

        vscode.commands.registerCommand('extension.addToCsproj_clearIgnoredPaths',
            clearIgnoredPathsCommand.bind(context)),

        vscode.workspace.onDidSaveTextDocument(() => {
            if (ignoreEvent(context)) return

            vscode.commands.executeCommand('extension.addToCsproj', true)
        }),

        vscode.window.onDidChangeActiveTextEditor(() => {
            hideStatusBarItem()
            if (ignoreEvent(context)) return

            vscode.commands.executeCommand('extension.addToCsproj', true)
        }),

        _statusBarItem = createStatusBarItem()
    );
    _statusBarItemVisible = false
}

export function deactivate() {
    console.log('extension.addToCsproj#deactivate');
    _addedSinceActivate = []
    _cacheXml = Object.create(null)
    _cacheIndent = Object.create(null)
    hideStatusBarItem()
}

function ignoreEvent(context: vscode.ExtensionContext) {
    const {fileName} = vscode.window.activeTextEditor.document;
    if (isIgnoredPath(context.globalState, fileName))
        return true

    if (_statusBarItemVisible)
        return true

    return false
}

async function addToCsprojCommand(this: vscode.ExtensionContext, prompt = false) {
    const {fileName} = vscode.window.activeTextEditor.document;
    console.log(`extension.addToCsproj#trigger(${fileName})`);

    // Pass if we're saving a csproj file, or we are a standalone file without a path.
    if (fileName.endsWith('.csproj') || !fileName.match(/(\/|\\)/))
        return

    try {
        const csprojPath = await getCsprojPath(path.dirname(fileName))
        const csprojName = path.basename(csprojPath)
        const filePathRel = path.relative(path.dirname(csprojPath), fileName)

        if (!(csprojPath in _cacheXml) || !(csprojPath in _cacheIndent)) {
            const csprojContent = await readFile(csprojPath)
            _cacheXml[csprojPath] = <XML>etree.parse(csprojContent)
            _cacheIndent[csprojPath] = detectIndent(csprojContent)
        }

        if (_addedSinceActivate.indexOf(filePathRel) > -1
            || csprojHasFile(_cacheXml[csprojPath], filePathRel))
            return

        let pickResult = prompt
            ? await vscode.window.showQuickPick([YES, NO, NEVER], {
                placeHolder: `This file is not in ${csprojName}, would you like to add it?`
              })
            : YES

        if (!(pickResult in pickActions))
            pickResult = NO

        await pickActions[pickResult]({
            filePathRel,
            filePathAbs: fileName,
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
    csprojPath: string
    csprojXml: XML
    csprojName: string
    indent: number
    globalState: vscode.Memento
}

const pickActions = {
    async [YES]({ filePathRel, csprojPath, csprojXml, indent }: ActionArgs) {
        const config = vscode.workspace.getConfiguration("addToCsproj")
        const itemType = config.get<string>('itemType')
        addFileToCsproj(csprojXml, filePathRel, itemType)
        _addedSinceActivate.push(filePathRel)
        await writeXml(csprojXml, csprojPath, indent)

        hideStatusBarItem()
        vscode.window.showInformationMessage(`Added to ${csprojPath}`)
    },
    [NO]({ csprojName }: ActionArgs) {
        displayStatusBarItem(csprojName)
    },
    [NEVER]({ filePathAbs, globalState }: ActionArgs) {
        updateIgnoredPaths(globalState, filePathAbs)

        hideStatusBarItem()
        vscode.window.showInformationMessage(
            'Added file to ignore list, to clear list, run the "csproj: Clear ignored paths"')
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
    item.text = "not in .csproj"
    item.tooltip = "Add to csproj"
    item.command = 'extension.addToCsproj'
    return item
}

function updateIgnoredPaths(globalState: vscode.Memento, addPath: string) {
    const list = globalState.get<string[]>('addToCsproj.ignorePaths') || []
    list.push(addPath)
    globalState.update('addToCsproj.ignorePaths', list)
}

function isIgnoredPath(globalState: vscode.Memento, queryPath: string) {
    const ignorePaths = globalState.get<string[]>('addToCsproj.ignorePaths') || [];
    return ignorePaths.indexOf(queryPath) > -1
}

function clearIgnoredPathsCommand(this: vscode.ExtensionContext) {
    this.globalState.update('addToCsproj.ignorePaths', [])
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

async function addFileToCsproj(xml: XML, filePathRel: string, itemType = 'Content') {
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