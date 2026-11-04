/**
 * `_meta.mint` hints (the mcp-host context-groups contract): which canonical
 * group a tool belongs to, what kind of ask it answers, and the everyday words
 * its name and description lack. Inert data to any other client.
 *
 * Two deliberate absences:
 *
 *  - **No canonical read.** A car answers no "what's new / what's due / what's
 *    on" question, so this server ships lookup and write hints only.
 *  - **No `subject`.** A subject must publish the person's vehicles as a label
 *    enum listed at start. Here that listing needs a live Kia session — and a
 *    sign-in attempt at boot is exactly what this server refuses to make
 *    unasked, because Kia counts failed sign-ins and then enforces reCAPTCHA on
 *    the account permanently. The `vehicle_key` it would name is also scoped to
 *    the session that issued it, so a key listed at boot can stop matching
 *    after a re-login.
 */

const DOMAIN = 'home';

type Intent = 'lookup' | 'turn-on-off' | 'change' | 'other';

function meta(intent: Intent, aliases?: string[]) {
  return { mint: { domain: DOMAIN, intent, ...(aliases ? { aliases } : {}) } };
}

/** Sign-in plumbing and session bookkeeping. */
export const SESSION_META = meta('other');
/** Is the Kia session signed in. */
export const SESSION_STATUS_META = meta('lookup');

export const LIST_VEHICLES_META = meta('lookup', ['my car', 'my kia', 'my cars']);
export const VEHICLE_STATUS_META = meta('lookup', [
  'car battery',
  'how much charge',
  'range',
  'fuel level',
  'is my car locked',
  'tire pressure',
  'car status',
]);
export const VEHICLE_LOCATION_META = meta('lookup', ['where is my car', 'where did i park', 'car location']);
export const CHARGE_TARGETS_META = meta('lookup', ['charge limit', 'charging limit']);
/** Asks the car for a fresh reading — a request to the vehicle, not a read. */
export const REFRESH_STATUS_META = meta('other');

const CLIMATE_ALIASES = [
  'warm up the car',
  'cool down the car',
  'car heater',
  'car ac',
  'defrost',
  'remote start',
  'climate',
];
export const CLIMATE_META = meta('turn-on-off', CLIMATE_ALIASES);

const CHARGE_ALIASES = ['charging', 'charge the car', 'ev charging'];
export const CHARGE_META = meta('turn-on-off', CHARGE_ALIASES);
export const CHARGE_LIMITS_META = meta('change', ['charge limit', 'charging limit']);

const DOOR_ALIASES = ['lock the car', 'unlock the car', 'car doors', 'car locks'];
export const DOOR_META = meta('turn-on-off', DOOR_ALIASES);
