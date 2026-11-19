'use strict';

// Shared by the drivers (before-after.js, compare.js): spawning workers,
// progress output, option parsing and formatting.

const { execFileSync, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const NODE_FLAGS = ['--expose-gc', '--max-old-space-size=8192'];

// Runs one worker script in a fresh process and returns the JSON it prints.
// Exits on failure, and on Ctrl-C (which reaches the worker first).
function runWorker(script, args, what) {
  const res = spawnSync(
    process.execPath,
    [...NODE_FLAGS, path.join(__dirname, script), ...args],
    { encoding: 'utf8', maxBuffer: 256 << 20 }
  );
  if (res.signal === 'SIGINT') process.exit(130);
  if (res.status !== 0) {
    console.error(`\n${what} failed:`);
    console.error(res.stderr || res.error);
    process.exit(1);
  }
  return JSON.parse(res.stdout);
}

// "all", or a comma-separated subset of `all`.
function pick(list, all, kind) {
  if (list === 'all') return all;
  const names = list.split(',').map((s) => s.trim());
  const unknown = names.filter((n) => !all.includes(n));
  if (unknown.length) {
    console.error(`Unknown ${kind}: ${unknown.join(', ')}`);
    console.error(`Available: ${all.join(', ')}`);
    process.exit(1);
  }
  return names;
}

function positiveNumber(value, flag) {
  const n = Number(value);
  if (!(n > 0)) {
    console.error(`${flag} must be a positive number`);
    process.exit(1);
  }
  return n;
}

function formatTime(ns) {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(1)} µs`;
  return `${ns.toFixed(0)} ns`;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60
    ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
    : `${s}s`;
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function onBattery() {
  if (process.platform !== 'darwin') return false;
  try {
    return /Battery Power/.test(
      execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' })
    );
  } catch {
    return false;
  }
}

function machine() {
  return { node: process.version, cpu: os.cpus()[0].model };
}

// Progress on stderr: one updating line with an ETA on a terminal, otherwise
// a line per round (every `perRound` processes, or on each round() call).
function progress(total, perRound) {
  const tty = process.stderr.isTTY;
  const started = Date.now();
  let done = 0;
  return {
    // Before each process.
    start(label) {
      if (!tty) return;
      const elapsed = Date.now() - started;
      const eta = done
        ? formatDuration((elapsed / done) * (total - done))
        : '?';
      process.stderr.write(
        `\r\x1b[K[${String(done + 1).padStart(String(total).length)}/${total}] ` +
          `${label} · ${formatDuration(elapsed)} elapsed, ~${eta} left`
      );
    },
    // After each process.
    done() {
      done++;
      if (!tty && perRound && done % perRound === 0) {
        process.stderr.write(
          `round ${done / perRound}/${Math.ceil(total / perRound)} done · ${formatDuration(Date.now() - started)} elapsed\n`
        );
      }
    },
    // After each round, for rounds of different sizes.
    round(n, rounds) {
      if (tty) return;
      process.stderr.write(
        `round ${n}/${rounds} done · ${formatDuration(Date.now() - started)} elapsed\n`
      );
    },
    finish() {
      if (tty) process.stderr.write('\r\x1b[K');
      return Date.now() - started;
    },
  };
}

// Prints rows as aligned columns. Columns listed in `left` are left-aligned,
// the rest right-aligned.
function printTable(rows, left = [0]) {
  const widths = [];
  for (const row of rows) {
    row.forEach((text, i) => {
      widths[i] = Math.max(widths[i] || 0, text.length);
    });
  }
  for (const row of rows) {
    console.log(
      row
        .map((text, i) =>
          left.includes(i) ? text.padEnd(widths[i]) : text.padStart(widths[i])
        )
        .join('   ')
        .trimEnd()
    );
  }
}

// Shuffles in place (Fisher–Yates).
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

module.exports = {
  runWorker,
  pick,
  positiveNumber,
  formatTime,
  formatDuration,
  formatBytes,
  onBattery,
  machine,
  progress,
  printTable,
  shuffle,
};
