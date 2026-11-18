/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var quickSort = require('../lib/quick-sort').quickSort;

function numberCompare(a, b) {
  return a - b;
}

exports['test sorting sorted array'] = function (assert) {
  var ary = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  var quickSorted = ary.slice();
  quickSort(quickSorted, numberCompare);

  assert.equal(JSON.stringify(ary), JSON.stringify(quickSorted));
};

exports['test sorting reverse-sorted array'] = function (assert) {
  var ary = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

  var quickSorted = ary.slice();
  quickSort(quickSorted, numberCompare);

  assert.equal(
    JSON.stringify(ary.sort(numberCompare)),
    JSON.stringify(quickSorted)
  );
};

exports['test sorting unsorted array'] = function (assert) {
  var ary = [];
  for (var i = 0; i < 10; i++) {
    ary.push(Math.random());
  }

  var quickSorted = ary.slice();
  quickSort(quickSorted, numberCompare);

  assert.equal(
    JSON.stringify(ary.sort(numberCompare)),
    JSON.stringify(quickSorted)
  );
};

exports['test sorting from a start index leaves the prefix untouched'] =
  function (assert) {
    var ary = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

    quickSort(ary, numberCompare, 4);

    assert.equal(
      JSON.stringify(ary),
      JSON.stringify([9, 8, 7, 6, 0, 1, 2, 3, 4, 5])
    );
  };

exports['test sorting with more comparators than specialized copies'] =
  function (assert) {
    // quickSort keeps a fixed number of specialized sort copies; comparators
    // beyond that share one. Every comparator must still sort correctly.
    var ary = [];
    for (var i = 0; i < 100; i++) {
      ary.push(Math.random());
    }
    var ascending = ary.slice().sort(numberCompare);

    for (var n = 0; n < 8; n++) {
      var comparator =
        n % 2 === 0
          ? function (a, b) {
              return a - b;
            }
          : function (a, b) {
              return b - a;
            };
      var expected = n % 2 === 0 ? ascending : ascending.slice().reverse();

      var quickSorted = ary.slice();
      quickSort(quickSorted, comparator);

      assert.equal(JSON.stringify(quickSorted), JSON.stringify(expected));
    }
  };

// Loads lib/quick-sort.js into a fresh VM context that behaves like a page
// whose Content Security Policy doesn't allow 'unsafe-eval': code generation
// from strings is disabled. `Function` and `eval` are replaced with spies, so
// even an attempt that the module catches and recovers from is recorded --
// browsers still report those as CSP violations, see
// https://github.com/7rulnik/source-map-js/issues/81
function loadQuickSortWithoutEval() {
  var attempts = [];
  var context = vm.createContext({}, { codeGeneration: { strings: false } });
  var RealFunction = vm.runInContext('Function', context);
  var realEval = vm.runInContext('eval', context);

  context.Function = new Proxy(RealFunction, {
    apply: function (target, thisArg, args) {
      attempts.push('Function()');
      return Reflect.apply(target, thisArg, args);
    },
    construct: function (target, args) {
      attempts.push('new Function()');
      return Reflect.construct(target, args);
    },
  });
  context.eval = function () {
    attempts.push('eval()');
    return realEval.apply(this, arguments);
  };

  var source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'quick-sort.js'),
    'utf8'
  );
  var module = { exports: {} };
  vm.runInContext('(function (exports, module) {\n' + source + '\n})', context)(
    module.exports,
    module
  );

  return { quickSort: module.exports.quickSort, attempts: attempts };
}

exports['test quickSort never generates code from strings'] = function (
  assert
) {
  var loaded = loadQuickSortWithoutEval();
  assert.deepEqual(loaded.attempts, [], 'loading the module must not use eval');

  var ary = [];
  for (var i = 0; i < 100; i++) {
    ary.push(Math.random());
  }
  var expected = ary.slice().sort(numberCompare);

  var quickSorted = ary.slice();
  loaded.quickSort(quickSorted, numberCompare);
  assert.equal(JSON.stringify(quickSorted), JSON.stringify(expected));

  var quickSortedAgain = ary.slice();
  loaded.quickSort(quickSortedAgain, function (a, b) {
    return a - b;
  });
  assert.equal(JSON.stringify(quickSortedAgain), JSON.stringify(expected));

  assert.deepEqual(loaded.attempts, [], 'sorting must not use eval');
};
