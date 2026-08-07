/**
 * Account + session tools: the one-time MFA bootstrap, a non-secret status
 * read, the refresh-token export a hosted deployment needs, and
 * the confirm-gated way to throw the stored session away and start over.
 *
 * Kia's auth is a three-step challenge that is bootstrapped ONCE per device:
 *
 * ```
 *   kia_start_login  -> prof/authUser   -> otpKey + xid   (MFA_REQUIRED)
 *   kia_send_otp     -> cmm/sendOTP     -> a passcode by SMS or email
 *   kia_verify_otp   -> cmm/verifyOTP   -> sid + rmtoken  (stored locally)
 * ```
 *
 * After that the stored `rmtoken` mints fresh session ids silently and Kia
 * never challenges again — so these tools are run once and then forgotten.
 *
 * Three deliberate decisions, each of which a reviewer should weigh:
 *
 *  1. **`kia_start_login` is confirm-gated; `kia_send_otp` / `kia_verify_otp`
 *     are not.** The gate is not ceremony: every rejected login increments
 *     Kia's `loginAttempt` and eventually sets `enforceRecaptcha`, which breaks
 *     server-side auth for this account PERMANENTLY (docs/KIA-API.md). That is
 *     an irreversible cost, so the first call must be deliberate. The two
 *     following steps can only run with an `otpKey`/`xid` produced by that
 *     already-confirmed call, and `kia_verify_otp` needs a passcode only the
 *     account owner can read — gating them would add round-trips without adding
 *     a decision.
 *  2. **No tool returns a `sid` or an `rmtoken`** — except
 *     {@link registerSessionTools}'s explicit, confirm-gated export, which
 *     exists solely so a hosted deployment can persist the token
 *     into the user's encrypted OAuth props. `KiaClient.completeLogin()`
 *     deliberately returns no secret, so the normal bootstrap can never echo
 *     one into a transcript.
 *  3. **Identifiers are masked.** The status read reports a masked account and
 *     only the first 8 characters of the device id: enough to confirm *which*
 *     account/device is wired up, not enough to be worth exfiltrating.
 */

import { McpToolError, jsonResult, schemaConfirm, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { KiaClient } from '../client.js';
import { BASE_URL, ENDPOINTS } from '../protocol.js';
import { type KiaWriteMode, getKiaWriteMode } from './commands.js';

/**
 * The slice of {@link KiaClient} these tools use. Structural, so the real
 * client satisfies it and a test can stand in a fake without a network stack.
 */
export type KiaSessionClient = Pick<
  KiaClient,
  'describeConfig' | 'beginLogin' | 'sendLoginOtp' | 'completeLogin' | 'exportRmToken' | 'forgetSession'
>;

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/** How much of the device uuid stays visible — enough to tell two apart. */
const DEVICE_ID_VISIBLE_PREFIX = 8;

/**
 * Mask a Kia account id (the login email) to its first character and domain:
 * `driver@example.com` -> `d***@example.com`. Anything that is not
 * email-shaped reveals nothing at all rather than guessing where the safe part
 * of the string is.
 */
export function maskAccountId(accountId: string | null): string | null {
  if (accountId === null) return null;
  const at = accountId.indexOf('@');
  if (at <= 0) return '***';
  return `${accountId[0]}***${accountId.slice(at)}`;
}

/** The device uuid, truncated. It is not a secret, but it is an identifier. */
function maskDeviceId(deviceId: string): string {
  return `${deviceId.slice(0, DEVICE_ID_VISIBLE_PREFIX)}…`;
}

// ---------------------------------------------------------------------------
// Schema atoms
// ---------------------------------------------------------------------------

/**
 * `otpKey` and `xid` are sent as REQUEST HEADERS, so they are constrained to
 * printable ASCII (`!`–`~`: no space, no CR/LF, no control characters). A
 * caller-supplied value must not be able to smuggle a second header into the
 * block.
 */
const schemaHeaderToken = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[!-~]+$/, 'must be printable ASCII with no whitespace or control characters');

const schemaOtpKey = schemaHeaderToken.describe('The `otpKey` returned by kia_start_login.');
const schemaXid = schemaHeaderToken.describe('The `xid` returned by kia_start_login. Sent with every OTP call.');

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

/**
 * The one session tool that is safe everywhere: a non-secret, no-network config
 * read.
 *
 * Split out from {@link registerSessionTools} because the hosted Cloudflare
 * connector registers THIS and nothing else from this file. The MFA bootstrap
 * cannot work serverlessly (the passcode arrives minutes later on another
 * device) and `kia_export_refresh_token` emits a credential the hosted runtime
 * was handed rather than one it owns — so both are stdio-only. Extracting the
 * status tool keeps that split from becoming a second copy of it.
 */
