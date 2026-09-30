/* eslint-env node */

import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';
import Benchmark from 'benchmark';
import { decode } from '@jridgewell/sourcemap-codec';
import {
  TraceMap,
  traceSegment,
  generatedPositionFor as traceMappingGeneratedPositionFor,
} from '@jridgewell/trace-mapping';
import currentSourceMap from '../../source-map.js';
import { SourceMapConsumer as SourceMapConsumerJsLatest } from 'source-map-js-latest';
import { SourceMapConsumer as SourceMapConsumer061 } from 'source-map';
import { SourceMapConsumer as SourceMapConsumerWasm } from 'source-map-wasm';
import { SourceMap as ChromeMap } from './chrome.mjs';
import { SourceMap as ChromeMap2026 } from './chrome-2026.mjs';

const { SourceMapConsumer: CurrentSourceMapConsumer } = currentSourceMap;

const dir = relative(process.cwd(), join(dirname(fileURLToPath(import.meta.url)), 'fixtures'));
const { DIFF, FILE, SOLO, PHASES } = process.env;

// SOLO=1: only benchmark `source-map-js current` (skip every third-party
// case). bench-delta.js only diffs that label across two runs, so the rest is
// pure runtime tax for bench-diff.sh.
//
// PHASES=key1,key2: only run the named Benchmark.Suite phases. Keys:
//   init, trace-random, trace-ascending, genpos-init, genpos-speed,
//   eachmapping-generated, eachmapping-original
// Default (unset) runs all phases.
const phasesSet = PHASES ? new Set(PHASES.split(',').map((s) => s.trim())) : null;
const phaseEnabled = (key) => !phasesSet || phasesSet.has(key);

console.log(`node ${process.version}\n`);

async function track(label, results, cb) {
  if (global.gc) global.gc();
  const before = process.memoryUsage();
  const ret = await cb();
  const after = process.memoryUsage();
  const d = delta(before, after);
  console.log(
    `${label.padEnd(25, ' ')} ${String(d.heapUsed + d.external).padStart(10, ' ')} bytes`,
  );
  results.push({ label, delta: d.heapUsed + d.external });
  return ret;
}

