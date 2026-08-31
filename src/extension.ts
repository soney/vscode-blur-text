import * as vscode from 'vscode';
import { DecorationRegistry, styleKey } from './decorations';
import {
  compileRules,
  findRanges,
  mergeRanges,
  type CompiledRule,
  type OffsetRange,
} from './matcher';
import { enabledPresetIds, presetRules, unknownPresets } from './presets';
import { isConfigDocument, hasBulkInsert } from './documents';
import { matchesAnyGlob, ruleApplies } from './filters';
import { normalizeRule, type BlurRule, type BlurStyle } from './rules';

interface Settings {
  enabled: boolean;
  style: BlurStyle;
  blurRadius: number;
  revealAtCursor: boolean;
  excludeLanguages: string[];
  excludeFiles: string[];
  excludeConfigFiles: boolean;
  maxFileSize: number;
  maxMatchesPerRule: number;
  debounceMs: number;
  showStatusBarItem: boolean;
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('blurText');
  const style = c.get<string>('style', 'blur');
  return {
    enabled: c.get<boolean>('enabled', true),
    style: style === 'redact' ? 'redact' : 'blur',
    blurRadius: c.get<number>('blurRadius', 5),
    revealAtCursor: c.get<boolean>('revealAtCursor', false),
    excludeLanguages: c.get<string[]>('excludeLanguages', []),
    excludeFiles: c.get<string[]>('excludeFiles', []),
    excludeConfigFiles: c.get<boolean>('excludeConfigFiles', true),
    maxFileSize: c.get<number>('maxFileSize', 2_000_000),
    maxMatchesPerRule: c.get<number>('maxMatchesPerRule', 5000),
    debounceMs: c.get<number>('debounceMs', 120),
    showStatusBarItem: c.get<boolean>('showStatusBarItem', true),
  };
}

