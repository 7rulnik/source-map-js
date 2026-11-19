#!/usr/bin/env node
'use strict';

// Before/after: does a change make source-map-js faster or slower?
//
//   node benchmarks/before-after.js [--base <ref>] [--head <ref>] [options]
//
// Compares two copies of the library (by default the working tree against
// origin/main) on every case × fixture. Every measurement is its own process
// (benchmarks/worker.js). Each case × fixture gets --runs pairs of processes,
// base and head back to back, alternating which one goes first; one round
// covers every case × fixture before the next starts, so slow drift (heat,
// background load) lands on both sides alike. The result is the median of the
// per-pair speed ratios with a 95% confidence interval (benchmarks/stats.js).
// Run with --base HEAD on a clean tree to see the noise floor: every change
// in that run is noise.

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const { CASES } = require('./cases');
const { FIXTURES, ensureFixtures } = require('./fixtures');
const {
  runWorker,
  pick,
  formatTime,
  formatDuration,
  onBattery,
  machine,
  progress,
  printTable,
} = require('./runner');
const { medianWithCI, minValuesForCI } = require('./stats');

const DEFAULT_FIXTURES = ['react.js.map', 'amp.js.map'];
// A cell is marked faster/slower only when its 95% CI excludes 0 and the
// change is at least this big. Each cell has a ~2% chance of a CI that
// excludes 0 by luck, so a 20-cell run would often mark one; an A/A run
// stayed within ±1.5%.
const MIN_CHANGE = 0.01;

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/main' },
    head: { type: 'string' },
    fixtures: { type: 'string', default: DEFAULT_FIXTURES.join(',') },
    cases: { type: 'string', default: 'all' },
    runs: { type: 'string', default: '10' },
    time: { type: 'string', default: '500' },
    warmup: { type: 'string', default: '200' },
    json: { type: 'string' },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (opts.help) {
  console.log(`Usage: node benchmarks/before-after.js [options]

  --base <ref>       baseline commit (default: origin/main)
  --head <ref>       candidate commit (default: the working tree)
  --fixtures <list>  comma-separated, or "all" (default: ${DEFAULT_FIXTURES.join(',')})
  --cases <list>     comma-separated, or "all" (default: all)
  --runs <n>         process pairs per case × fixture (default: 10)
  --time <ms>        measuring time per process (default: 500)
  --warmup <ms>      warm-up time per process (default: 200)
  --json <file>      also write every measurement to <file>
  --list             list the fixtures and cases`);
  process.exit(0);
}

if (opts.list) {
  console.log('Fixtures:');
  for (const name of Object.keys(FIXTURES)) {
    console.log(
      `  ${name}${DEFAULT_FIXTURES.includes(name) ? ' (default)' : ''}`
    );
  }
  console.log('\nCases:');
  for (const c of CASES) console.log(`  ${c.name.padEnd(16)} ${c.description}`);
  process.exit(0);
}

const fixtures = pick(opts.fixtures, Object.keys(FIXTURES), 'fixture');
const cases = pick(
  opts.cases,
  CASES.map((c) => c.name),
  'case'
);
const runs = Number(opts.runs);
if (!(Number.isInteger(runs) && runs >= 1)) {
  console.error('--runs must be a positive whole number');
  process.exit(1);
}
if (runs < minValuesForCI()) {
  console.error(
    `Warning: a 95% confidence interval needs at least ${minValuesForCI()} runs.`
  );
}

// --- Copies of the library under test --------------------------------------

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: __dirname,
  encoding: 'utf8',
}).trim();
// Run from the top level, so pathspecs like `lib` mean the library.
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const tempDirs = [];

