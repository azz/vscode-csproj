// The module 'assert' provides assertion methods from node
import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import * as csprojExtension from '../src/extension';

suite('csproj Extension Tests', () => {

    test('basic operation', (done) => {
        vscode.workspace.onDidSaveTextDocument(() => {
            done();
        })
    });
});
