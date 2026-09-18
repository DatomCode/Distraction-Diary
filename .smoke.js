// Temporary smoke test for the compiled extension (run with: node .smoke.js)
// Stubs the `vscode` module and exercises the full lifecycle:
// activate -> focus loss -> refocus -> idle -> jump command.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', msg); }
}

// ---------------------------------------------------------------------------
// vscode stub
// ---------------------------------------------------------------------------
const disposables = [];
const events = {
  windowState: [],
  selection: [],
  activeEditor: [],
  docChange: [],
  configChange: []
};
const messages = [];
const commandsRun = [];

const stubVscode = {
  TreeItem: class TreeItem {
    constructor(label) { this.label = label; this.description = undefined; this.tooltip = undefined; this.command = undefined; }
  },
  EventEmitter: class EventEmitter {
    constructor() {
      const subs = [];
      this.event = (fn) => { subs.push(fn); return { dispose: () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); } }; };
      this.fire = (val) => { for (const fn of subs.slice()) fn(val); };
      this.dispose = () => subs.length = 0;
    }
  },
  Uri: {
    file: (p) => ({ scheme: 'file', path: p, toString: () => 'file://' + p })
  },
  Range: class Range { constructor(a, b, c, d) { this.a = a; this.b = b; this.c = c; this.d = d; } },
  MarkdownString: class MarkdownString { constructor(v) { this.value = v; } supportThemeIcons() { return this; } toString() { return this.value; } },
  ThemeIcon: class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } },
  Selection: class Selection { constructor(a, b, c, d) { this.a = a; this.b = b; this.c = c; this.d = d; } },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  window: {
    createTreeView: (id, opts) => {
      const view = { id, opts, dispose: () => {} };
      disposables.push(view);
      return view;
    },
    onDidChangeWindowState: (fn) => { events.windowState.push(fn); return { dispose: () => {} }; },
    onDidChangeTextEditorSelection: (fn) => { events.selection.push(fn); return { dispose: () => {} }; },
    onDidChangeActiveTextEditor: (fn) => { events.activeEditor.push(fn); return { dispose: () => {} }; },
    showInformationMessage: (msg, ...btns) => { messages.push({ msg, btns }); return Promise.resolve(undefined); },
    showWarningMessage: (msg) => { messages.push({ warn: true, msg }); return Promise.resolve(undefined); },
    activeTextEditor: undefined,
    showTextDocument: async (uri) => {
      // Build a fake editor for the target file.
      const text = fs.existsSync(uri.path) ? fs.readFileSync(uri.path, 'utf8') : 'line1\nline2\nline3\nline4\nline5\n';
      const lines = text.split('\n');
      const editor = {
        document: { fileName: uri.path, lineCount: lines.length, lineAt: (i) => ({ text: lines[i] || '' }) },
        selection: null,
        revealRangeCalls: [],
        revealRange: (r, type) => { editor.revealRangeCalls.push({ r, type }); }
      };
      stubVscode.window.activeTextEditor = editor;
      return editor;
    }
  },
  workspace: {
    onDidChangeTextDocument: (fn) => { events.docChange.push(fn); return { dispose: () => {} }; },
    onDidChangeConfiguration: (fn) => { events.configChange.push(fn); return { dispose: () => {} }; },
    getConfiguration: (section) => ({
      get: (key, dflt) => {
        const v = { 'idleTimeoutMinutes': 0.05, 'maxRecords': 5, 'recordFocusLoss': true }[key];
        return v !== undefined ? v : dflt;
      }
    })
  },
  commands: {
    registerCommand: (id, fn) => {
      commandsRun.push({ id, fn });
      return { dispose: () => {} };
    }
  }
};

// Make require('vscode') resolve to our stub.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: stubVscode };

// ---------------------------------------------------------------------------
// Load the compiled extension
// ---------------------------------------------------------------------------
const ext = require(path.join(__dirname, 'extension', 'out', 'extension.js'));
assert(typeof ext.activate === 'function', 'extension exports activate()');
assert(typeof ext.deactivate === 'function', 'extension exports deactivate()');

