#!/usr/bin/env node
'use strict';

// Comparison: how does source-map-js do against other source map libraries?
//
//   node benchmarks/compare.js [options]
//
// Runs every case × fixture on every library in libs.js. Every measurement is
// its own process (worker.js for time, memory.js for memory), and each round
// runs every cell once in a fresh random order, so no library always runs
// right after a particular other one. A cell's result is the median of its
// processes. The libraries differ by 2–30×, so this suite needs fewer runs
// than before/after: it's after fairness, not 1% resolution.
//
// Before reporting times it checks that every library gave the same answers
// as source-map-js, and lists the ones that didn't.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const { CASES } = require('./compare-cases');
const { FIXTURES, ensureFixtures, loadFixture } = require('./fixtures');
const { LIBS } = require('./libs');
const {
  runWorker,
  pick,
  formatTime,
  formatDuration,
  formatBytes,
  onBattery,
  machine,
  progress,
  printTable,
  shuffle,
} = require('./runner');
const { medianWithCI } = require('./stats');

// Memory varies much less than time: in a full run, a cell's processes agreed
// to within 5% on the smallest fixtures and 0.1% on the rest. A few runs are
// enough.
const MEMORY_RUNS = 3;

const MEMORY_CASE = {
  name: 'memory',
  description:
    'memory one consumer keeps once it has answered a query in each direction (JS heap, external and WebAssembly memory)',
};

const DEFAULTS = {
  libs: 'all',
  fixtures: 'all',
  cases: 'all',
  runs: '5',
  time: '300',
  warmup: '100',
};

