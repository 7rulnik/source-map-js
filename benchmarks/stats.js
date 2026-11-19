'use strict';

// Median with a distribution-free confidence interval (the one behind the
// sign test). With n values sorted, [x(k), x(n+1-k)] covers the true median
// with probability 1 - 2·P(Binomial(n, 1/2) < k). It makes no assumption about
// the shape of the distribution, and a single outlier process can't move it.

function binomialCdf(n, k) {
  // P(X <= k) for X ~ Binomial(n, 1/2)
  let term = 2 ** -n;
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term = (term * (n - i + 1)) / i;
    sum += term;
  }
  return sum;
}

// Returns { median, low, high, coverage }, or { median } alone when there are
// too few values for the requested confidence (fewer than 6 at 95%).
function medianWithCI(values, confidence = 0.95) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const alpha = (1 - confidence) / 2;
  let k = 0;
  while (k + 1 <= n / 2 && binomialCdf(n, k) <= alpha) k++;
  if (k === 0) return { median };
  return {
    median,
    low: sorted[k - 1],
    high: sorted[n - k],
    coverage: 1 - 2 * binomialCdf(n, k - 1),
  };
}

// The smallest number of values that gives a confidence interval.
function minValuesForCI(confidence = 0.95) {
  let n = 1;
  while (binomialCdf(n, 0) > (1 - confidence) / 2) n++;
  return n;
}

exports.medianWithCI = medianWithCI;
exports.minValuesForCI = minValuesForCI;