function delta(before, after) {
  return {
    rss: after.rss - before.rss,
    heapTotal: after.heapTotal - before.heapTotal,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

async function bench(file) {
  const map = JSON.parse(readFileSync(join(dir, file)));
  const encodedMapData = map;
  const encodedMapDataJson = JSON.stringify(map);
  const decodedMapData = { ...map, mappings: decode(map.mappings) };
  const decodedMapDataJson = JSON.stringify(decodedMapData);

  const lines = decodedMapData.mappings;
  const segments = lines.reduce((cur, line) => {
    return cur + line.length;
  }, 0);
  console.log(file, `- ${segments} segments`);
  console.log('');

  console.log('Memory Usage:');
  const results = [];
  let benchmark, smcjsCurrent, smcjsLatest, smc061, smcWasm, traceMap, chromeMap, chromeMap2026;

  smcjsCurrent = await track('source-map-js current', results, () => {
    const smc = new CurrentSourceMapConsumer(encodedMapData);
    smc.originalPositionFor({ line: 1, column: 0 });
    return smc;
  });
  const firstSource = smcjsCurrent.sources[0];
  smcjsCurrent.generatedPositionFor({ source: firstSource, line: 1, column: 0 });

  if (SOLO) {
    // skip all comparison libraries
  } else if (DIFF) {
    smcjsLatest = await track('source-map-js latest', results, () => {
      const smc = new SourceMapConsumerJsLatest(encodedMapData);
      smc.originalPositionFor({ line: 1, column: 0 });
      smc.generatedPositionFor({ source: firstSource, line: 1, column: 0 });
      return smc;
    });
  } else {
    traceMap = await track('trace-mapping', results, () => {
      const tm = new TraceMap(encodedMapData);
      traceSegment(tm, 0, 0);
      traceMappingGeneratedPositionFor(tm, { source: firstSource, line: 1, column: 0 });
      return tm;
    });
    smc061 = await track('source-map-0.6.1', results, () => {
      const smc = new SourceMapConsumer061(encodedMapData);
      smc.originalPositionFor({ line: 1, column: 0 });
      smc.generatedPositionFor({ source: firstSource, line: 1, column: 0 });
      return smc;
    });
    smcWasm = await track('source-map-0.8.0', results, async () => {
      const smc = await new SourceMapConsumerWasm(encodedMapData);
      smc.originalPositionFor({ line: 1, column: 0 });
      smc.generatedPositionFor({ source: firstSource, line: 1, column: 0 });
      return smc;
    });
    chromeMap = await track('Chrome dev tools', results, async () => {
      const cm = new ChromeMap('url', encodedMapData);
      cm.findEntry(0, 0);
      const fs0 = cm.sources()[0];
      cm.findEntryReversed(fs0, 6);
      return cm;
    });
    chromeMap2026 = await track('Chrome dev tools 2026', results, async () => {
      const cm = new ChromeMap2026('url', encodedMapData);
      cm.findEntry(0, 0);
      const fs0 = cm.sources()[0];
      cm.findEntryReversed(fs0, 6);
      return cm;
    });
  }

  const winner = results.reduce((min, cur) => {
    if (cur.delta < min.delta) return cur;
    return min;
  });
  console.log(`Smallest memory usage is ${winner.label}`);

  console.log('');

  if (phaseEnabled('init')) {
    console.log('Init speed:');
    benchmark = new Benchmark.Suite()
      .add('source-map-js current: encoded JSON input', () => {
        new CurrentSourceMapConsumer(encodedMapDataJson).originalPositionFor({ line: 1, column: 0 });
      })
      .add('source-map-js current: encoded Object input', () => {
        new CurrentSourceMapConsumer(encodedMapData).originalPositionFor({ line: 1, column: 0 });
      });
    if (SOLO) {
      // only source-map-js current
    } else if (DIFF) {
      benchmark = benchmark
        .add('source-map-js latest:  encoded JSON input', () => {
          new SourceMapConsumerJsLatest(encodedMapDataJson).originalPositionFor({ line: 1, column: 0 });
        })
        .add('source-map-js latest:  encoded Object input', () => {
          new SourceMapConsumerJsLatest(encodedMapData).originalPositionFor({ line: 1, column: 0 });
        });
    } else {
      benchmark = benchmark
        .add('trace-mapping:    decoded JSON input', () => {
          traceSegment(new TraceMap(decodedMapDataJson), 0, 0);
        })
        .add('trace-mapping:    encoded JSON input', () => {
          traceSegment(new TraceMap(encodedMapDataJson), 0, 0);
        })
        .add('trace-mapping:    decoded Object input', () => {
          traceSegment(new TraceMap(decodedMapData), 0, 0);
        })
        .add('trace-mapping:    encoded Object input', () => {
          traceSegment(new TraceMap(encodedMapData), 0, 0);
        })
        .add('source-map-0.6.1: encoded Object input', () => {
          new SourceMapConsumer061(encodedMapData).originalPositionFor({ line: 1, column: 0 });
        })
        .add('Chrome dev tools: encoded Object input', () => {
          new ChromeMap('url', encodedMapData).findEntry(0, 0);
        })
        .add('Chrome dev tools 2026: encoded Object input', () => {
          new ChromeMap2026('url', encodedMapData).findEntry(0, 0);
        });
      // WASM isn't tested in init because its async and OOMs.
      // .add('source-map-0.8.0: encoded Object input', () => { })
    }
    benchmark
      .on('error', (event) => console.error(event.target.error))
      .on('cycle', (event) => {
        console.log(String(event.target));
      })
      .on('complete', function () {
        console.log('Fastest is ' + this.filter('fastest').map('name'));
      })
      .run({});

    console.log('');
  }

  if (phaseEnabled('trace-random')) {
  console.log('Trace speed (random):');
  benchmark = new Benchmark.Suite()
    .add('source-map-js current: encoded originalPositionFor', () => {
      const i = Math.floor(Math.random() * lines.length);
      const line = lines[i];
      if (line.length === 0) return;
      const shift = Math.ceil(line.length / 100);
      for (let _ = 0; _ < line.length; _ += shift) {
        const j = Math.floor(Math.random() * line.length);
        const column = line[j][0];
        smcjsCurrent.originalPositionFor({ line: i + 1, column });
      }
    });
  if (SOLO) {
    // only source-map-js current
  } else if (DIFF) {
    benchmark = benchmark.add('source-map-js latest: encoded originalPositionFor', () => {
      const i = Math.floor(Math.random() * lines.length);
      const line = lines[i];
      if (line.length === 0) return;
      const shift = Math.ceil(line.length / 100);
      for (let _ = 0; _ < line.length; _ += shift) {
        const j = Math.floor(Math.random() * line.length);
        const column = line[j][0];
        smcjsLatest.originalPositionFor({ line: i + 1, column });
      }
    });
  } else {
    benchmark = benchmark
      .add('trace-mapping:    encoded traceSegment', () => {
        const i = Math.floor(Math.random() * lines.length);
        const line = lines[i];
        if (line.length === 0) return;
        const shift = Math.ceil(line.length / 100);
        for (let _ = 0; _ < line.length; _ += shift) {
          const j = Math.floor(Math.random() * line.length);
          const column = line[j][0];
          traceSegment(traceMap, i, column);
        }
      })
      .add('source-map-0.6.1: encoded originalPositionFor', () => {
        const i = Math.floor(Math.random() * lines.length);
        const line = lines[i];
        if (line.length === 0) return;
        const shift = Math.ceil(line.length / 100);
        for (let _ = 0; _ < line.length; _ += shift) {
          const j = Math.floor(Math.random() * line.length);
          const column = line[j][0];
          smc061.originalPositionFor({ line: i + 1, column });
        }
      })
      .add('source-map-0.8.0: encoded originalPositionFor', () => {
        const i = Math.floor(Math.random() * lines.length);
        const line = lines[i];
        if (line.length === 0) return;
        const shift = Math.ceil(line.length / 100);
        for (let _ = 0; _ < line.length; _ += shift) {
          const j = Math.floor(Math.random() * line.length);
          const column = line[j][0];
          smcWasm.originalPositionFor({ line: i + 1, column });
        }
      })
      .add('Chrome dev tools: encoded findEntry', () => {
        const i = Math.floor(Math.random() * lines.length);
        const line = lines[i];
        if (line.length === 0) return;
        const shift = Math.ceil(line.length / 100);
        for (let _ = 0; _ < line.length; _ += shift) {
          const j = Math.floor(Math.random() * line.length);
          const column = line[j][0];
          chromeMap.findEntry(i, column);
        }
      })
      .add('Chrome dev tools 2026: encoded findEntry', () => {
        const i = Math.floor(Math.random() * lines.length);
        const line = lines[i];
        if (line.length === 0) return;
        const shift = Math.ceil(line.length / 100);
        for (let _ = 0; _ < line.length; _ += shift) {
          const j = Math.floor(Math.random() * line.length);
          const column = line[j][0];
          chromeMap2026.findEntry(i, column);
        }
      });
  }
  benchmark
    .on('error', (event) => console.error(event.target.error))
    .on('cycle', (event) => {
      console.log(String(event.target));
    })
    .on('complete', function () {
      console.log('Fastest is ' + this.filter('fastest').map('name'));
    })
    .run({});

  console.log('');
  }

  if (phaseEnabled('trace-ascending')) {
  console.log('Trace speed (ascending):');
  benchmark = new Benchmark.Suite()
    .add('source-map-js current: encoded originalPositionFor', () => {
      const i = Math.floor(Math.random() * lines.length);
      const line = lines[i];
      if (line.length === 0) return;
      const shift = Math.ceil(line.length / 100);
      for (let j = 0; j < line.length; j += shift) {
        const column = line[j][0];
        smcjsCurrent.originalPositionFor({ line: i + 1, column });
      }
    });
  if (SOLO) {
    // only source-map-js current
  } else if (DIFF) {
    benchmark = benchmark.add('source-map-js latest: encoded originalPositionFor', () => {
      const i = Math.floor(Math.random() * lines.length);
      const line = lines[i];
      if (line.length === 0) return;
      const shift = Math.ceil(line.length / 100);
      for (let j = 0; j < line.length; j += shift) {
        const column = line[j][0];
        smcjsLatest.originalPositionFor({ line: i + 1, column });
      }
    });
  } else {
    benchmark = benchmark
      .add('trace-mapping:    encoded traceSegment', () => {
        const i = Math.floor(Math.random() * lines.length);
        const line = lines[i];
        if (line.length === 0) return;
        const shift = Math.ceil(line.length / 100);
        for (let j = 0; j < line.length; j += shift) {
          const column = line[j][0];
          traceSegment(traceMap, i, column);
        }
      })
      .add('source-map-0.6.1: encoded originalPositionFor', () => {
        const i = Math.floor(Math.random() * lines.length);
        const line = lines[i];
        if (line.length === 0) return;
        const shift = Math.ceil(line.length / 100);
        for (let j = 0; j < line.length; j += shift) {
          const column = line[j][0];
          smc061.originalPositionFor({ line: i + 1, column });
        }
      })
      .add('source-map-0.8.0: encoded originalPositionFor', () => {
        const i = Math.floor(Math.random() * lines.length);
        const line = lines[i];
        if (line.length === 0) return;
        const shift = Math.ceil(line.length / 100);
        for (let j = 0; j < line.length; j += shift) {
          const column = line[j][0];
          smcWasm.originalPositionFor({ line: i + 1, column });
        }
      })
      .add('Chrome dev tools: encoded findEntry', () => {
        const i = Math.floor(Math.random() * lines.length);
        const line = lines[i];
        if (line.length === 0) return;
        const shift = Math.ceil(line.length / 100);
        for (let j = 0; j < line.length; j += shift) {
          const column = line[j][0];
          chromeMap.findEntry(i, column);
        }
      })
      .add('Chrome dev tools 2026: encoded findEntry', () => {
        const i = Math.floor(Math.random() * lines.length);
        const line = lines[i];
        if (line.length === 0) return;
        const shift = Math.ceil(line.length / 100);
        for (let j = 0; j < line.length; j += shift) {
          const column = line[j][0];
          chromeMap2026.findEntry(i, column);
        }
      });
  }
  benchmark
    .on('error', (event) => console.error(event.target.error))
    .on('cycle', (event) => {
      console.log(String(event.target));
    })
    .on('complete', function () {
      console.log('Fastest is ' + this.filter('fastest').map('name'));
    })
    .run({});

  console.log('');
  }

  if (phaseEnabled('genpos-init')) {
  console.log('Generated Positions init:');
  benchmark = new Benchmark.Suite()
    .add('source-map-js current: encoded generatedPositionFor', () => {
      const smc = new CurrentSourceMapConsumer(encodedMapData);
      smc.generatedPositionFor({ source: firstSource, line: 6, column: 0 });
    });
  if (SOLO) {
    // only source-map-js current
  } else if (DIFF) {
    benchmark = benchmark.add('source-map-js latest: encoded generatedPositionFor', () => {
      const smc = new SourceMapConsumerJsLatest(encodedMapData);
      smc.generatedPositionFor({ source: firstSource, line: 6, column: 0 });
    });
  } else {
    benchmark = benchmark
      .add('trace-mapping:    encoded generatedPositionFor', () => {
        const tm = new TraceMap(encodedMapData);
        traceMappingGeneratedPositionFor(tm, { source: firstSource, line: 6, column: 0 });
      })
      .add('source-map-0.6.1: encoded generatedPositionFor', () => {
        const smc = new SourceMapConsumer061(encodedMapData);
        smc.generatedPositionFor({ source: firstSource, line: 6, column: 0 });
      })
      .add('source-map-0.8.0: encoded generatedPositionFor', () => {
        smcWasm.destroy();
        smcWasm.generatedPositionFor({ source: firstSource, line: 6, column: 0 });
      })
      .add('Chrome dev tools: encoded findEntryReversed', () => {
        const cm = new ChromeMap('url', encodedMapData);
        const fs0 = cm.sources()[0];
        cm.findEntryReversed(fs0, 6);
      })
      .add('Chrome dev tools 2026: encoded findEntryReversed', () => {
        const cm = new ChromeMap2026('url', encodedMapData);
        const fs0 = cm.sources()[0];
        cm.findEntryReversed(fs0, 6);
      });
  }
  benchmark
    .on('error', (event) => console.error(event.target.error))
    .on('cycle', (event) => {
      console.log(String(event.target));
    })
    .on('complete', function () {
      console.log('Fastest is ' + this.filter('fastest').map('name'));
    })
    .run({});

  console.log('');
  }

  if (phaseEnabled('genpos-speed')) {
  console.log('Generated Positions speed:');
  benchmark = new Benchmark.Suite()
    .add('source-map-js current: encoded generatedPositionFor', () => {
      for (const source of smcjsCurrent.sources) {
        smcjsCurrent.generatedPositionFor({ source, line: 6, column: 0 });
      }
    });
  if (SOLO) {
    // only source-map-js current
  } else if (DIFF) {
    benchmark = benchmark.add('source-map-js latest: encoded generatedPositionFor', () => {
      for (const source of smcjsLatest.sources) {
        smcjsLatest.generatedPositionFor({ source, line: 6, column: 0 });
      }
    });
  } else {
    benchmark = benchmark
      .add('trace-mapping:    encoded generatedPositionFor', () => {
        for (const source of traceMap.sources) {
          traceMappingGeneratedPositionFor(traceMap, { source, line: 6, column: 0 });
        }
      })
      .add('source-map-0.6.1: encoded generatedPositionFor', () => {
        for (const source of smc061.sources) {
          smc061.generatedPositionFor({ source, line: 6, column: 0 });
        }
      })
      .add('source-map-0.8.0: encoded generatedPositionFor', () => {
        for (const source of smcWasm.sources) {
          smcWasm.generatedPositionFor({ source, line: 6, column: 0 });
        }
      })
      .add('Chrome dev tools: encoded findEntryReversed', () => {
        for (const source of chromeMap.sources()) {
          chromeMap.findEntryReversed(source, 6);
        }
      })
      .add('Chrome dev tools 2026: encoded findEntryReversed', () => {
        for (const source of chromeMap2026.sources()) {
          chromeMap2026.findEntryReversed(source, 6);
        }
      });
  }
  benchmark
    .on('error', (event) => console.error(event.target.error))
    .on('cycle', (event) => {
      console.log(String(event.target));
    })
    .on('complete', function () {
      console.log('Fastest is ' + this.filter('fastest').map('name'));
    })
    .run({});
  }

  // eachMapping phases iterate every parsed mapping and run a no-op callback,
  // measuring per-mapping iteration cost (source URL resolution + name lookup
  // + result-object construction). Pre-built `_generatedMappings` and
  // `_originalMappings` from the Memory Usage / Init / Generated Positions
  // calls above carry over, so the build cost isn't included.
  const NOOP = () => {};

  if (phaseEnabled('eachmapping-generated')) {
  console.log('eachMapping speed (generated order):');
  benchmark = new Benchmark.Suite()
    .add('source-map-js current: encoded eachMapping', () => {
      smcjsCurrent.eachMapping(NOOP);
    });
  if (SOLO) {
    // only source-map-js current
  } else if (DIFF) {
    benchmark = benchmark.add('source-map-js latest: encoded eachMapping', () => {
      smcjsLatest.eachMapping(NOOP);
    });
  } else {
    benchmark = benchmark
      .add('source-map-0.6.1: encoded eachMapping', () => {
        smc061.eachMapping(NOOP);
      });
  }
  benchmark
    .on('error', (event) => console.error(event.target.error))
    .on('cycle', (event) => {
      console.log(String(event.target));
    })
    .on('complete', function () {
      console.log('Fastest is ' + this.filter('fastest').map('name'));
    })
    .run({});

  console.log('');
  }

  if (phaseEnabled('eachmapping-original')) {
  console.log('eachMapping speed (original order):');
  const ORIG = CurrentSourceMapConsumer.ORIGINAL_ORDER;
  benchmark = new Benchmark.Suite()
    .add('source-map-js current: encoded eachMapping', () => {
      smcjsCurrent.eachMapping(NOOP, null, ORIG);
    });
  if (SOLO) {
    // only source-map-js current
  } else if (DIFF) {
    benchmark = benchmark.add('source-map-js latest: encoded eachMapping', () => {
      smcjsLatest.eachMapping(NOOP, null, SourceMapConsumerJsLatest.ORIGINAL_ORDER);
    });
  } else {
    benchmark = benchmark
      .add('source-map-0.6.1: encoded eachMapping', () => {
        smc061.eachMapping(NOOP, null, SourceMapConsumer061.ORIGINAL_ORDER);
      });
  }
  benchmark
    .on('error', (event) => console.error(event.target.error))
    .on('cycle', (event) => {
      console.log(String(event.target));
    })
    .on('complete', function () {
      console.log('Fastest is ' + this.filter('fastest').map('name'));
    })
    .run({});
  }

  if (smcWasm) smcWasm.destroy();
}

async function run(files) {
  let first = true;
  for (const file of files) {
    if (!file.endsWith('.map')) continue;
    if (FILE && file !== FILE) continue;

    if (!first) console.log('\n\n***\n\n');
    first = false;

    await bench(file);
  }
}
run(readdirSync(dir));