const { values: opts } = parseArgs({
  options: {
    ...Object.fromEntries(
      Object.entries(DEFAULTS).map(([name, value]) => [
        name,
        { type: 'string', default: value },
      ])
    ),
    markdown: { type: 'string' },
    json: { type: 'string' },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (opts.help) {
  console.log(`Usage: node benchmarks/compare.js [options]

  --libs <list>      comma-separated library ids, or "all" (default: all)
  --fixtures <list>  comma-separated, or "all" (default: all)
  --cases <list>     comma-separated, or "all" (default: all)
  --runs <n>         processes per cell (default: 5)
  --time <ms>        measuring time per process (default: 300)
  --warmup <ms>      warm-up time per process (default: 100)
  --markdown <file>  also write the results as Markdown (benchmarks/RESULTS.md)
  --json <file>      also write every measurement to <file>
  --list             list the libraries, fixtures and cases`);
  process.exit(0);
}

const ALL_CASES = [...CASES, MEMORY_CASE];

if (opts.list) {
  console.log('Libraries:');
  for (const lib of LIBS) console.log(`  ${lib.id.padEnd(16)} ${lib.name}`);
  console.log('\nFixtures:');
  for (const name of Object.keys(FIXTURES)) console.log(`  ${name}`);
  console.log('\nCases:');
  for (const c of ALL_CASES) {
    console.log(`  ${c.name.padEnd(16)} ${c.description}`);
  }
  process.exit(0);
}

const libs = pick(
  opts.libs,
  LIBS.map((l) => l.id),
  'library'
).map((id) => LIBS.find((l) => l.id === id));
const fixtures = pick(opts.fixtures, Object.keys(FIXTURES), 'fixture');
const caseNames = pick(
  opts.cases,
  ALL_CASES.map((c) => c.name),
  'case'
);
const cases = ALL_CASES.filter((c) => caseNames.includes(c.name));
const runs = Number(opts.runs);
if (!(Number.isInteger(runs) && runs >= 1)) {
  console.error('--runs must be a positive whole number');
  process.exit(1);
}

// The first library is the reference: ratios and answer checks are relative
// to it. That's source-map-js unless --libs leaves it out.
const reference = libs[0];

// --- Setup checks -------------------------------------------------------------

for (const lib of libs) {
  for (const pkg of lib.packages) {
    try {
      require.resolve(`${pkg}/package.json`);
    } catch {
      console.error(
        `${pkg} isn't installed. Run \`pnpm --dir benchmarks install\` first.`
      );
      process.exit(1);
    }
  }
}

const root = path.join(__dirname, '..');
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// "1.2.4, main @ adace91" (+ " + uncommitted changes")
function describeSourceMapJs(version) {
  try {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    const sha = git('rev-parse', '--short', 'HEAD');
    const dirty = git('status', '--porcelain', '--', 'source-map.js', 'lib');
    return `${version}, ${branch} @ ${sha}${dirty ? ' + uncommitted changes' : ''}`;
  } catch {
    return version;
  }
}

function libVersion(lib) {
  return lib.id === 'smjs' ? describeSourceMapJs(lib.version()) : lib.version();
}

// The column header: the name, with the version where two columns share a
// name.
function shortName(lib) {
  if (lib.id === 'trace-mapping') return 'trace-mapping + gen-mapping';
  return LIBS.filter((l) => l.name === lib.name).length > 1
    ? `${lib.name} ${lib.version()}`
    : lib.name;
}

// --- Answers ------------------------------------------------------------------

// A checksum is an array of per-query (or per-line) hashes, or
// { answers, equivalent } where a different answer can still be right.
function compareAnswers(ref, other) {
  const a = Array.isArray(ref) ? { answers: ref } : ref;
  const b = Array.isArray(other) ? { answers: other } : other;
  const total = Math.max(a.answers.length, b.answers.length);
  let different = 0;
  let equivalent = 0;
  for (let i = 0; i < total; i++) {
    if (a.answers[i] === b.answers[i]) continue;
    if (a.equivalent && b.equivalent && a.equivalent[i] === b.equivalent[i]) {
      equivalent++;
    } else {
      different++;
    }
  }
  return { total, different, equivalent };
}

// --- Measuring ----------------------------------------------------------------

function measure(cell) {
  if (cell.case === MEMORY_CASE.name) {
    return runWorker(
      'memory.js',
      [cell.lib.id, cell.fixture],
      `memory of ${cell.fixture} on ${cell.lib.id}`
    );
  }
  return runWorker(
    'worker.js',
    [
      'compare-cases',
      cell.lib.id,
      cell.fixture,
      cell.case,
      opts.time,
      opts.warmup,
    ],
    `${cell.fixture} ${cell.case} on ${cell.lib.id}`
  );
}

function fixtureInfo(name) {
  const fixture = loadFixture(name);
  let segments = 0;
  for (const line of fixture.lines) segments += line.length;
  return {
    bytes: Buffer.byteLength(fixture.text),
    segments,
    sources: fixture.map.sources.length,
  };
}

const ratio = (value, ref) => {
  const r = value / ref;
  return `${r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2)}×`;
};

async function main() {
  await ensureFixtures(fixtures);

  const cells = [];
  for (const fixture of fixtures) {
    for (const c of cases) {
      for (const lib of libs) {
        cells.push({
          fixture,
          case: c.name,
          lib,
          runs: c === MEMORY_CASE ? Math.min(runs, MEMORY_RUNS) : runs,
          values: [],
          checksums: new Set(),
        });
      }
    }
  }
  const total = cells.reduce((sum, c) => sum + c.runs, 0);

  const loadBefore = os.loadavg()[0];
  const { node, cpu } = machine();
  for (const lib of libs) {
    console.log(`${lib.id.padEnd(14)} ${lib.name} ${libVersion(lib)}`);
  }
  console.log(`node ${node} · ${cpu} · ${total} processes`);
  if (onBattery()) console.log('Warning: running on battery power.');
  console.log('');

  const status = progress(total);
  for (let round = 0; round < runs; round++) {
    for (const cell of shuffle(cells.filter((c) => round < c.runs))) {
      status.start(
        `round ${round + 1}/${runs} · ${cell.fixture} ${cell.case} ${cell.lib.id}`
      );
      const result = measure(cell);
      status.done();
      if (cell.case === MEMORY_CASE.name) {
        cell.values.push(result.bytes);
      } else {
        cell.values.push(result.ns);
        cell.checksums.add(JSON.stringify(result.checksum));
      }
    }
    status.round(round + 1, runs);
  }
  const duration = status.finish();

  // --- Results ----------------------------------------------------------------

  const find = (fixture, caseName, lib) =>
    cells.find(
      (c) => c.fixture === fixture && c.case === caseName && c.lib === lib
    );

  const notes = [];
  for (const cell of cells) {
    cell.median = medianWithCI(cell.values).median;
    if (cell.case === MEMORY_CASE.name) continue;
    if (cell.checksums.size > 1) {
      cell.mark = '!';
      notes.push(
        `${cell.fixture} ${cell.case}: ${cell.lib.name} ${cell.lib.version()} gave different answers in different processes.`
      );
      continue;
    }
    if (cell.lib === reference) continue;
    const refCell = find(cell.fixture, cell.case, reference);
    if (refCell.checksums.size !== 1) continue;
    const diff = compareAnswers(
      JSON.parse([...refCell.checksums][0]),
      JSON.parse([...cell.checksums][0])
    );
    if (!diff.different && !diff.equivalent) continue;
    const c = CASES.find((x) => x.name === cell.case);
    const unit = c.unit || 'queries';
    const who = `${cell.fixture} ${cell.case}: ${cell.lib.name} ${cell.lib.version()}`;
    if (diff.different) {
      cell.mark = '!';
      notes.push(
        `${who} differs from ${reference.name} on ${diff.different} of ${diff.total} ${unit}${cell.lib.differs && cell.lib.differs[cell.case] ? ` (${cell.lib.differs[cell.case]})` : ''}.`
      );
    }
    if (diff.equivalent) {
      cell.mark = cell.mark || '*';
      notes.push(
        `${who} gives a different answer that is also right on ${diff.equivalent} of ${diff.total} ${unit}: ${c.equivalent}.`
      );
    }
  }

  const infos = Object.fromEntries(fixtures.map((f) => [f, fixtureInfo(f)]));
  const format = (cell) =>
    cell.case === MEMORY_CASE.name
      ? formatBytes(cell.median)
      : formatTime(cell.median);

  for (const fixture of fixtures) {
    const info = infos[fixture];
    const rows = [
      [
        `${fixture} (${formatBytes(info.bytes)}, ${info.segments.toLocaleString('en-US')} segments)`,
        ...libs.map((l) => l.id),
      ],
    ];
    for (const c of cases) {
      const refCell = find(fixture, c.name, reference);
      rows.push([
        `  ${c.name}`,
        ...libs.map((lib) => {
          const cell = find(fixture, c.name, lib);
          const text =
            lib === reference
              ? format(cell)
              : `${format(cell)} ${ratio(cell.median, refCell.median)}`;
          return text + (cell.mark || ' ');
        }),
      ]);
    }
    printTable(rows);
    console.log('');
  }

  console.log(
    `Median of ${runs} processes per cell (${Math.min(runs, MEMORY_RUNS)} for memory). Lower is better; the ratio is relative to ${reference.id}.`
  );
  if (notes.length) {
    console.log(
      `Answers checked against ${reference.id}: * other answers that are also right, ! different answers.`
    );
  }
  for (const note of notes) console.log(`  ${note}`);
  console.log(
    `${formatDuration(duration)} · load average ${loadBefore.toFixed(2)} → ${os.loadavg()[0].toFixed(2)}`
  );

  if (opts.markdown) {
    fs.writeFileSync(
      opts.markdown,
      markdown({ infos, find, notes, node, cpu, format })
    );
    console.log(`Wrote ${opts.markdown}`);
  }

  if (opts.json) {
    fs.writeFileSync(
      opts.json,
      JSON.stringify(
        {
          node,
          cpu,
          date: new Date().toISOString(),
          libs: libs.map((l) => ({
            id: l.id,
            name: l.name,
            version: libVersion(l),
          })),
          runs,
          time: Number(opts.time),
          warmup: Number(opts.warmup),
          cells: cells.map((c) => ({
            fixture: c.fixture,
            case: c.case,
            lib: c.lib.id,
            values: c.values,
          })),
          notes,
        },
        null,
        2
      ) + '\n'
    );
  }
}

// --- Markdown -----------------------------------------------------------------

function markdown({ infos, find, notes, node, cpu, format }) {
  // Numbers are right-aligned; text tables pass numeric = false.
  const table = (header, rows, numeric = true) =>
    [
      `| ${header.join(' | ')} |`,
      `| ${header.map((_, i) => (i > 0 && numeric ? '--:' : '---')).join(' | ')} |`,
      ...rows.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n');
  const date = new Date().toISOString().slice(0, 10);
  // The options that change the results, not where they're written.
  const command = [
    'pnpm bench:compare',
    ...Object.keys(DEFAULTS)
      .filter((name) => opts[name] !== DEFAULTS[name])
      .map((name) => `--${name} ${opts[name]}`),
    '--markdown benchmarks/RESULTS.md',
  ];
  const out = [];
  out.push('# Comparison with other libraries');
  out.push('');
  out.push(
    `<!-- Generated by benchmarks/compare.js. Don't edit by hand: rerun it with --markdown benchmarks/RESULTS.md. -->`
  );
  out.push('');
  out.push(
    `Measured on ${date} with Node ${node} on ${/^Apple/.test(cpu) ? 'an ' : ''}${cpu}. Each time is the median of ${runs} processes, each running the case for at least ${opts.time} ms after a ${opts.warmup} ms warm-up; memory is the median of ${Math.min(runs, MEMORY_RUNS)} processes. Lower is better. The ratio in each cell is relative to ${reference.name}. [How it's measured](README.md#comparison).`
  );
  out.push('');
  out.push(
    table(
      ['Library', 'Version', 'Notes'],
      libs.map((l) => [
        l.name,
        libVersion(l),
        l === reference && l.id === 'smjs' ? 'This repo.' : l.note || '',
      ]),
      false
    )
  );
  out.push('');
  out.push('## Cases');
  out.push('');
  out.push(
    table(
      ['Case', 'What it measures'],
      cases.map((c) => [`\`${c.name}\``, c.description]),
      false
    )
  );
  for (const fixture of fixtures) {
    const info = infos[fixture];
    out.push('');
    out.push(`## ${fixture}`);
    out.push('');
    out.push(
      `${formatBytes(info.bytes)}, ${info.segments.toLocaleString('en-US')} segments, ${info.sources.toLocaleString('en-US')} sources.`
    );
    out.push('');
    out.push(
      table(
        ['Case', ...libs.map(shortName)],
        cases.map((c) => {
          const refCell = find(fixture, c.name, reference);
          return [
            `\`${c.name}\``,
            ...libs.map((lib) => {
              const cell = find(fixture, c.name, lib);
              const mark = cell.mark ? ` ${cell.mark}` : '';
              return lib === reference
                ? `${format(cell)}${mark}`
                : `${format(cell)} (${ratio(cell.median, refCell.median)})${mark}`;
            }),
          ];
        })
      )
    );
  }
  if (notes.length) {
    out.push('');
    out.push('## Differences in answers');
    out.push('');
    out.push(
      `Every case's answers are checked against ${reference.name}'s. \`*\` marks a cell where a library gave other answers that are also right, \`!\` one where it gave different answers.`
    );
    out.push('');
    for (const note of notes) out.push(`- ${note}`);
  }
  out.push('');
  out.push(`Command: \`${command.join(' ')}\``);
  out.push('');
  return out.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
