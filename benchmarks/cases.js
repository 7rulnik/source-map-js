'use strict';

// Before/after cases. Each exercises one part of the public API on a fixture:
//
//   setup(lib, fixture) → { run, checksum? }
//
// setup() does everything that shouldn't be timed. run() is one timed unit of
// work; it returns a number derived from the results, so V8 can't skip the
// work. checksum() (run() when omitted) is called once per process with a
// stronger hash: the driver compares it between base and head to catch a
// change that alters results.
//
// Queries and addMapping() arguments come from benchmarks/helpers.js, not
// from the library under test, so both sides get identical inputs. `lib` is
// the library itself, loaded from the path the driver passes to the worker.

const path = require('path');
const {
  random,
  hashString,
  mixResult,
  mixMapping,
  pickSegments,
  hasSource,
  pickOriginalLines,
  addMappingArgs,
} = require('./helpers');

const QUERIES = 10000;
const ALL_POSITIONS_QUERIES = 1000;

// run() does every lookup with a cheap hash; checksum() hashes the full
// JSON of every result.
function lookups(lookup, queries) {
  return {
    run() {
      let h = 0;
      for (let i = 0; i < queries.length; i++) {
        h = mixResult(h, lookup(queries[i]));
      }
      return h;
    },
    checksum() {
      let h = 0;
      for (const query of queries) {
        h = hashString(h, JSON.stringify(lookup(query)));
      }
      return h;
    },
  };
}

function parsedConsumer(lib, fixture) {
  const smc = new lib.SourceMapConsumer(fixture.map);
  smc.originalPositionFor({ line: 1, column: 0 });
  return smc;
}

function buildGenerator(lib, fixture, args) {
  const generator = new lib.SourceMapGenerator({
    file: fixture.map.file,
    sourceRoot: fixture.map.sourceRoot,
  });
  for (let i = 0; i < args.length; i++) generator.addMapping(args[i]);
  return generator;
}

// Keeps the last built object reachable, so building it can't be optimized
// away.
let keep;

const CASES = [
  {
    name: 'parse',
    description:
      'new SourceMapConsumer(object) + the first originalPositionFor(), which parses the mappings',
    setup(lib, fixture) {
      const { SourceMapConsumer } = lib;
      const { map } = fixture;
      const first = { line: 1, column: 0 };
      return {
        run() {
          const smc = new SourceMapConsumer(map);
          return mixResult(0, smc.originalPositionFor(first));
        },
        checksum() {
          const smc = new SourceMapConsumer(map);
          let h = 0;
          smc.eachMapping((m) => {
            h = mixMapping(h, m, true);
          });
          smc.eachMapping(
            (m) => {
              h = mixMapping(h, m, true);
            },
            null,
            SourceMapConsumer.ORIGINAL_ORDER
          );
          return h;
        },
      };
    },
  },
  {
    name: 'opf-random',
    description: `originalPositionFor() × ${QUERIES} random generated positions`,
    setup(lib, fixture) {
      const smc = parsedConsumer(lib, fixture);
      const queries = pickSegments(fixture.lines, QUERIES, random(1)).map(
        ([line, s]) => ({ line: line + 1, column: s[0] })
      );
      return lookups((q) => smc.originalPositionFor(q), queries);
    },
  },
  {
    name: 'opf-ascending',
    description: `originalPositionFor() × ${QUERIES} generated positions in ascending order`,
    setup(lib, fixture) {
      const smc = parsedConsumer(lib, fixture);
      const queries = pickSegments(fixture.lines, QUERIES).map(([line, s]) => ({
        line: line + 1,
        column: s[0],
      }));
      return lookups((q) => smc.originalPositionFor(q), queries);
    },
  },
  {
    name: 'gpf-random',
    description: `generatedPositionFor() × ${QUERIES} random original positions`,
    setup(lib, fixture) {
      const smc = parsedConsumer(lib, fixture);
      const { sources } = fixture.map;
      const queries = pickSegments(
        fixture.lines,
        QUERIES,
        random(2),
        hasSource
      ).map(([, s]) => ({
        source: sources[s[1]],
        line: s[2] + 1,
        column: s[3],
      }));
      return lookups((q) => smc.generatedPositionFor(q), queries);
    },
  },
  {
    name: 'agpf-random',
    description: `allGeneratedPositionsFor() × ${ALL_POSITIONS_QUERIES} random original lines`,
    setup(lib, fixture) {
      const smc = parsedConsumer(lib, fixture);
      const { sources } = fixture.map;
      const queries = pickOriginalLines(
        fixture.lines,
        ALL_POSITIONS_QUERIES,
        random(3)
      ).map(([source, line]) => ({ source: sources[source], line: line + 1 }));
      return lookups((q) => smc.allGeneratedPositionsFor(q), queries);
    },
  },
  {
    name: 'each-generated',
    description: 'eachMapping() in generated order',
    setup(lib, fixture) {
      const smc = parsedConsumer(lib, fixture);
      return {
        run() {
          let h = 0;
          smc.eachMapping((m) => {
            h = mixMapping(h, m, false);
          });
          return h;
        },
        checksum() {
          let h = 0;
          smc.eachMapping((m) => {
            h = mixMapping(h, m, true);
          });
          return h;
        },
      };
    },
  },
  {
    name: 'each-original',
    description: 'eachMapping() in original order',
    setup(lib, fixture) {
      const smc = parsedConsumer(lib, fixture);
      const order = lib.SourceMapConsumer.ORIGINAL_ORDER;
      return {
        run() {
          let h = 0;
          smc.eachMapping(
            (m) => {
              h = mixMapping(h, m, false);
            },
            null,
            order
          );
          return h;
        },
        checksum() {
          let h = 0;
          smc.eachMapping(
            (m) => {
              h = mixMapping(h, m, true);
            },
            null,
            order
          );
          return h;
        },
      };
    },
  },
  {
    name: 'add-mapping',
    description:
      'new SourceMapGenerator() + addMapping() for every segment, in generated order',
    setup(lib, fixture) {
      const args = addMappingArgs(fixture);
      return {
        run() {
          keep = buildGenerator(lib, fixture, args);
          return args.length;
        },
        checksum() {
          return hashString(0, buildGenerator(lib, fixture, args).toString());
        },
      };
    },
  },
  {
    name: 'to-string',
    description: 'toString() of a generator holding every segment',
    setup(lib, fixture) {
      const generator = buildGenerator(lib, fixture, addMappingArgs(fixture));
      return {
        run() {
          return generator.toString().length;
        },
        checksum() {
          return hashString(0, generator.toString());
        },
      };
    },
  },
  {
    name: 'from-source-map',
    description: 'SourceMapGenerator.fromSourceMap() of a parsed consumer',
    setup(lib, fixture) {
      const smc = parsedConsumer(lib, fixture);
      return {
        run() {
          keep = lib.SourceMapGenerator.fromSourceMap(smc);
          return 1;
        },
        checksum() {
          return hashString(
            0,
            lib.SourceMapGenerator.fromSourceMap(smc).toString()
          );
        },
      };
    },
  },
];

exports.CASES = CASES;
exports.load = (libPath) => require(path.resolve(libPath));
