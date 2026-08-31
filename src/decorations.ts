import * as vscode from 'vscode';
import type { BlurStyle } from './rules';

/** Identifies a decoration type; also encodes the parameters used to build it. */
export function styleKey(style: BlurStyle, blurRadius: number): string {
  return style === 'redact' ? 'redact' : `blur:${blurRadius}`;
}

function parseKey(key: string): { style: BlurStyle; blurRadius: number } {
  if (key === 'redact') {
    return { style: 'redact', blurRadius: 0 };
  }
  return { style: 'blur', blurRadius: Number(key.slice('blur:'.length)) || 5 };
}

function createDecoration(key: string): vscode.TextEditorDecorationType {
  const { style, blurRadius } = parseKey(key);

  if (style === 'redact') {
    return vscode.window.createTextEditorDecorationType({
      color: 'transparent',
      backgroundColor: new vscode.ThemeColor('blurText.redactBackground'),
      borderRadius: '2px',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }

  // VS Code has no `filter` decoration property, but it writes `textDecoration`
  // verbatim into the generated CSS rule, so the filter can ride along after it.
  const filter = `blur(${blurRadius}px)`;
  return vscode.window.createTextEditorDecorationType({
    textDecoration: `none; filter: ${filter}; -webkit-filter: ${filter};`,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

/**
 * Lazily creates and caches one decoration type per distinct style, and knows the full
 * set so every editor can be cleared of stale decorations.
 */
export class DecorationRegistry implements vscode.Disposable {
  private readonly types = new Map<string, vscode.TextEditorDecorationType>();

  get(key: string): vscode.TextEditorDecorationType {
    let type = this.types.get(key);
    if (!type) {
      type = createDecoration(key);
      this.types.set(key, type);
    }
    return type;
  }

  /** Every (key, type) pair handed out so far. */
  entries(): Array<[string, vscode.TextEditorDecorationType]> {
    return [...this.types.entries()];
  }

  clearEditor(editor: vscode.TextEditor): void {
    for (const type of this.types.values()) {
      editor.setDecorations(type, []);
    }
  }

  dispose(): void {
    for (const type of this.types.values()) {
      type.dispose();
    }
    this.types.clear();
  }
}
