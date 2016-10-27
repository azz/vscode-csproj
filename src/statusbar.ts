import * as vscode from 'vscode'

let _statusBarItem: vscode.StatusBarItem
let _statusBarItemVisible = false

export function displayItem(csprojName: string, contained = false) {
    _statusBarItem.text = contained ? `Contained in ${csprojName}` : `Add to ${csprojName}`
    _statusBarItem.tooltip = _statusBarItem.text
    _statusBarItem.show()
    _statusBarItemVisible = true
}

export function hideItem() {
    _statusBarItem.text = ''
    _statusBarItem.hide()
    _statusBarItemVisible = false
}

export function createItem() {
    // Currenly only support one status bar item.
    if (_statusBarItem) {
        _statusBarItem.dispose()
        _statusBarItemVisible = false
    }

    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
    item.command = 'extension.csproj.add'
    _statusBarItem = item
    return item
}

export function isVisible() {
    return _statusBarItemVisible
}
