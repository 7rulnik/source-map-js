/* eslint-env node */

import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';
import Benchmark from 'benchmark';
import { decode } from '@jridgewell/sourcemap-codec';
import {
  GenMapping,
  addSegment,
  addMapping,
  toEncodedMap,
  toDecodedMap,
} from '@jridgewell/gen-mapping';
import currentSourceMap from '../source-map.js';
import { SourceMapGenerator as SourceMapGeneratorJsLatest } from 'source-map-js-latest';
import { SourceMapGenerator as SourceMapGenerator061 } from 'source-map';
import { SourceMapGenerator as SourceMapGeneratorWasm } from 'source-map-wasm';

const { SourceMapGenerator: CurrentSourceMapGenerator } = currentSourceMap;

const dir = relative(process.cwd(), join(dirname(fileURLToPath(import.meta.url)), 'fixtures'));
const { DIFF, FILE } = process.env;

console.log(`node ${process.version}\n`);

function track(label, results, cb) {
  let ret;
  const deltas = [];
  for (let i = 0; i < 10; i++) {
    ret = null;
    if (global.gc) for (let i = 0; i < 3; i++) global.gc();
    const before = process.memoryUsage();
    ret = cb();
    const after = process.memoryUsage();
    deltas.push(delta(before, after));
  }
  const a = avg(deltas);
  console.log(`${label.padEnd(25, ' ')} ${String(a.heapUsed).padStart(10, ' ')} bytes`);
  results.push({ label, delta: a.heapUsed });
  return ret;
}

function avg(deltas) {
  let rss = 0;
  let heapTotal = 0;
  let heapUsed = 0;
  let external = 0;
  let arrayBuffers = 0;
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    rss += d.rss / deltas.length;
    heapTotal += d.heapTotal / deltas.length;
    heapUsed += d.heapUsed / deltas.length;
    external += d.external / deltas.length;
    arrayBuffers += d.arrayBuffers / deltas.length;
  }
  return {
    rss: Math.floor(rss),
    heapTotal: Math.floor(heapTotal),
    heapUsed: Math.floor(heapUsed),
    external: Math.floor(external),
    arrayBuffers: Math.floor(arrayBuffers),
  };
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

function buildSourceMapJsGenerator(Ctor, mappings, sources, names) {
  const map = new Ctor();
  for (let i = 0; i < mappings.length; i++) {
    const line = mappings[i];
    for (let j = 0; j < line.length; j++) {
      const seg = line[j];
      const mapping = {
        generated: { line: i + 1, column: seg[0] },
        source: undefined,
        original: undefined,
        name: undefined,
      };
      if (seg.length !== 1) {
        mapping.source = sources[seg[1]];
        mapping.original = { line: seg[2] + 1, column: seg[3] };
        if (seg.length === 5) mapping.name = names[seg[4]];
      }
      map.addMapping(mapping);
    }
  }
  return map;
}

