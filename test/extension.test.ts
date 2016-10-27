import * as mockFs from 'mock-fs'

import {workspace, commands, window, Uri} from 'vscode'
import {readFileSync} from 'mz/fs'
import {join} from 'path'
import * as sinon from 'sinon'
import {expect} from 'chai'

import * as csprojExtension from '../src/extension'

const up = '../..'

const sampleCsproj = readFileSync(join(__dirname, up, 'test/fixtures/Sample.csproj'))

function toUri(path: string) {
    return Uri.file(join(process.cwd(), path))
}

describe('csproj integration tests', () => {

    beforeEach(() => {
        // really want a way to set `workspace.rootPath` here.
        process.chdir('../../../..')
        mockFs({
            'dir1': {
                'file1.ext1': 'f1',
                'file2.ext2': 'f2',
            },
            'Project1.csproj': sampleCsproj
        })
    })

    it('prompts to add a file to csproj when opened', (done) => {
        const askSpy = sinon.spy(window, 'showInformationMessage')
        // console.info(process.cwd())
        expect(readFileSync('dir1/file1.ext1').toString()).to.equal('f1')
        // console.info(toUri('dir1').fsPath)
        workspace.openTextDocument(toUri('dir1/file1.ext1')).then((td) => {
            askSpy.calledOnce.should.be.true
            expect(askSpy.args[0][0]).to.equal(`file1.ext1 is not in Project1.csproj, would you like to add it?`, 'prompt')
            done()
        }, (err) => {
            expect(err).not.to.exist
            done()
        })
    });

    afterEach(() => {
        mockFs.restore()
    })
});
