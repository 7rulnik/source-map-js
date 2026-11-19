'use strict';

// Runs one case on one fixture against one library and prints the result as a
// JSON line. The drivers spawn one worker per measurement, so each one starts
// from a fresh V8: no JIT state, heap or inline caches carry over from other
// cases or from other libraries.
//
//   node --expose-gc benchmarks/worker.js <suite> <lib> <fixture> <case> <time-ms> <warmup-ms>
//
// <suite> is the module with the cases: `cases` (before/after, where <lib> is
// a path to source-map.js) or `compare-cases` (where <lib> is an id from
// libs.js).

const { loadFixture } = require('./fixtures');

// Every measurement covers at least this many runs, however long they take.
const MIN_RUNS = 2;

const SUITES = ['cases', 'compare-cases'];

const now = process.hrtime.bigint;
const ms = (n) => BigInt(Math.round(Number(n) * 1e6));

// Two copies of the same loop, so the synchronous one doesn't pay for an
// await per run.
function timeSync(run, timeMs, warmupMs) {
  let sink = 0;
  const warmupEnd = now() + ms(warmupMs);
  do {
    sink = (sink + run()) | 0;
  } while (now() < warmupEnd);
  if (global.gc) global.gc();

  const budget = ms(timeMs);
  let runs = 0;
  let elapsed;
  const start = now();
  do {
    sink = (sink + run()) | 0;
    runs++;
    elapsed = now() - start;
  } while (elapsed < budget || runs < MIN_RUNS);
  return { ns: Number(elapsed) / runs, runs, sink };
}

async function timeAsync(run, timeMs, warmupMs) {
  let sink = 0;
  const warmupEnd = now() + ms(warmupMs);
  do {
    sink = (sink + (await run())) | 0;
  } while (now() < warmupEnd);
  if (global.gc) global.gc();

  const budget = ms(timeMs);
  let runs = 0;
  let elapsed;
  const start = now();
  do {
    sink = (sink + (await run())) | 0;
    runs++;
    elapsed = now() - start;
  } while (elapsed < budget || runs < MIN_RUNS);
  return { ns: Number(elapsed) / runs, runs, sink };
}

async function main() {
  const [suiteName, libName, fixtureName, caseName, timeMs, warmupMs] =
    process.argv.slice(2);
  if (!SUITES.includes(suiteName))
    throw new Error(`Unknown suite ${suiteName}`);
  const suite = require(`./${suiteName}`);

  const benchCase = suite.CASES.find((c) => c.name === caseName);
  if (!benchCase) throw new Error(`Unknown case ${caseName}`);

  const lib = suite.load(libName);
  const fixture = loadFixture(fixtureName);
  const {
    run,
    checksum = run,
    async = false,
  } = await benchCase.setup(lib, fixture);

  const check = await checksum();

  const { ns, runs, sink } = async
    ? await timeAsync(run, timeMs, warmupMs)
    : timeSync(run, timeMs, warmupMs);

  process.stdout.write(
    JSON.stringify({
      ns,
      runs,
      checksum: check,
      sink,
    }) + '\n'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