export function registerSessionStatusTool(server: McpServer, client: KiaSessionClient): void {
  // Resolved ONCE, here, for reporting — this is the value that decided which
  // command tools exist in this process. Re-reading it per call would report a
  // mode that does not match the registered surface.
  const writeMode: KiaWriteMode = getKiaWriteMode();

  server.registerTool(
    'kia_session_status',
    {
      description:
        'Whether this server is configured and logged in to Kia: are credentials present, has the one-time MFA ' +
        'bootstrap been completed on this device, and which vehicle commands are registered (KIA_WRITE_MODE). ' +
        'Makes NO network call and returns no secret — the account email is masked, the device id is truncated, ' +
        'and neither the session id nor the remember-me token is ever included. Start here when a Kia tool ' +
        'reports it is not configured.',
      annotations: toolAnnotations({ title: 'Kia session status', readOnly: true, idempotent: true, openWorld: false }),
    },
    async () => {
      const config = client.describeConfig();
      return jsonResult({
        configured: config.configured,
        account: maskAccountId(config.accountId),
        hasSession: config.hasSession,
        deviceIdPrefix: maskDeviceId(config.deviceId),
        writeMode,
        writeModeNote:
          'Resolved at startup from KIA_WRITE_MODE: "none" registers no vehicle commands, "comfort" climate and ' +
          'charging, "all" also door lock/unlock. An unrecognized value fails closed to "none".',
        nextStep: describeNextStep(config.configured, config.hasSession),
      });
    },
  );
}

/**
 * The full stdio session surface: the status read plus the one-time MFA
 * bootstrap and the refresh-token export.
 */
