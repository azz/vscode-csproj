'use strict';

import * as vscode from 'vscode'
import * as fs from 'mz/fs'
import * as path from 'path'

const etree = require('elementtree')
const stripBom = require('strip-bom')

let _cacheXml: XML | undefined = undefined;
let _cacheIndent: number | undefined = undefined;
let _addedSinceActivate: string[] = [];

export function activate(context: vscode.ExtensionContext) {
    console.log('extension.addToCsproj#activate')

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.addToCsproj', addToCsprojCommand),
        vscode.workspace.onDidSaveTextDocument(() => {
            vscode.commands.executeCommand('extension.addToCsproj')
        })
    );
}

export function deactivate() {
    console.log('extension.addToCsproj#deactivate');
    _addedSinceActivate = []
    _cacheXml = undefined
    _cacheIndent = undefined
}

async function addToCsprojCommand() {
    const {fileName} = vscode.window.activeTextEditor.document;
    console.log(`extension.addToCsproj#trigger(${fileName})`);

    // Pass if we're saving a csproj file, or we are a standalone file without a path.
    if (fileName.endsWith('.csproj') || !fileName.match(/(\/|\\)/))
        return

    try {
        const csprojPath = await getCsprojPath(path.dirname(fileName))
        const csprojName = path.basename(csprojPath)
        const filePathRel =  path.relative(path.dirname(csprojPath), fileName)

        if (!_cacheXml) {
            const csprojContent = await readFile(csprojPath)
            _cacheXml = <XML>etree.parse(csprojContent)
            _cacheIndent = detectIndent(csprojContent)
        }

        if (_addedSinceActivate.indexOf(filePathRel) > -1
            || csprojHasFile(_cacheXml, filePathRel))
            return

        if (await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: `You just saved a file not in ${csprojName}, would you like to add it?`
            }) !== 'Yes')
            return

        addFileToCsproj(_cacheXml, filePathRel)
        _addedSinceActivate.push(filePathRel)
        await writeXml(_cacheXml, csprojPath, _cacheIndent)

        vscode.window.showInformationMessage(`Added to ${csprojPath}`)
    } catch (err) {
        vscode.window.showErrorMessage(err.toString())
    }
}

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
            throw new Error('Reached fs root, no csproj found')
        return getCsprojPath(parent)
    }
    throw new Error(`No csproj found in current directory: ${fileDir}`)
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

async function writeXml(xml: XML, path: string, indent) {
    return await fs.writeFile(path, etree.tostring(xml.getroot(), { indent }))
}