(async () => {
const context = { subscriptions: [] };
ext.activate(context);

assert(events.windowState.length === 1, 'window state listener registered');
assert(events.selection.length === 1, 'selection listener registered');
assert(events.activeEditor.length === 1, 'active editor listener registered');
assert(events.docChange.length === 1, 'document change listener registered');
assert(events.configChange.length === 1, 'config change listener registered');
assert(commandsRun.length === 1 && commandsRun[0].id === 'distractionDiary.jumpToRecord', 'jump command registered');

// Fake an open editor with a cursor on line 7, column 3 (0-based 6,2).
stubVscode.window.activeTextEditor = {
  document: { fileName: '/tmp/fake.ts' },
  selection: { active: { line: 6, character: 2 } }
};

// 1. Focus loss -> record.
events.windowState[0]({ focused: false, fullscreen: false });
assert(messages.length === 0, 'no message on focus loss');

// 2. Refocus -> welcome-back popup with a button.
events.windowState[0]({ focused: true, fullscreen: false });
assert(messages.length === 1, 'welcome-back message shown on refocus');
assert(/Welcome back! You were working on fake\.ts at line 7/.test(messages[0].msg), 'message text mentions filename + line: ' + messages[0].msg);
assert(Array.isArray(messages[0].btns) && messages[0].btns.some(b => /Go to|Jump|Open/i.test(b)), 'message includes a jump button');

// 3. Idle timer: settings use 0.05 min (3 s). Wait 4 s, expect an idle record
//    (recorded silently — no message until the user comes back).
await new Promise(r => setTimeout(r, 4000));
assert(messages.length === 1, 'no welcome-back yet for idle (user has not returned)');

// 4. Resume typing -> welcome-back for the idle distraction.
events.selection[0]();
assert(messages.length === 2, 'welcome-back shown when user resumes after idle');
assert(/line \d+/.test(messages[1].msg), 'idle welcome-back mentions a line');

// 5. Teleporter: click a tree item (call the command with the record).
const provider = ext.__test && ext.__test.diaryProvider;
// The command handler is registered; find it and invoke with a real record.
const jump = commandsRun[0].fn;
const fakeFile = path.join(os.tmpdir(), 'teleport-target.txt');
fs.writeFileSync(fakeFile, Array.from({ length: 10 }, (_, i) => 'line ' + (i + 1)).join('\n'));
await jump({ filePath: fakeFile, line: 8, character: 2, timestamp: Date.now(), type: 'idle' });
const ed = stubVscode.window.activeTextEditor;
assert(ed && ed.revealRangeCalls.length === 1, 'revealRange called for teleport');
assert(ed.selection && ed.selection.a === 7, 'selection parked on 0-based line 7 (recorded line 8)');
assert(ed.selection && ed.selection.b === 1, 'selection parked on column index 1 (recorded char 2)');

// 6. Teleporter to a missing file -> warning, no crash.
await jump({ filePath: '/tmp/does-not-exist-xyz.ts', line: 5, character: 1, timestamp: Date.now(), type: 'focus-loss' });
assert(messages.some(m => m.warn && /no longer available/.test(m.msg)), 'warning shown for missing file');

// 7. Tree provider rendering (via require of the provider module directly).
const providerMod = require(path.join(__dirname, 'extension', 'out', 'DistractionDiaryProvider.js'));
assert(typeof providerMod.DistractionDiaryProvider === 'function', 'provider class exported');
const prov = new providerMod.DistractionDiaryProvider();
const rec = { filePath: '/w/alpha.ts', line: 12, character: 4, timestamp: Date.now(), type: 'focus-loss' };
let refreshed = 0;
prov.onDidChangeTreeData(() => refreshed++);
prov.addRecord(rec);
assert(refreshed === 1, 'addRecord fires the refresh event');
const children = prov.getChildren();
assert(children.length === 1 && children[0] === rec, 'getChildren returns the record');
const item = prov.getTreeItem(rec);
assert(item.label === 'alpha.ts', 'tree item label is the filename: ' + item.label);
assert(/line 12/.test(item.description || ''), 'tree item description shows the line number');
assert(/focus.?loss|focus loss/i.test((item.tooltip && item.tooltip.toString()) || String(item.tooltip || '')), 'tooltip mentions distraction type: ' + item.tooltip);
assert(item.command && item.command.command === 'distractionDiary.jumpToRecord', 'tree item wired to jump command');
assert(item.command.arguments[0] === rec, 'tree item passes the record as command argument');

// 8. deactivate clears the idle timer without crashing.
ext.deactivate();
assert(true, 'deactivate() ran without error');

fs.unlinkSync(fakeFile);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
})();