async function bench(file) {
  const map = JSON.parse(readFileSync(join(dir, file)));
  const { sources, names } = map;
  const mappings = decode(map.mappings);

  console.log('Memory Usage:');
  const results = [];

  const smgjsCurrent = track('source-map-js current', results, () => {
    return buildSourceMapJsGenerator(CurrentSourceMapGenerator, mappings, sources, names);
  });

  let genmap, smgjsLatest, smg061, smgWasm;
  if (DIFF) {
    smgjsLatest = track('source-map-js latest', results, () => {
      return buildSourceMapJsGenerator(SourceMapGeneratorJsLatest, mappings, sources, names);
    });
  } else {
    genmap = track('gen-mapping: addSegment', results, () => {
      const map = new GenMapping();
      for (let i = 0; i < mappings.length; i++) {
        const line = mappings[i];
        for (let j = 0; j < line.length; j++) {
          const seg = line[j];
          let source, sourceLine, sourceColumn, name;
          const genColumn = seg[0];
          if (seg.length !== 1) {
            source = sources[seg[1]];
            sourceLine = seg[2];
            sourceColumn = seg[3];
            if (seg.length === 5) name = names[seg[4]];
          }
          addSegment(map, i, genColumn, source, sourceLine, sourceColumn, name);
        }
      }
      return map;
    });
    track('gen-mapping: addMapping', results, () => {
      const map = new GenMapping();
      for (let i = 0; i < mappings.length; i++) {
        const line = mappings[i];
        for (let j = 0; j < line.length; j++) {
          const seg = line[j];
          const mapping = {
            generated: { line: i + 1, column: seg[0] },
            source: undefined,
            original: undefined,
            name: undefined,
          };
          if (seg.length !== 1) {
            mapping.source = sources[seg[1]];
            mapping.original = { line: seg[2] + 1, column: seg[3] };
            if (seg.length === 5) mapping.name = names[seg[4]];
          }
          addMapping(map, mapping);
        }
      }
      return map;
    });
    smg061 = track('source-map-0.6.1', results, () => {
      return buildSourceMapJsGenerator(SourceMapGenerator061, mappings, sources, names);
    });
    smgWasm = track('source-map-0.8.0', results, () => {
      return buildSourceMapJsGenerator(SourceMapGeneratorWasm, mappings, sources, names);
    });
  }

  const winner = results.reduce((min, cur) => {
    if (cur.delta < min.delta) return cur;
    return min;
  });
  console.log(`Smallest memory usage is ${winner.label}`);

  console.log('');

  console.log('Adding speed:');
  let suite = new Benchmark.Suite().add('source-map-js current: addMapping', () => {
    buildSourceMapJsGenerator(CurrentSourceMapGenerator, mappings, sources, names);
  });
  if (DIFF) {
    suite = suite.add('source-map-js latest:  addMapping', () => {
      buildSourceMapJsGenerator(SourceMapGeneratorJsLatest, mappings, sources, names);
    });
  } else {
    suite = suite
      .add('gen-mapping:      addSegment', () => {
        const map = new GenMapping();
        for (let i = 0; i < mappings.length; i++) {
          const line = mappings[i];
          for (let j = 0; j < line.length; j++) {
            const seg = line[j];
            let source, sourceLine, sourceColumn, name;
            const genColumn = seg[0];
            if (seg.length !== 1) {
              source = sources[seg[1]];
              sourceLine = seg[2];
              sourceColumn = seg[3];
              if (seg.length === 5) name = names[seg[4]];
            }
            addSegment(map, i, genColumn, source, sourceLine, sourceColumn, name);
          }
        }
      })
      .add('gen-mapping:      addMapping', () => {
        const map = new GenMapping();
        for (let i = 0; i < mappings.length; i++) {
          const line = mappings[i];
          for (let j = 0; j < line.length; j++) {
            const seg = line[j];
            const mapping = {
              generated: { line: i + 1, column: seg[0] },
              source: undefined,
              original: undefined,
              name: undefined,
            };
            if (seg.length !== 1) {
              mapping.source = sources[seg[1]];
              mapping.original = { line: seg[2] + 1, column: seg[3] };
              if (seg.length === 5) mapping.name = names[seg[4]];
            }
            addMapping(map, mapping);
          }
        }
      })
      .add('source-map-0.6.1: addMapping', () => {
        buildSourceMapJsGenerator(SourceMapGenerator061, mappings, sources, names);
      })
      .add('source-map-0.8.0: addMapping', () => {
        buildSourceMapJsGenerator(SourceMapGeneratorWasm, mappings, sources, names);
      });
  }
  suite
    .on('error', (event) => console.error(event.target.error))
    .on('cycle', (event) => {
      console.log(String(event.target));
    })
    .on('complete', function () {
      console.log('Fastest is ' + this.filter('fastest').map('name'));
    })
    .run({});

  console.log('');

  console.log('Generate speed:');
  let genSuite = new Benchmark.Suite().add('source-map-js current: encoded output', () => {
    smgjsCurrent.toJSON();
  });
  if (DIFF) {
    genSuite = genSuite.add('source-map-js latest:  encoded output', () => {
      smgjsLatest.toJSON();
    });
  } else {
    genSuite = genSuite
      .add('gen-mapping:      decoded output', () => {
        toDecodedMap(genmap);
      })
      .add('gen-mapping:      encoded output', () => {
        toEncodedMap(genmap);
      })
      .add('source-map-0.6.1: encoded output', () => {
        smg061.toJSON();
      })
      .add('source-map-0.8.0: encoded output', () => {
        smgWasm.toJSON();
      });
  }
  genSuite
    .on('error', (event) => console.error(event.target.error))
    .on('cycle', (event) => {
      console.log(String(event.target));
    })
    .on('complete', function () {
      console.log('Fastest is ' + this.filter('fastest').map('name'));
    })
    .run({});
}

async function run(files) {
  let first = true;
  for (const file of files) {
    if (!file.endsWith('.map')) continue;
    if (FILE && file !== FILE) continue;

    if (!first) console.log('\n\n***\n\n');
    first = false;

    console.log(file);
    await bench(file);
  }
}
run(readdirSync(dir));
