import * as vscode from 'vscode';
import type { BlurRule } from './rules';

/** True when the rule's language / file filters admit this document. */
export function ruleApplies(rule: BlurRule, document: vscode.TextDocument): boolean {
  if (!rule.enabled) {
    return false;
  }
  if (rule.languages && rule.languages.length > 0 && !rule.languages.includes('*')) {
    if (!rule.languages.includes(document.languageId)) {
      return false;
    }
  }
  if (rule.files) {
    // Reuse VS Code's own glob matching rather than bundling a matcher.
    return vscode.languages.match({ pattern: rule.files }, document) > 0;
  }
  return true;
}

/** True when the document matches any of the given globs. */
export function matchesAnyGlob(globs: readonly string[], document: vscode.TextDocument): boolean {
  return globs.some((pattern) => vscode.languages.match({ pattern }, document) > 0);
}
