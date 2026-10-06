/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var filename = path.join(__dirname, '../../lib/quick-sort.js');
var source = fs.readFileSync(filename, 'utf8');

function loadQuickSort(assert, allowEval) {
  // Use a fresh realm: the eval check and comparator cache initialize at module load.
  var context = vm.createContext({ exports: {} }, {
    codeGeneration: { strings: allowEval, wasm: false }
  });

  function probeEval() {
    return vm.runInContext('new Function("return 0")()', context);
  }

  if (allowEval) {
    assert.strictEqual(probeEval(), 0);
  } else {
    // Verify the restriction is active instead of silently testing the normal path.
    assert.throws(probeEval, function (error) {
      return error.name === 'EvalError';
    });
  }

  vm.runInContext(source, context, { filename: filename, timeout: 1000 });
  return context.exports.quickSort;
}

function checkSorting(assert, quickSort) {
  function numberCompare(a, b) {
    return a - b;
  }

  var ary = [3, 1, 2, 1, 0];
  quickSort(ary, numberCompare);
  assert.equal(JSON.stringify(ary), '[0,1,1,2,3]');

  // Reuse the comparator, with a prefix that must stay untouched.
  ary = [9, 8, 3, 1, 2, 1, 0];
  quickSort(ary, numberCompare, 2);
  assert.equal(JSON.stringify(ary), '[9,8,0,1,1,2,3]');

  ary = [3, 1, 2, 1, 0];
  quickSort(ary, function (a, b) { return b - a; });
  assert.equal(JSON.stringify(ary), '[3,2,1,1,0]');
}

// Regression coverage for the public CSP fallback fixed in #29.
exports['test sorting when string code generation is disabled'] = function (assert) {
  checkSorting(assert, loadQuickSort(assert, false));
};

exports['test sorting when string code generation is enabled'] = function (assert) {
  checkSorting(assert, loadQuickSort(assert, true));
};
