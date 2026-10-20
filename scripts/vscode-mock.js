/* Minimal VS Code API mock used by scripts/smoke.js (development only). */
const path = require('path');

function makeUri(fsPath) {
  return {
    fsPath,
    path: fsPath.replace(/\\/g, '/'),
    scheme: 'file',
    toString() {
      return 'file:///' + fsPath.replace(/\\/g, '/').replace(/ /g, '%20');
    },
  };
}

class Disposable {
  constructor(fn) {
    this.fn = fn;
  }
  dispose() {
    if (this.fn) {
      this.fn();
    }
  }
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return new Disposable(() => {
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      });
    };
  }
  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class MarkdownString {
  constructor(value) {
    this.value = value;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    Object.assign(this, { startLine, startCharacter, endLine, endCharacter });
  }
}

class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

const notifications = [];
const commands = new Map();
const documents = [];
let diagnosticStore = new Map();

const vscode = {
  Uri: { file: makeUri, joinPath: (base, ...parts) => makeUri(path.join(base.fsPath, ...parts)) },
  EventEmitter,
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon,
  MarkdownString,
  Range,
  Diagnostic,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  Disposable,
  debug: {
    startDebugging: async () => true,
  },
  languages: {
    createDiagnosticCollection: () => ({
      clear: () => diagnosticStore.clear(),
      set: (uri, list) => diagnosticStore.set(uri.fsPath, list),
      dispose: () => {},
    }),
  },
  commands: {
    registerCommand: (id, handler) => {
      commands.set(id, handler);
      return new Disposable(() => commands.delete(id));
    },
    executeCommand: async () => undefined,
  },
  window: {
    createOutputChannel: () => ({
      lines: [],
      appendLine(value) {
        this.lines.push(value);
      },
      show() {},
      hide() {},
      clear() {},
      dispose() {},
    }),
    createStatusBarItem: () => ({
      text: '',
      tooltip: '',
      command: '',
      show() {},
      hide() {},
      dispose() {},
    }),
    createTreeView: () => ({ dispose() {} }),
    showInformationMessage: async (message) => {
      notifications.push({ level: 'info', message });
      return undefined;
    },
    showWarningMessage: async (message) => {
      notifications.push({ level: 'warning', message });
      return undefined;
    },
    showErrorMessage: async (message) => {
      notifications.push({ level: 'error', message });
      return undefined;
    },
    showQuickPick: async (items) => items[0],
    showOpenDialog: async () => undefined,
    showTextDocument: async (document) => document,
    setStatusBarMessage: () => new Disposable(() => {}),
    withProgress: async (_options, task) => task({ report: () => {} }, { isCancellationRequested: false }),
  },
  workspace: {
    workspaceFolders: [{ uri: makeUri(process.env.KEIL_SMOKE_WORKSPACE || 'C:\\Keil_v5'), name: 'w', index: 0 }],
    getConfiguration: () => ({
      get: (key, fallback) => {
        const value = vscode.__settings['keil.' + key];
        return value === undefined ? fallback : value;
      },
      update: async () => undefined,
    }),
    findFiles: async () => vscode.__files.map((file) => makeUri(file)),
    onDidChangeConfiguration: () => new Disposable(() => {}),
    createFileSystemWatcher: () => ({
      onDidChange() {},
      onDidCreate() {},
      onDidDelete() {},
      dispose() {},
    }),
    openTextDocument: async (input) => {
      const document = {
        uri: input && input.fsPath ? makeUri(input.fsPath) : makeUri('<untitled>'),
        content: typeof input === 'string' ? input : input && input.content ? input.content : '',
        getText() {
          return this.content;
        },
      };
      documents.push(document);
      return document;
    },
    getWorkspaceFolder: () => ({ uri: makeUri(process.env.KEIL_SMOKE_WORKSPACE || 'C:\\Keil_v5'), name: 'w', index: 0 }),
    fs: {},
  },
  __settings: {},
  __files: [],
  __notifications: notifications,
  __commands: commands,
  __documents: documents,
  __diagnostics: () => diagnosticStore,
  __state: new Map(),
  __extensionContext: null,
};

module.exports = vscode;