function cleanup() {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// Copies source-map.js and lib/ (from the working tree when `ref` is
// undefined) into a temp dir, so both sides load from the same kind of path
// and editing the working tree mid-run changes nothing.
function snapshot(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smjs-bench-'));
  tempDirs.push(dir);
  if (ref === undefined) {
    fs.cpSync(path.join(root, 'lib'), path.join(dir, 'lib'), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(root, 'source-map.js'),
      path.join(dir, 'source-map.js')
    );
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    const sha = git('rev-parse', 'HEAD');
    const dirty = git('status', '--porcelain', '--', 'source-map.js', 'lib');
    return {
      lib: path.join(dir, 'source-map.js'),
      sha,
      dirty: Boolean(dirty),
      label: `working tree (${branch} @ ${sha.slice(0, 10)}${dirty ? ' + uncommitted changes' : ''})`,
    };
  }
  let sha;
  try {
    sha = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    console.error(`Unknown ref: ${ref}`);
    process.exit(1);
  }
  execSync(`git archive ${sha} source-map.js lib | tar -x -C "${dir}"`, {
    cwd: root,
  });
  return {
    lib: path.join(dir, 'source-map.js'),
    sha,
    dirty: false,
    label: `${ref} @ ${sha.slice(0, 10)}`,
  };
}

// --- Measuring --------------------------------------------------------------

function measure(side, fixture, caseName) {
  return runWorker(
    'worker.js',
    ['cases', side.lib, fixture, caseName, opts.time, opts.warmup],
    `${fixture} ${caseName} on ${side.label}`
  );
}

const percent = (ratio) =>
  `${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(1)}%`;

async function main() {
  await ensureFixtures(fixtures);

  const base = snapshot(opts.base);
  const head = snapshot(opts.head);
  const sameCode = base.sha === head.sha && !base.dirty && !head.dirty;

  const cells = [];
  for (const fixture of fixtures) {
    for (const caseName of cases) {
      cells.push({
        fixture,
        case: caseName,
        base: [],
        head: [],
        ratios: [],
        checksums: { base: new Set(), head: new Set() },
      });
    }
  }

  const loadBefore = os.loadavg()[0];
  console.log(`base: ${base.label}`);
  console.log(`head: ${head.label}`);
  const { node, cpu } = machine();
  console.log(
    `node ${node} · ${cpu} · ${runs} pairs × ${cells.length} cells = ${runs * cells.length * 2} processes`
  );
  if (sameCode) {
    console.log(
      'Base and head are the same code: every "faster"/"slower" below is a false positive.'
    );
  }
  if (onBattery()) {
    console.log('Warning: running on battery power.');
  }
  console.log('');

  const status = progress(runs * cells.length * 2, cells.length * 2);

  for (let round = 0; round < runs; round++) {
    for (const cell of cells) {
      const order = round % 2 === 0 ? ['base', 'head'] : ['head', 'base'];
      const result = {};
      for (const sideName of order) {
        status.start(`${cell.fixture} ${cell.case} ${sideName}`);
        const side = sideName === 'base' ? base : head;
        result[sideName] = measure(side, cell.fixture, cell.case);
        status.done();
      }
      cell.base.push(result.base.ns);
      cell.head.push(result.head.ns);
      cell.ratios.push(result.base.ns / result.head.ns);
      cell.checksums.base.add(result.base.checksum);
      cell.checksums.head.add(result.head.checksum);
    }
  }
  const duration = status.finish();

  // --- Report ---------------------------------------------------------------

  const rows = [];
  const notes = [];
  let fixture;
  for (const cell of cells) {
    if (cell.fixture !== fixture) {
      fixture = cell.fixture;
      rows.push([fixture, 'base', 'head', 'change', '95% CI', '']);
    }
    const ratio = medianWithCI(cell.ratios);
    const ci =
      ratio.low === undefined
        ? 'n/a'
        : `[${percent(ratio.low)}, ${percent(ratio.high)}]`;
    let verdict = '';
    if (ratio.low > 1 && ratio.median >= 1 + MIN_CHANGE) verdict = 'faster';
    if (ratio.high < 1 && ratio.median <= 1 - MIN_CHANGE) verdict = 'slower';
    const { checksums } = cell;
    if (checksums.base.size > 1 || checksums.head.size > 1) {
      verdict += ' (!)';
      notes.push(
        `${cell.fixture} ${cell.case}: results vary between processes on the same side.`
      );
    } else if ([...checksums.base][0] !== [...checksums.head][0]) {
      verdict += ' (!)';
      notes.push(
        `${cell.fixture} ${cell.case}: base and head return different results.`
      );
    }
    rows.push([
      `  ${cell.case}`,
      formatTime(medianWithCI(cell.base).median),
      formatTime(medianWithCI(cell.head).median),
      percent(ratio.median),
      ci,
      verdict.trim(),
    ]);
  }

  printTable(rows, [0, 5]);
  console.log('');
  console.log(
    `change: head speed vs base, + is faster. Marked faster/slower when the 95% CI excludes 0 and the change is at least ${MIN_CHANGE * 100}%.`
  );
  for (const note of notes) console.log(`(!) ${note}`);
  console.log(
    `${formatDuration(duration)} · load average ${loadBefore.toFixed(2)} → ${os.loadavg()[0].toFixed(2)}`
  );

  if (opts.json) {
    fs.writeFileSync(
      opts.json,
      JSON.stringify(
        {
          base: base.label,
          head: head.label,
          node,
          cpu,
          runs,
          time: Number(opts.time),
          warmup: Number(opts.warmup),
          cells: cells.map((c) => ({
            fixture: c.fixture,
            case: c.case,
            base: c.base,
            head: c.head,
            checksums: {
              base: [...c.checksums.base],
              head: [...c.checksums.head],
            },
          })),
        },
        null,
        2
      ) + '\n'
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
