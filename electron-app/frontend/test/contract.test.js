#!/usr/bin/env node
// Contract test: lib/api.js <-> preload.js <-> backend/ipc.js
//
// Three files describe one interface, and they can drift apart silently. A wrapper with
// no preload entry is a TypeError at runtime; a preload entry with no main-process
// handler is "Error invoking remote method"; a channel that is only ever broadcast is
// fine. None of it shows up until someone clicks the right button.
//
// This caught two real defects on its first run:
//   * quizButton was called by app.js but api.js never wrapped it, so the whole
//     Promise.all rejected and the conversation header silently lost its plan
//   * topicSlice was exposed in preload with no channel in ipc.js at all
//
// Run: npm test --prefix frontend

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// frontend/test/ -> frontend/ -> electron-app/, which is where preload.js lives.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');

const api = read('frontend/lib/api.js');
const preload = read('preload.js');
const ipc = read('backend/ipc.js');

// 1. Methods the functional layer calls on the bridge.
const wanted = [
  ...new Set([
    ...[...api.matchAll(/call\('([A-Za-z]+)'\)/g)].map((m) => m[1]),
    ...[...api.matchAll(/bridge\.([A-Za-z]+)\(/g)].map((m) => m[1]),
  ]),
].sort();

// 2. Methods the preload exposes, and the channel each one uses.
const exposed = new Map();
for (const m of preload.matchAll(/^\s{2}([A-Za-z]+):\s*\(?[^=]*=>\s*ipcRenderer\.(?:invoke|on)\(CH\.([A-Z_]+)/gm)) {
  exposed.set(m[1], m[2]);
}
// Subscriptions go through the subscribe() helper rather than ipcRenderer directly.
for (const m of preload.matchAll(/^\s{2}([A-Za-z]+):\s*\(cb\)\s*=>\s*subscribe\(CH\.([A-Z_]+)/gm)) {
  exposed.set(m[1], m[2]);
}

// 3. Channels the main process handles, declares, and broadcasts.
const handled = new Set([...ipc.matchAll(/\[IPC\.([A-Z_]+),/g)].map((m) => m[1]));
const declared = new Set([...ipc.matchAll(/^\s{2}([A-Z_]+):\s*'compat:/gm)].map((m) => m[1]));
const broadcast = new Set([...ipc.matchAll(/broadcast\(IPC\.([A-Z_]+)/g)].map((m) => m[1]));

// Event subscriptions are main-to-renderer, so they have no handler by design.
const SUBSCRIPTIONS = new Set(['onProgress', 'onReady', 'onQuizProgress']);

let failures = 0;
const fail = (message) => {
  console.error(`FAIL  ${message}`);
  failures++;
};

for (const name of wanted) {
  if (!exposed.has(name)) {
    fail(`api.js calls "${name}" but preload.js never exposes it`);
    continue;
  }
  const channel = exposed.get(name);
  if (!handled.has(channel) && !broadcast.has(channel)) {
    fail(`preload exposes "${name}" as IPC.${channel} but ipc.js has no handler and never broadcasts it`);
  }
}

for (const [name, channel] of exposed) {
  if (!wanted.includes(name) && !SUBSCRIPTIONS.has(name)) {
    fail(`preload exposes "${name}" but api.js never uses it (dead surface)`);
  }
  if (!declared.has(channel)) {
    fail(`preload uses IPC.${channel} which ipc.js does not declare`);
  }
}

for (const name of SUBSCRIPTIONS) {
  if (!wanted.includes(name)) fail(`the frontend never subscribes to ${name}`);
  if (!broadcast.has(exposed.get(name))) fail(`${name} is exposed but the main process never broadcasts on it`);
}

console.log(`\ncontract: ${wanted.length} api methods, ${exposed.size} preload entries, ${handled.size} handlers, ${broadcast.size} broadcasts, ${declared.size} channels`);

if (failures > 0) {
  console.error(`\n${failures} contract problem(s). The interface has drifted.\n`);
  process.exit(1);
}
console.log('api.js, preload.js and ipc.js agree.\n');
