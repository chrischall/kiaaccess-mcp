import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { KiaClient } from '../client.js';
import { maskAccountId } from './session.js';

/**
 * Raised INSTEAD of probing when the one-time MFA bootstrap has not been done.
 *
 * This is the whole reason Kia's healthcheck needs writing carefully. Kia
 * counts failed sign-ins and eventually enforces reCAPTCHA on the account
 * PERMANENTLY, which breaks server-side login for good. So a healthcheck must
 * never be able to cause a login attempt: with no stored session it refuses,
 * locally, rather than reaching for the credentials it can see.
 */
class KiaNoSessionError extends Error {
  constructor() {
    super(
      'Credentials are configured but no session is stored — the one-time MFA bootstrap has not ' +
        'been completed on this device. Not probing: a probe here would attempt a sign-in.',
    );
  }
}

/**
 * `kia_healthcheck` — does Kia still accept this session?
 *
 * `kia_session_status` answers a DIFFERENT question and says so: it makes no
 * network call, so it reports what this server was configured with, not
 * whether any of it still works. A remember-me token that Kia has since
 * invalidated looks identical to a healthy one there.
 *
 * The probe is `listVehicles()` — the cheapest authenticated read — reached
 * through the stored remember-me token, which refreshes a session silently and
 * is NOT a sign-in attempt.
 */
export function registerHealthcheckTools(server: McpServer, client: KiaClient): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'kia',
    hostLabel: 'Kia Connect',
    probePath: 'vehicles list',
    resolveCredential: async () => {
      const config = client.describeConfig();
      if (!config.configured) return { source: null };
      return {
        // Masked exactly as `kia_session_status` masks it: a healthcheck is
        // the tool people paste into a chat when something is broken, and the
        // session id and remember-me token are never included at all.
        source: 'env',
        detail: {
          account: maskAccountId(config.accountId),
          has_session: config.hasSession,
        },
      };
    },
    probeFn: async () => {
      if (!client.describeConfig().hasSession) throw new KiaNoSessionError();
      return client.listVehicles();
    },
    classifyThrown: (err: unknown) =>
      err instanceof KiaNoSessionError
        ? {
            kind: 'no_session',
            hint:
              'Credentials are present but the one-time MFA bootstrap has not run on this device. ' +
              'Do kia_start_login → kia_send_otp → kia_verify_otp once; after that the stored ' +
              'remember-me token refreshes sessions silently. Nothing was sent to Kia by this ' +
              'check — failed sign-ins count against the account and eventually enforce reCAPTCHA ' +
              'permanently, so this refuses to probe rather than risk one.',
          }
        : undefined,
    hints: {
      no_credential:
        'No Kia credentials configured. Set the documented account and password variables, then ' +
        'run the one-time MFA bootstrap (kia_start_login → kia_send_otp → kia_verify_otp).',
      credential_rejected:
        'Kia rejected the stored session. The remember-me token was invalidated upstream — most ' +
        'often by a password change or a sign-out elsewhere. Re-run the one-time MFA bootstrap. ' +
        'Do NOT retry in a loop: Kia counts failed sign-ins and eventually enforces reCAPTCHA on ' +
        'the account permanently.',
      ok:
        'Kia Connect accepted the stored session and returned the vehicle list, so auth is ' +
        'healthy. Which commands are actually registered still depends on KIA_WRITE_MODE — ' +
        'kia_session_status reports that.',
    },
  });
}
