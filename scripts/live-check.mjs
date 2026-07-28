#!/usr/bin/env node
/**
 * Manual live check for the two bugs fixed in `fix(client): re-resolve a rotated
 * vinkey instead of re-authenticating`. Talks to the REAL Kia API — it is not
 * part of `npm test` and nothing in CI runs it.
 *
 *   npm run build && node scripts/live-check.mjs
 *
 * Needs `KIA_USERNAME` / `KIA_PASSWORD` in `.env` (or the environment) plus a
 * completed MFA bootstrap on this device, i.e. an `rmtoken` in
 * `~/.kiaaccess-mcp/session.json`. It makes READ calls only: `prof/authUser`,
 * `ownr/gvl` and `cmm/gvi`. Nothing here moves the car.
 *
 * What it proves, in the order the original failure unfolded:
 *
 *   1. `ownr/gvl` twice in one session returns the SAME `vehicleKey`. It stopped
 *      doing that because every failed `cmm/gvi` was silently re-authenticating,
 *      and a new session rotates every key.
 *   2. `cmm/gvi` succeeds with the key `ownr/gvl` just handed out.
 *   3. `cmm/gvi` still succeeds with a key from a DEAD session (simulated by
 *      forcing a `sid` re-mint), because the client re-resolves it rather than
 *      re-authenticating. This is the case that used to be unrecoverable.
 *   4. Exactly one `prof/authUser` per session change and no more — a re-auth
 *      during step 3 is the bug itself.
 */

import { KiaClient } from '../dist/client.js';

/** Count every outbound call so a stray `prof/authUser` cannot hide. */
const calls = [];
const countingFetch = (url, init) => {
  calls.push(url.split('/v1/')[1] ?? url);
  return globalThis.fetch(url, init);
};

const since = (mark) => calls.slice(mark);
const authCount = (from) => since(from).filter((p) => p === 'prof/authUser').length;

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const client = new KiaClient({ fetchImpl: countingFetch });

if (!client.isConfigured()) {
  console.error('Not configured: set KIA_USERNAME and KIA_PASSWORD in .env, then retry.');
  process.exit(2);
}
if (!client.hasSession()) {
  console.error(
    'No stored session: this device has never completed the one-time MFA bootstrap.\n' +
      'Run kia_start_login -> kia_send_otp -> kia_verify_otp once, then retry.',
  );
  process.exit(2);
}

console.log('1. vehicleKey is stable within one session');
const first = await client.listVehicles();
if (first.length === 0) {
  console.error('This account has no enrolled vehicles — nothing to check.');
  process.exit(2);
}
const second = await client.listVehicles();
const keyA = first[0].vehicleKey;
check(
  keyA === second[0].vehicleKey,
  'two ownr/gvl reads agree',
  `${keyA.slice(0, 8)}… vs ${second[0].vehicleKey.slice(0, 8)}…`,
);

console.log('2. cmm/gvi accepts the key ownr/gvl just returned');
let mark = calls.length;
const status = await client.getVehicleStatus(keyA, { includeClimate: true });
check(status !== null, 'cmm/gvi returned a vehicle record');
check(authCount(mark) === 0, 'no re-authentication was triggered', since(mark).join(', ') || 'no calls');

console.log('3. a key from a DEAD session still works (the case that used to be fatal)');
// Force a new Kia session behind the client's back. Kia rotates every
// vehicleKey when it mints a sid, so `keyA` is now exactly the stale key the
// original bug choked on.
//
// `sids` is `private` in TypeScript, which is a compile-time marker only — this
// is a diagnostic script deliberately reaching past it to manufacture the
// failure. Nothing in `src/` may do this.
await client.sids.refreshNow();
mark = calls.length;
const recovered = await client.getVehicleStatus(keyA, { includeClimate: true });
check(recovered !== null, 'cmm/gvi recovered after the session rotated');
check(
  since(mark).includes('ownr/gvl'),
  'the key was re-resolved against a fresh ownr/gvl',
  since(mark).join(', '),
);
check(
  authCount(mark) === 0,
  'recovery did NOT re-authenticate (that would rotate the keys again)',
  `${authCount(mark)} prof/authUser call(s)`,
);

console.log('4. the account still reports a usable key afterwards');
const third = await client.listVehicles();
check(third[0]?.vehicleKey !== undefined, 'ownr/gvl still lists the vehicle');
const afterKey = third[0].vehicleKey;
check((await client.getVehicleStatus(afterKey)) !== null, 'and cmm/gvi accepts that key');

console.log(`\nTotal upstream calls: ${calls.length} (${calls.filter((p) => p === 'prof/authUser').length} prof/authUser)`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
