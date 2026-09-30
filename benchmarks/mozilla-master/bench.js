function noop() {}

if (typeof console === "undefined") {
  console = {};
}
if (!console.time) {
  console.time = console.timeEnd = noop;
}
if (!console.profile) {
  console.profile = console.profileEnd = noop;
}

// Ensure that benchmarks don't get optimized away by calling this blackbox
// function in your benchmark's action.
var __benchmarkResults = [];
var benchmarkBlackbox = [].push.bind(__benchmarkResults);

const now =
  typeof window === "object" && window.performance && window.performance.now
    ? () => window.performance.now()
    : () => now();

const yieldForTick =
  typeof setTimeout === "function" ? () => new Promise(resolve => setTimeout(resolve, 1)) : () => Promise.resolve();

// Benchmark running an action n times.
async function benchmark(setup, action, tearDown = () => {}) {
  __benchmarkResults = [];

  console.time("setup");
  await setup();
  console.timeEnd("setup");

  // Warm up the JIT.
  console.time("warmup");
  for (let i = 0; i < WARM_UP_ITERATIONS; i++) {
    await action();
    await yieldForTick();
  }
  console.timeEnd("warmup");

  const stats = new Stats("ms");

  for (let i = 0; i < BENCH_ITERATIONS; i++) {
    console.time("iteration");
    const thisIterationStart = now();
    await action();
    stats.take(now() - thisIterationStart);
    console.timeEnd("iteration");

    await yieldForTick();
  }

  await tearDown();
  return stats;
}

async function getTestMapping() {
  let smc = new sourceMap.SourceMapConsumer(testSourceMap);

  let mappings = [];
  smc.eachMapping((mapping) => {mappings.push(mapping)}, mappings, sourceMap.SourceMapConsumer.ORIGINAL_ORDER);

  let testMapping = mappings[Math.floor(mappings.length / 13)];
  return testMapping;
}

var benchmarks = {
  "SourceMapGenerator#toString": {
    description: "Measures the performance of generating a final source map string, which involves encoding mappings into VLQ format.",
    run: () => {
    let smg;
    return benchmark(
      async function() {
        var smc = new sourceMap.SourceMapConsumer(testSourceMap);
        smg = sourceMap.SourceMapGenerator.fromSourceMap(smc);
      },
      () => {
        benchmarkBlackbox(smg.toString().length);
      }
    );
  }},

  "set.first.breakpoint": {
    description: "Measures the 'cold' performance of finding generated positions for an original source location (typical when a user first opens a file and sets a breakpoint).",
    run: () => {
    let testMapping;
    return benchmark(
      async function() {
        testMapping = await getTestMapping();
      },
      async function() {
        let smc = new sourceMap.SourceMapConsumer(testSourceMap);

        benchmarkBlackbox(
          smc.allGeneratedPositionsFor({
            source: testMapping.source,
            line: testMapping.originalLine
          }).length
        );

      }
    );
  }},

  "first.pause.at.exception": {
    description: "Measures 'cold' performance for mapping a generated location back to source (typical when a debugger stops at an exception).",
    run: () => {
    let testMapping;
    return benchmark(
      async function() {
        testMapping = await getTestMapping();
      },
      async function() {
        let smc = new sourceMap.SourceMapConsumer(testSourceMap);

        benchmarkBlackbox(
          smc.originalPositionFor({
            line: testMapping.generatedLine,
            column: testMapping.generatedColumn
          })
        );

      }
    );
  }},

  "subsequent.setting.breakpoints": {
    description: "Measures 'warm' performance for finding generated positions, where the consumer's internal caches/indexes are already built.",
    run: () => {
    let testMapping;
    let smc;
    return benchmark(
      async function() {
        testMapping = await getTestMapping();
        smc = new sourceMap.SourceMapConsumer(testSourceMap);
      },
      async function() {
        benchmarkBlackbox(
          smc.allGeneratedPositionsFor({
            source: testMapping.source,
            line: testMapping.originalLine
          })
        );
      },
      function() {
      }
    );
  }},

  "subsequent.pausing.at.exceptions": {
    description: "Measures 'warm' performance for mapping generated locations back to source.",
    run: () => {
    let testMapping;
    let smc;
    return benchmark(
      async function() {
        testMapping = await getTestMapping();
        smc = new sourceMap.SourceMapConsumer(testSourceMap);
      },
      async function() {
        benchmarkBlackbox(
          smc.originalPositionFor({
            line: testMapping.generatedLine,
            column: testMapping.generatedColumn
          })
        );
      },
      function() {
      }
    );
  }},

  "parse.and.iterate": {
    description: "Measures the combined overhead of parsing a source map and exhaustively iterating over all mappings.",
    run: () => {
    return benchmark(noop, async function() {
      const smc = new sourceMap.SourceMapConsumer(testSourceMap);

      let maxLine = 0;
      let maxCol = 0;
      smc.eachMapping(m => {
        maxLine = Math.max(maxLine, m.generatedLine);
        maxLine = Math.max(maxLine, m.originalLine);
        maxCol = Math.max(maxCol, m.generatedColumn);
        maxCol = Math.max(maxCol, m.originalColumn);
      });
      benchmarkBlackbox(maxLine);
      benchmarkBlackbox(maxCol);

    });
  }},

  "iterate.already.parsed": {
    description: "Measures the raw speed of the mapping iterator on a consumer that has already been initialized.",
    run: () => {
    let smc;
    return benchmark(
      async function() {
        smc = new sourceMap.SourceMapConsumer(testSourceMap);
      },
      async function() {
        let maxLine = 0;
        let maxCol = 0;
        smc.eachMapping(m => {
          maxLine = Math.max(maxLine, m.generatedLine);
          maxLine = Math.max(maxLine, m.originalLine);
          maxCol = Math.max(maxCol, m.generatedColumn);
          maxCol = Math.max(maxCol, m.originalColumn);
        });
        benchmarkBlackbox(maxLine);
        benchmarkBlackbox(maxCol);
      },
      function() {
      }
    );
  }}
};