export function registerSessionTools(server: McpServer, client: KiaSessionClient): void {
  registerSessionStatusTool(server, client);

  server.registerTool(
    'kia_start_login',
    {
      description:
        'Step 1 of the ONE-TIME Kia MFA bootstrap (prof/authUser): send the configured credentials and get back the ' +
        '`otpKey` and `xid` the next two steps need. Only needed when kia_session_status reports hasSession:false — ' +
        'once the bootstrap is done the stored remember-me token refreshes sessions silently forever. ' +
        'Without confirm:true it makes NO network call and returns a dry-run preview. The gate is real: Kia counts ' +
        'failed logins and eventually enforces reCAPTCHA, which breaks server-side login for this account ' +
        'PERMANENTLY — so a rejection is never retried, and a wrong password must be fixed in the environment ' +
        'rather than guessed at.',
      annotations: toolAnnotations({
        title: 'Start Kia login (MFA bootstrap)',
        readOnly: false,
        idempotent: false,
        openWorld: true,
      }),
      inputSchema: { confirm: schemaConfirm },
    },
    async ({ confirm }) => {
      const account = maskAccountId(client.describeConfig().accountId);
      if (confirm !== true) {
        return jsonResult({
          dryRun: true,
          action: `Start the Kia MFA bootstrap for ${account ?? 'the configured account'}`,
          method: 'POST',
          endpoint: ENDPOINTS.authUser,
          url: `${BASE_URL}${ENDPOINTS.authUser}`,
          account,
          willSend: {
            deviceKey: '',
            deviceType: 2,
            userCredential: { userId: account, password: '<the KIA_PASSWORD env var — never shown>' },
            tncFlag: 1,
          },
          headers: 'The full static Kia header set (including the mandatory RFC 1123 `date`), added by the client.',
          risk:
            'This spends one login attempt. Kia increments `loginAttempt` on every rejection and eventually sets ' +
            'enforceRecaptcha, after which server-side login is permanently impossible for this account. Verify ' +
            'KIA_USERNAME / KIA_PASSWORD in the Kia Access app before confirming.',
          hint: 'No request was made. Re-run with confirm: true to execute.',
        });
      }

      const login = await client.beginLogin();
      return jsonResult({
        started: true,
        account,
        mfaRequired: login.mfaRequired,
        nextAction: login.nextAction,
        otpKey: login.otpKey,
        xid: login.xid,
        destinations: {
          hasEmail: login.hasEmail,
          hasPhone: login.hasPhone,
          maskedEmail: login.maskedEmail,
          maskedPhone: login.maskedPhone,
        },
        nextStep:
          'Call kia_send_otp with this otpKey and xid and the channel the user picks (SMS or EMAIL), then ' +
          'kia_verify_otp with the passcode they receive.',
      });
    },
  );

  server.registerTool(
    'kia_send_otp',
    {
      description:
        'Step 2 of the Kia MFA bootstrap (cmm/sendOTP): deliver a one-time passcode to the account by SMS or ' +
        'email. Takes the `otpKey` and `xid` from kia_start_login — it cannot run without them, which is why it ' +
        'has no separate confirm gate. Ask the user which channel they want (kia_start_login reports the masked ' +
        'destinations Kia has on file). The passcode expires in about two minutes; `expiresAt` reports when.',
      annotations: toolAnnotations({
        title: 'Send Kia login passcode',
        readOnly: false,
        idempotent: false,
        openWorld: true,
      }),
      inputSchema: {
        otpKey: schemaOtpKey,
        xid: schemaXid,
        notifyType: z
          .enum(['SMS', 'EMAIL'])
          .describe('Delivery channel. Ask the user; do not guess which destination they can read right now.'),
      },
    },
    async ({ otpKey, xid, notifyType }) => {
      const sent = await client.sendLoginOtp({ otpKey, xid, notifyType });
      return jsonResult({
        sent: true,
        notifyType,
        message: sent.message,
        maskedPhone: sent.maskedPhone,
        // Kia's `expiresIn` is an epoch-ms TIMESTAMP despite the name — passing
        // it through raw would read as a duration ("expires in 1.7e12 seconds").
        expiresAt: describeExpiry(sent.expiresIn),
        nextStep:
          'Ask the user for the passcode, then call kia_verify_otp with the SAME otpKey and xid plus the code. ' +
          'It expires in about two minutes — re-run this tool for a fresh one if it lapses.',
      });
    },
  );

  server.registerTool(
    'kia_verify_otp',
    {
      description:
        'Step 3 of the Kia MFA bootstrap (cmm/verifyOTP): exchange the passcode for a session. The resulting ' +
        'remember-me token is stored locally and is NOT returned — from here on every Kia tool refreshes its own ' +
        'session silently and MFA is never needed again on this device. Takes the `otpKey` and `xid` from ' +
        'kia_start_login plus the code the user received.',
      annotations: toolAnnotations({
        title: 'Verify Kia login passcode',
        readOnly: false,
        idempotent: false,
        openWorld: true,
      }),
      inputSchema: {
        otpKey: schemaOtpKey,
        xid: schemaXid,
        otp: z
          .string()
          // Every observed code was 6 digits (docs/KIA-API.md); the range is
          // deliberately a little wider so an unobserved channel sending a
          // different length is rejected by Kia rather than by this schema.
          .regex(/^[0-9]{4,8}$/, 'the passcode is digits only (6 in every observed case)')
          .describe('The one-time passcode Kia sent to the user — 6 digits in every observed case.'),
      },
    },
    async ({ otpKey, xid, otp }) => {
      const done = await client.completeLogin({ otpKey, xid, otp });
      return jsonResult({
        verified: true,
        account: maskAccountId(done.accountId),
        deviceIdPrefix: maskDeviceId(done.deviceId),
        persisted: done.persisted,
        note:
          'The remember-me token was stored locally and is deliberately not returned. Kia does not rotate it, so ' +
          'this bootstrap does not need repeating unless the token is deleted or revoked.',
        nextStep: 'Run kia_list_vehicles to confirm the session works.',
      });
    },
  );

  server.registerTool(
    'kia_export_refresh_token',
    {
      description:
        'Return the stored Kia remember-me token (rmtoken) IN PLAINTEXT. This is a CREDENTIAL: it bypasses MFA ' +
        'entirely and, with the account password, grants full control of the vehicle — including unlocking it. ' +
        'It exists for one purpose: moving a locally-bootstrapped session into a hosted deployment, which stores ' +
        'it in the user\'s encrypted credentials. Do NOT call it to "check the session" (use kia_session_status), ' +
        'and never display or log the value except where the user explicitly asked for it. Without confirm:true ' +
        'the token is not even read.',
      // Deliberately NOT readOnlyHint: this makes no remote change, but hosts
      // auto-approve read-only tools, and a tool that emits a credential must
      // stay an explicit, visible action.
      annotations: toolAnnotations({
        title: 'Export Kia refresh token (credential)',
        readOnly: false,
        idempotent: true,
        openWorld: false,
      }),
      inputSchema: { confirm: schemaConfirm },
    },
    async ({ confirm }) => {
      const config = client.describeConfig();
      const account = maskAccountId(config.accountId);
      if (confirm !== true) {
        return jsonResult({
          dryRun: true,
          action: `Return the Kia remember-me token for ${account ?? 'the configured account'}`,
          account,
          hasSession: config.hasSession,
          warning:
            'The value was NOT read. It is a long-lived credential that bypasses MFA — re-run with confirm: true ' +
            'only if the user asked to move this session somewhere else (e.g. a hosted deployment).',
          hint: 'No token was returned. Re-run with confirm: true to export it.',
        });
      }

      const rmtoken = client.exportRmToken();
      if (rmtoken === null) {
        throw new McpToolError(
          config.configured
            ? 'No Kia remember-me token is stored for this account — the one-time MFA bootstrap has not been ' +
              'completed on this device. Run kia_start_login, then kia_send_otp, then kia_verify_otp, and try again.'
            : 'kiaaccess-mcp is not configured, so there is no account whose token could be exported. Set ' +
              'KIA_USERNAME and KIA_PASSWORD first (see .env.example).',
          {
            hint: config.configured
              ? 'Run kia_start_login, then kia_send_otp, then kia_verify_otp, and try again.'
              : 'Set KIA_USERNAME and KIA_PASSWORD (see .env.example), then complete the login bootstrap.',
          },
        );
      }

      return jsonResult({
        account,
        rmtoken,
        warning:
          'CREDENTIAL — this token bypasses MFA. Hand it only to the destination the user named, do not repeat it ' +
          'in conversation, and treat any transcript containing it as containing a password.',
      });
    },
  );

  server.registerTool(
    'kia_forget_session',
    {
      description:
        'Discard the locally stored Kia session (the remember-me token), so the next Kia call needs the one-time ' +
        'MFA bootstrap again. This is the recovery path when the stored token no longer works — Kia revoked it, ' +
        'the password changed, or the account moved to another device — and the only alternative is deleting the ' +
        'session file by hand. It makes NO network call: Kia is not told anything, only this machine forgets. ' +
        'Without confirm:true nothing is deleted and you get a preview instead.',
      annotations: toolAnnotations({
        title: 'Forget stored Kia session',
        readOnly: false,
        idempotent: true,
        openWorld: false,
      }),
      inputSchema: { confirm: schemaConfirm },
    },
    async ({ confirm }) => {
      const config = client.describeConfig();
      const account = maskAccountId(config.accountId);
      if (confirm !== true) {
        return jsonResult({
          dryRun: true,
          action: `Delete the stored Kia session for ${account ?? 'the configured account'}`,
          account,
          hasSession: config.hasSession,
          effect:
            'The stored remember-me token is deleted from this machine. No request is sent to Kia and the account ' +
            'itself is unaffected — but the MFA bootstrap (kia_start_login → kia_send_otp → kia_verify_otp) has to ' +
            'be run again, which needs a passcode from the account owner.',
          hint: 'Nothing was deleted. Re-run with confirm: true to forget the session.',
        });
      }

      client.forgetSession();
      return jsonResult({
        forgotten: true,
        account,
        hadStoredSession: config.hasSession,
        note: 'Local only — Kia was not contacted, and the token is not returned.',
        nextStep:
          'Run the one-time MFA bootstrap again when you next need the vehicle: kia_start_login, then kia_send_otp, ' +
          'then kia_verify_otp.',
      });
    },
  );
}

/**
 * Render Kia's `expiresIn` — an epoch-ms TIMESTAMP, not a duration — as an ISO
 * instant. A value that does not make a valid date is dropped rather than
 * guessed at: no expiry beats a wrong one on a two-minute window.
 */
function describeExpiry(expiresIn: number | undefined): string | undefined {
  if (expiresIn === undefined) return undefined;
  const expiresAt = new Date(expiresIn);
  return Number.isNaN(expiresAt.getTime()) ? undefined : expiresAt.toISOString();
}

/** What a caller should do next, given the configuration state. */
function describeNextStep(configured: boolean, hasSession: boolean): string {
  if (!configured) {
    return 'Set KIA_USERNAME and KIA_PASSWORD (copy .env.example to .env), then restart the server and re-run this tool.';
  }
  if (!hasSession) {
    return 'Complete the one-time MFA bootstrap: kia_start_login, then kia_send_otp, then kia_verify_otp.';
  }
  return 'Ready — a remember-me token is stored, so sessions refresh silently and MFA is not needed again.';
}