class BlurController implements vscode.Disposable {
  private registry = new DecorationRegistry();
  private settings = readSettings();
  /** Compiled rules per configuration scope (workspace folder). */
  private readonly compiled = new Map<string, CompiledRule[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Merged ranges per document, keyed by the version they were computed from. */
  private readonly scanCache = new Map<string, { version: number; ranges: OffsetRange[] }>();
  /** Documents skipped for exceeding `maxFileSize`, so the status bar can warn. */
  private readonly oversized = new Set<string>();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  /** Session-only override that reveals everything without changing settings. */
  private peeking = false;
  private reportedErrors = new Set<string>();

  constructor() {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = 'blurText.toggle';
    this.disposables.push(this.statusBar);

    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshAll()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.compiled.clear();
        this.refreshAll();
      }),
      vscode.workspace.onDidChangeTextDocument((e) =>
        this.scheduleFor(e.document, hasBulkInsert(e.contentChanges))
      ),
      vscode.workspace.onDidCloseTextDocument((document) => this.forget(document)),
      // Changing a file's language mode closes and reopens its document; re-scan so
      // language-scoped rules take effect immediately.
      vscode.workspace.onDidOpenTextDocument(() => this.refreshAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('blurText')) {
          this.reload();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (this.settings.revealAtCursor) {
          this.decorate(e.textEditor);
        }
      })
    );

    this.refreshAll();
  }

  /** Whether anything should currently be hidden. */
  private get active(): boolean {
    return this.settings.enabled && !this.peeking;
  }

  // --- configuration -------------------------------------------------------

  private reload(): void {
    this.settings = readSettings();
    this.compiled.clear();
    this.scanCache.clear();
    this.oversized.clear();
    this.reportedErrors.clear();
    // Recreate decoration types so obsolete styles are removed rather than accumulating.
    this.registry.dispose();
    this.registry = new DecorationRegistry();
    this.refreshAll();
  }

  private scopeKey(document: vscode.TextDocument): string {
    return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? '';
  }

  private rulesFor(document: vscode.TextDocument): CompiledRule[] {
    const key = this.scopeKey(document);
    const cached = this.compiled.get(key);
    if (cached) {
      return cached;
    }

    const c = vscode.workspace.getConfiguration('blurText', document.uri);
    const raw = c.get<unknown[]>('rules', []);
    const presets = enabledPresetIds(c.get<unknown>('presets'));

    const rules: BlurRule[] = [
      ...presetRules(presets),
      ...raw.map(normalizeRule).filter((r): r is BlurRule => r !== undefined),
    ];

    const { compiled, errors } = compileRules(rules);
    this.compiled.set(key, compiled);

    const missing = unknownPresets(presets);
    if (missing.length > 0) {
      this.reportOnce(`Blur Text: unknown preset(s): ${missing.join(', ')}`);
    }
    for (const { message } of errors) {
      this.reportOnce(`Blur Text: could not compile pattern ${message}`);
    }

    return compiled;
  }

  private reportOnce(message: string): void {
    if (!this.reportedErrors.has(message)) {
      this.reportedErrors.add(message);
      void vscode.window.showWarningMessage(message);
    }
  }

  // --- decorating ----------------------------------------------------------

  private scheduleFor(document: vscode.TextDocument, immediate = false): void {
    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(key);
    }

    // A paste can put an entire secret on screen at once. Waiting out the debounce
    // there would leave it plainly readable for that whole window, so bulk inserts
    // redecorate on the spot and only per-keystroke typing is debounced.
    if (immediate) {
      this.decorateDocument(key);
      return;
    }

    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.decorateDocument(key);
      }, Math.max(0, this.settings.debounceMs))
    );
  }

  private decorateDocument(uri: string): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri) {
        this.decorate(editor);
      }
    }
  }

  /** Drop everything remembered about a document that is no longer open. */
  private forget(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.scanCache.delete(key);
    this.oversized.delete(key);
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.decorate(editor);
    }
    this.updateStatusBar();
  }

  private decorate(editor: vscode.TextEditor): void {
    this.applyDecorations(editor);
    // The status bar reports on the focused editor, so refresh it alongside.
    if (editor === vscode.window.activeTextEditor) {
      this.updateStatusBar();
    }
  }

  private applyDecorations(editor: vscode.TextEditor): void {
    const document = editor.document;

    if (!this.active || this.isExcluded(document)) {
      this.registry.clearEditor(editor);
      return;
    }

    const key = document.uri.toString();
    const text = document.getText();
    if (text.length > this.settings.maxFileSize) {
      // Nothing is hidden here, which is the one case where failing quietly could put a
      // secret on screen. Remember it so the status bar can say so.
      this.oversized.add(key);
      this.registry.clearEditor(editor);
      return;
    }
    this.oversized.delete(key);

    const applicable = this.rulesFor(document).filter((c) => ruleApplies(c.rule, document));
    if (applicable.length === 0) {
      this.registry.clearEditor(editor);
      return;
    }

    // Scanning is the expensive part and only depends on the text, so reuse the result
    // across cursor movement and across split views of the same document.
    let cached = this.scanCache.get(key);
    if (!cached || cached.version !== document.version) {
      const found = findRanges(
        text,
        applicable,
        (rule) =>
          styleKey(rule.style ?? this.settings.style, rule.blurRadius ?? this.settings.blurRadius),
        { maxMatchesPerRule: this.settings.maxMatchesPerRule }
      );
      cached = { version: document.version, ranges: mergeRanges(found) };
      this.scanCache.set(key, cached);
    }

    // Reveal-at-cursor only applies to the editor that has focus; background
    // editors stay fully hidden even though their cursors sit inside a match.
    const revealHere =
      this.settings.revealAtCursor && editor === vscode.window.activeTextEditor;

    const byStyle = new Map<string, vscode.Range[]>();
    for (const range of cached.ranges) {
      const vsRange = new vscode.Range(
        document.positionAt(range.start),
        document.positionAt(range.end)
      );
      if (revealHere && this.intersectsSelection(editor, vsRange)) {
        continue;
      }
      const list = byStyle.get(range.styleKey);
      if (list) {
        list.push(vsRange);
      } else {
        byStyle.set(range.styleKey, [vsRange]);
      }
    }

    // Create every type we need first, then write all known types: a type that has no
    // ranges here must still be explicitly cleared or its last decorations linger.
    for (const key of byStyle.keys()) {
      this.registry.get(key);
    }
    for (const [key, type] of this.registry.entries()) {
      editor.setDecorations(type, byStyle.get(key) ?? []);
    }
  }

  private isExcluded(document: vscode.TextDocument): boolean {
    if (this.settings.excludeLanguages.includes(document.languageId)) {
      return true;
    }
    if (
      this.settings.excludeConfigFiles &&
      isConfigDocument(document.uri.scheme, document.uri.path)
    ) {
      return true;
    }
    return matchesAnyGlob(this.settings.excludeFiles, document);
  }

  private intersectsSelection(editor: vscode.TextEditor, range: vscode.Range): boolean {
    return editor.selections.some(
      (selection) =>
        // An empty selection (plain cursor) sitting on either edge still counts as inside.
        !!range.intersection(selection) ||
        (selection.isEmpty && range.contains(selection.active))
    );
  }

  // --- commands ------------------------------------------------------------

  private updateStatusBar(): void {
    if (!this.settings.showStatusBarItem) {
      this.statusBar.hide();
      return;
    }
    const active = vscode.window.activeTextEditor;
    const skipped = active !== undefined && this.oversized.has(active.document.uri.toString());

    if (!this.settings.enabled) {
      this.statusBar.text = '$(eye) Blur off';
      this.statusBar.tooltip = 'Blur Text is disabled — click to enable';
      this.statusBar.backgroundColor = undefined;
    } else if (skipped) {
      this.statusBar.text = '$(warning) Blur skipped';
      this.statusBar.tooltip =
        'This file is larger than blurText.maxFileSize, so nothing in it is blurred';
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (this.peeking) {
      this.statusBar.text = '$(eye) Blur peeking';
      this.statusBar.tooltip = 'Everything is revealed — run "Blur Text: Peek" again to re-hide';
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBar.text = '$(eye-closed) Blur on';
      this.statusBar.tooltip = 'Blur Text is hiding matches — click to disable';
      this.statusBar.backgroundColor = undefined;
    }
    this.statusBar.show();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.peeking = false;
    const config = vscode.workspace.getConfiguration('blurText');
    const inspected = config.inspect<boolean>('enabled');
    // Write where the value already lives, so a workspace override isn't shadowed.
    const target =
      inspected?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspected?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await config.update('enabled', enabled, target);
    // Writing the same value fires no configuration event, so refresh directly —
    // otherwise "Enable Blurring" while peeking would leave the reveal in place.
    this.refreshAll();
  }

  toggle(): Promise<void> {
    return this.setEnabled(!this.settings.enabled);
  }

  togglePeek(): void {
    if (!this.settings.enabled) {
      void vscode.window.showInformationMessage('Blur Text is already disabled.');
      return;
    }
    this.peeking = !this.peeking;
    this.refreshAll();
  }

  async blurSelection(editor: vscode.TextEditor): Promise<void> {
    const texts = [
      ...new Set(
        editor.selections
          .map((s) => editor.document.getText(s))
          .filter((t) => t.trim().length > 0)
      ),
    ];
    if (texts.length === 0) {
      void vscode.window.showInformationMessage('Blur Text: select some text first.');
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(account) User settings',
          detail: 'Stored in your personal settings.json — not committed to the repository',
          target: vscode.ConfigurationTarget.Global,
        },
        {
          label: '$(warning) Workspace settings',
          detail: 'Stored in .vscode/settings.json — the text may end up committed to git',
          target: vscode.ConfigurationTarget.Workspace,
        },
      ],
      { title: `Blur ${texts.length === 1 ? 'this text' : `these ${texts.length} strings`} — save where?` }
    );
    if (!choice) {
      return;
    }

    const config = vscode.workspace.getConfiguration('blurText', editor.document.uri);
    const inspected = config.inspect<unknown[]>('rules');
    const current =
      (choice.target === vscode.ConfigurationTarget.Global
        ? inspected?.globalValue
        : inspected?.workspaceValue) ?? [];

    const existing = new Set(
      current.map((r) => (typeof r === 'string' ? r : (r as { pattern?: string })?.pattern))
    );
    const additions = texts.filter((t) => !existing.has(t));
    if (additions.length === 0) {
      void vscode.window.showInformationMessage('Blur Text: already in your patterns.');
      return;
    }

    await config.update('rules', [...current, ...additions], choice.target);
    void vscode.window.showInformationMessage(
      `Blur Text: now blurring ${additions.length === 1 ? `"${truncate(additions[0])}"` : `${additions.length} strings`}.`
    );
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.scanCache.clear();
    this.registry.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function truncate(text: string, max = 24): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new BlurController();
  context.subscriptions.push(controller);

  context.subscriptions.push(
    vscode.commands.registerCommand('blurText.toggle', () => controller.toggle()),
    vscode.commands.registerCommand('blurText.enable', () => controller.setEnabled(true)),
    vscode.commands.registerCommand('blurText.disable', () => controller.setEnabled(false)),
    vscode.commands.registerCommand('blurText.peek', () => controller.togglePeek()),
    vscode.commands.registerTextEditorCommand('blurText.blurSelection', (editor) =>
      controller.blurSelection(editor)
    ),
    vscode.commands.registerCommand('blurText.editPatterns', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'blurText.rules')
    )
  );
}

export function deactivate(): void {
  // Everything is registered in context.subscriptions.
}
