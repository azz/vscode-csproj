
const etree = require('elementtree')
const sax: SAX = require('elementtree/lib/parsers/sax')

interface SAX {
    XMLParser: new () => Parser
}

interface Parser {
    target: {
        end: Function
        start: Function
        data: Function
    }
}

export interface XMLElement {
    find(xpath: string): XMLElement
    findall(xpath: string): XMLElement[]
}

export interface XML {
    getroot(): XMLElement
    write(opts: any): string
}


export default class XMLParser extends sax.XMLParser {
    _handleComment(comment: string) {
        this.target.start(etree.Comment, {})
        this.target.data(comment)
        this.target.end(etree.Comment)
    }
}
