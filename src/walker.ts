
import {Stats} from 'mz/fs'
import {join} from 'path'

const walk: Walk = require('walk').walk

type Walk = (rootDir: string, opts?: any) => Walker

interface WalkStats extends Stats {
    name: string
    type: string
}

type Callback<T> = (root: string, arg: T, next: Function) => void

interface Walker {
    on(event: 'file', callback: Callback<WalkStats>): void;
    on(event: 'errors', callback: Callback<WalkStats[]>): void;
    on(event: 'end', callback: () => void): void;
}

export async function processFiles<T>(
    rootDir: string,
    processFile: (fsPath: string) => Promise<T>
): Promise<T[]> {
    const walker = walk(rootDir, { followLinks: false })
    const items: T[] = []

    walker.on('file', (root, stats, next) => {
        processFile(join(root, stats.name)).then((item) => {
            items.push(item)
            next()
        })
    })

    return new Promise<T[]>((acc) => {
        walker.on('end', () => acc(items))
        walker.on('errors', (root, stats, next) => {
            console.error(stats)
            next()
        })
    })
}
