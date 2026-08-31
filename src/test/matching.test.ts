import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isConfigDocument, hasBulkInsert } from '../documents';
import { compileRules, findRanges, mergeRanges } from '../matcher';
import { PRESETS, presetRules } from '../presets';
import { normalizeRule, type BlurRule } from '../rules';

/** Run a set of raw config entries over `text` and return the hidden substrings. */
function hidden(rawRules: unknown[], text: string, maxMatchesPerRule = 5000): string[] {
  const rules = rawRules
    .map(normalizeRule)
    .filter((r): r is BlurRule => r !== undefined);
  const { compiled } = compileRules(rules);
  const ranges = mergeRanges(
    findRanges(text, compiled, (r) => r.style ?? 'blur', { maxMatchesPerRule })
  );
  return ranges.map((r) => text.slice(r.start, r.end));
}

function hiddenFromRules(rules: BlurRule[], text: string): string[] {
  const { compiled } = compileRules(rules);
  const ranges = mergeRanges(
    findRanges(text, compiled, () => 'blur', { maxMatchesPerRule: 5000 })
  );
  return ranges.map((r) => text.slice(r.start, r.end));
}

test('literal strings match exactly and repeatedly', () => {
  assert.deepEqual(hidden(['secret'], 'a secret and another secret'), ['secret', 'secret']);
});

test('literal strings are case sensitive by default', () => {
  assert.deepEqual(hidden(['secret'], 'Secret secret'), ['secret']);
  assert.deepEqual(
    hidden([{ pattern: 'secret', caseSensitive: false }], 'Secret secret'),
    ['Secret', 'secret']
  );
});

test('regex metacharacters in literals are escaped', () => {
  assert.deepEqual(hidden(['a.c'], 'abc a.c'), ['a.c']);
});

test('wholeWord only anchors ends that are word characters', () => {
  assert.deepEqual(hidden([{ pattern: 'key', wholeWord: true }], 'key monkey'), ['key']);
  // A leading `-` cannot sit next to \b, so the assertion must be dropped there.
  assert.deepEqual(hidden([{ pattern: '-tok', wholeWord: true }], 'x-tok'), ['-tok']);
});

test('regex rules hide the whole match by default', () => {
  assert.deepEqual(
    hidden([{ pattern: 'sk-[a-z0-9]+', regex: true }], 'key = sk-abc123 end'),
    ['sk-abc123']
  );
});

test('regex rules can hide just a capture group', () => {
  assert.deepEqual(
    hidden(
      [{ pattern: 'API_KEY\\s*=\\s*(\\S+)', regex: true, group: 1 }],
      'API_KEY = hunter2\n'
    ),
    ['hunter2']
  );
});

test('named capture groups work', () => {
  assert.deepEqual(
    hidden(
      [{ pattern: 'token:(?<value>\\w+)', regex: true, group: 'value' }],
      'token:abc123'
    ),
    ['abc123']
  );
});

test('multiple groups, skipping ones that did not participate', () => {
  const rule = {
    pattern: '=\\s*(?:"([^"]*)"|(\\S+))',
    regex: true,
    group: [1, 2],
  };
  assert.deepEqual(hidden([rule], 'A="quoted"\nB=bare'), ['quoted', 'bare']);
});

test('a group that matched an empty string produces no range', () => {
  assert.deepEqual(hidden([{ pattern: 'x(\\d*)', regex: true, group: 1 }], 'x'), []);
});

test('zero-length matches terminate instead of looping forever', () => {
  // If lastIndex were not advanced manually this would never return.
  assert.deepEqual(hidden([{ pattern: 'q*', regex: true }], 'abqc'), ['q']);
});

test('match count is capped per rule', () => {
  // Separated by spaces so mergeRanges cannot collapse adjacent hits into one.
  assert.equal(hidden([{ pattern: 'a', regex: true }], 'a a a a a a', 3).length, 3);
});

test('adjacent ranges merge into a single decoration', () => {
  assert.deepEqual(hidden([{ pattern: 'a', regex: true }], 'aaa'), ['aaa']);
});

