
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
