// Pure document predicates, kept free of `vscode` imports so they stay unit-testable.

/**
 * VS Code's own settings files. These are where `blurText.rules` itself lives, so
 * blurring inside them hides the patterns you are trying to edit.
 */
export function isConfigDocument(scheme: string, path: string): boolean {
  // User-level settings.json, keybindings.json and snippets all use this scheme.
  if (scheme === 'vscode-userdata') {
    return true;
  }
  if (path.endsWith('.code-workspace')) {
    return true;
  }
  return /(^|\/)\.vscode\/settings\.json$/.test(path);
}

/**
 * True when an edit inserted more than one character at once — a paste, a multi-cursor
 * insert, an undo, a snippet. Those can put a whole secret on screen in a single frame,
 * so they must not wait out the debounce that keeps ordinary typing cheap.
 */
export function hasBulkInsert(changes: readonly { readonly text: string }[]): boolean {
  return changes.some((change) => change.text.length > 1);
}