test('invalid regexes are reported, not thrown', () => {
  const { compiled, errors } = compileRules([
    normalizeRule({ pattern: '([unclosed', regex: true })!,
  ]);
  assert.equal(compiled.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /\(\[unclosed/);
});

test('overlapping ranges of the same style merge into one', () => {
  assert.deepEqual(
    mergeRanges([
      { start: 0, end: 5, styleKey: 'blur' },
      { start: 3, end: 9, styleKey: 'blur' },
      { start: 20, end: 22, styleKey: 'blur' },
    ]),
    [
      { start: 0, end: 9, styleKey: 'blur' },
      { start: 20, end: 22, styleKey: 'blur' },
    ]
  );
});

test('overlapping ranges of different styles do not double-decorate', () => {
  const merged = mergeRanges([
    { start: 0, end: 5, styleKey: 'blur:5' },
    { start: 2, end: 8, styleKey: 'redact' },
  ]);
  assert.deepEqual(merged, [
    { start: 0, end: 5, styleKey: 'blur:5' },
    { start: 5, end: 8, styleKey: 'redact' },
  ]);
});

test('two rules covering the same text collapse to one range', () => {
  assert.deepEqual(hidden(['abc', 'bc'], 'xabcx'), ['abc']);
});

test('every preset id in the table compiles', () => {
  for (const [id, rules] of Object.entries(PRESETS)) {
    const { compiled, errors } = compileRules(rules);
    assert.equal(errors.length, 0, `${id}: ${errors.map((e) => e.message).join(', ')}`);
    assert.equal(compiled.length, rules.length, id);
  }
});

test('preset: secret-assignments hides values, not the names', () => {
  const text = [
    'api_key = "sk-live-abcdef"',
    'const authToken: string = "abc.def"',
    '{ "api_key": "json-style" }',
    'password: yaml-style',
    'PASSWORD=letmein',
    'const total = 42',
  ].join('\n');
  assert.deepEqual(hiddenFromRules(presetRules(['secret-assignments']), text), [
    'sk-live-abcdef',
    'abc.def',
    'json-style',
    'yaml-style',
    'letmein',
  ]);
});

test('preset: secret-assignments ignores names that merely contain a keyword', () => {
  const text = 'const tokenizer = buildTokenizer()\nlet secretariat = 1';
  assert.deepEqual(hiddenFromRules(presetRules(['secret-assignments']), text), []);
});

test('preset: dotenv-values hides values on both quoted and bare lines', () => {
  const text = 'export A=plain\nB="quoted value"\nC=\'single\'\n# comment\n';
  assert.deepEqual(hiddenFromRules(presetRules(['dotenv-values']), text), [
    'plain',
    'quoted value',
    'single',
  ]);
});

test('preset: provider key patterns match real-shaped keys', () => {
  const cases: Array<[string, string]> = [
    ['openai-keys', 'sk-proj-AbCdEf0123456789xyz'],
    ['anthropic-keys', 'sk-ant-api03-AbCdEf0123456789'],
    ['aws-keys', 'AKIAIOSFODNN7EXAMPLE'],
    ['github-tokens', 'ghp_16CharsAtLeast0123456789'],
    ['google-api-keys', 'AIzaSyA0123456789abcdefghijklmnopqrstuv'],
    ['slack-tokens', 'xoxb-123456789-abcdefg'],
    ['stripe-keys', 'sk_live_abcdefghij0123'],
    ['jwt', 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM'],
    ['uuids', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['ip-addresses', '192.168.1.254'],
    ['emails', 'teacher@umich.edu'],
  ];
  for (const [preset, sample] of cases) {
    const found = hiddenFromRules(presetRules([preset]), `value: ${sample};`);
    assert.deepEqual(found, [sample], preset);
  }
});

test('preset: bearer-tokens hides only the token', () => {
  assert.deepEqual(
    hiddenFromRules(presetRules(['bearer-tokens']), 'Authorization: Bearer abc123def456'),
    ['abc123def456']
  );
});

test('preset: private-key-blocks spans multiple lines', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n-----END RSA PRIVATE KEY-----';
  assert.deepEqual(hiddenFromRules(presetRules(['private-key-blocks']), `x\n${pem}\ny`), [pem]);
});

test('preset: ip-addresses rejects out-of-range octets', () => {
  assert.deepEqual(hiddenFromRules(presetRules(['ip-addresses']), 'version 999.1.1.1'), []);
});

test('normalizeRule accepts strings and objects, rejects junk', () => {
  assert.equal(normalizeRule('abc')?.pattern, 'abc');
  assert.equal(normalizeRule({ pattern: 'abc', regex: true })?.regex, true);
  assert.equal(normalizeRule(''), undefined);
  assert.equal(normalizeRule({ nope: 1 }), undefined);
  assert.equal(normalizeRule(42), undefined);
  assert.equal(normalizeRule(null), undefined);
});

test('normalizeRule defaults match the documented settings defaults', () => {
  const r = normalizeRule('x')!;
  assert.deepEqual(
    { regex: r.regex, caseSensitive: r.caseSensitive, wholeWord: r.wholeWord, groups: r.groups },
    { regex: false, caseSensitive: true, wholeWord: false, groups: [0] }
  );
});

test('disabled rules are skipped at compile time', () => {
  assert.deepEqual(hidden([{ pattern: 'abc', enabled: false }], 'abc'), []);
});

// --- document predicates ---------------------------------------------------

test('VS Code settings files are recognized as config documents', () => {
  const cases: Array<[string, string, boolean]> = [
    // User settings.json and friends live under this scheme.
    ['vscode-userdata', '/User/settings.json', true],
    ['vscode-userdata', '/User/keybindings.json', true],
    ['file', '/home/me/project/.vscode/settings.json', true],
    ['file', '/home/me/project/my.code-workspace', true],
    // Everything else must still be blurred.
    ['file', '/home/me/project/src/settings.json', false],
    ['file', '/home/me/project/.vscode/launch.json', false],
    ['file', '/home/me/project/app.py', false],
    ['file', '/home/me/.env', false],
  ];
  for (const [scheme, path, expected] of cases) {
    assert.equal(isConfigDocument(scheme, path), expected, `${scheme}:${path}`);
  }
});

test('bulk inserts are detected so pastes can skip the debounce', () => {
  assert.equal(hasBulkInsert([{ text: 'sk-live-abcdef' }]), true, 'paste');
  assert.equal(hasBulkInsert([{ text: 'a' }, { text: 'multi cursor paste' }]), true);
  assert.equal(hasBulkInsert([{ text: 'a' }]), false, 'single keystroke');
  assert.equal(hasBulkInsert([{ text: '' }]), false, 'deletion');
  assert.equal(hasBulkInsert([]), false, 'no changes');
});
