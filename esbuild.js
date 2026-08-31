const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Reports build failures with file/line info instead of a bare stack trace. */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[build] started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}`);
        }
      }
      console.log('[build] finished');
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const shared = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  external: ['vscode'],
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

const tests = process.argv.includes('--tests');

const targets = tests
  ? [
      // Unit tests for the vscode-free matching logic, run with `node --test`.
      {
        ...shared,
        entryPoints: ['src/test/matching.test.ts'],
        minify: false,
        platform: 'node',
        target: 'node18',
        outfile: 'out/test/matching.test.js',
      },
    ]
  : [
      // VS Code desktop (Node.js extension host)
      { ...shared, platform: 'node', target: 'node18', outfile: 'dist/extension.js' },
      // VS Code for the Web (Web Worker extension host)
      { ...shared, platform: 'browser', target: 'es2022', outfile: 'dist/web/extension.js' },
    ];

async function main() {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
