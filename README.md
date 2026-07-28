# Kia Access MCP

[![CI](https://github.com/chrischall/kiaaccess-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/kiaaccess-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kiaaccess-mcp)](https://www.npmjs.com/package/kiaaccess-mcp)
[![license](https://img.shields.io/npm/l/kiaaccess-mcp)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to your own Kia vehicle through the Kia Owners API the Kia Access mobile app uses: vehicle status, location, odometer, EV charge state, and confirm-gated door, climate, and charging commands.

> [!WARNING]
> **AI-developed project.** This codebase was built and is maintained by [Claude Code](https://www.anthropic.com/claude). No human has audited the implementation. Review the code and the tool permissions before pointing it at a real car.

> [!CAUTION]
> **This server can move a two-tonne object and can unlock your car.** Every command tool is confirm-gated — without `confirm: true` it makes no network call at all and returns a dry-run preview — and door lock/unlock is not even registered unless you opt in with `KIA_WRITE_MODE=all`. Read [Vehicle commands](#vehicle-commands) before changing that.

## What you can do

Ask Claude things like:

- *"Is the EV9 locked, and what's the charge at?"*
- *"Warm the car up to 72 for ten minutes"*
- *"Where did I leave the car?"*
- *"Refresh the car's status, then tell me the odometer"*

## Requirements

- [Node.js](https://nodejs.org) 22.5 or later
- A Kia Owners / Kia Access account with an enrolled vehicle, and its password
- A phone or mailbox you can read once, for the one-time MFA passcode

## Acknowledgement of terms

By using this server you accept that:

1. **It uses your own Kia account credentials** to talk to the same private API the Kia Access app uses. It cannot reach anyone else's vehicle or account.
2. **Kia's terms govern your use of it**, exactly as they govern your use of the app. This is not an official or supported integration and is not affiliated with, endorsed by, or sponsored by Kia.
3. **Commands act on a real vehicle in the physical world.** Unlocking leaves the car unsecured until someone locks it; climate preconditioning runs the HVAC and draws power. You are responsible for every command you confirm.
4. **Failed logins have a permanent cost.** Kia counts them (`loginAttempt`) and eventually sets `enforceRecaptcha`, after which server-side login for that account is impossible. This server therefore never retries a rejected credential — see [If login fails](#if-login-fails).

## Installation

### 1. Clone and build

```bash
git clone https://github.com/chrischall/kiaaccess-mcp.git
cd kiaaccess-mcp
npm install
npm run build
```

### 2. Configure credentials

```bash
cp .env.example .env
# Edit .env: KIA_USERNAME, KIA_PASSWORD (and optionally KIA_WRITE_MODE)
```

`.env` is gitignored. The server never logs credentials, and no tool ever returns your password.

### 3. Register with Claude Code

```json
{
  "mcpServers": {
    "kiaaccess": {
      "command": "npx",
      "args": ["-y", "kiaaccess-mcp"],
      "env": {
        "KIA_USERNAME": "you@example.com",
        "KIA_PASSWORD": "your-password",
        "KIA_WRITE_MODE": "comfort"
      }
    }
  }
}
```

Missing credentials do not stop the server from booting — it starts, answers `tools/list`, and only reports the configuration error when a tool actually needs to call Kia. Run `kia_session_status` to see what it thinks it has.

## The one-time MFA bootstrap

Kia challenges every new device with a one-time passcode. This server bootstraps **once**, stores the resulting remember-me token (`rmtoken`) under `~/.kiaaccess-mcp/session.json`, and from then on mints fresh sessions silently — Kia does not rotate the token and does not challenge again.

Run it through Claude, in this order:

1. **`kia_session_status`** — confirms credentials are present. If it reports `hasSession: false`, continue.
2. **`kia_start_login`** (needs `confirm: true`) — sends your credentials, returns an `otpKey` and an `xid`, plus the masked phone/email Kia has on file.
3. **`kia_send_otp`** — pick `SMS` or `EMAIL`. The passcode expires in about two minutes.
4. **`kia_verify_otp`** — hand it the passcode. The token is stored locally and is deliberately **not** returned.
5. **`kia_list_vehicles`** — confirms the session works and gives you the `vehicleKey` every other tool takes.

To start over (revoked token, changed password, handing the machine on), run **`kia_forget_session`** with `confirm: true` and repeat from step 2.

### If login fails

Do not retry. Kia increments `loginAttempt` on every rejection and eventually sets `enforceRecaptcha`, which breaks server-side login for that account permanently. Verify the email and password in the Kia Access app first, fix `.env`, restart, and only then try again.

## Vehicle commands

`KIA_WRITE_MODE` decides which command tools are **registered at all**. This is a structural gate, not a runtime check: a tool that was never registered cannot be invoked by any host permission setting or by an instruction injected into the conversation.

| `KIA_WRITE_MODE` | Registers |
|---|---|
| `none` | Nothing but the read tools and the account tools |
| `comfort` *(default)* | Climate start/stop and the charging commands |
| `all` | Also `kia_lock_doors` and `kia_unlock_doors` |

An unrecognised value **fails closed to `none`** and warns on stderr — a typo must never silently grant the ability to unlock a car.

Two more rules hold for every command:

- **Confirm-gated.** Without `confirm: true` there is no network call at all, just a preview of the exact request that would be sent.
- **Accepted is not confirmed.** Kia answering "success" only means the request was accepted. The only proof a command took effect is re-reading the vehicle and diffing the field, so results report `commandAccepted` and `stateConfirmed` separately. Observed changes took 30–60 seconds.

## Tools

### Account and session

| Tool | Notes |
|---|---|
| `kia_session_status` | Configured? Bootstrapped? Which write mode? No network call, no secrets — the email is masked and the device id truncated. |
| `kia_start_login` | Step 1 of the MFA bootstrap. Confirm-gated, because a rejection has a permanent cost. |
| `kia_send_otp` | Step 2 — delivers the passcode by `SMS` or `EMAIL`. |
| `kia_verify_otp` | Step 3 — exchanges the passcode for a stored session. Returns no secret. |
| `kia_forget_session` | Discards the stored token so the bootstrap can be re-run. Local only; confirm-gated. |
| `kia_export_refresh_token` | Returns the `rmtoken` **in plaintext** — a full MFA bypass. Exists only to move a session into the hosted connector. Confirm-gated. |

### Reads

| Tool | Notes |
|---|---|
| `kia_list_vehicles` | Every enrolled vehicle with its `vehicleKey`, nickname, model, mileage. VINs are masked to the last 6 characters. |
| `kia_vehicle_status` | Cached status: door lock, ignition (`ign3` — on an EV `engine` stays false), the nested `climate` block, and more with `include_raw`. Fast, but only as fresh as the last upload. |
| `kia_refresh_status` | Wakes the telematics unit for a fresh reading. Slower, draws a little power, and returns no data itself — read `kia_vehicle_status` afterwards. |
| `kia_vehicle_location` | Last reported position plus a map link. Not a live GPS fix. |
| `kia_charge_targets` | Target state of charge per plug type. |

### Commands

| Tool | Mode | Notes |
|---|---|---|
| `kia_start_climate` | `comfort` | Preconditioning. Temperature is best-effort: the car may report its own last-set target instead of the one requested. |
| `kia_stop_climate` | `comfort` | Verified by re-reading `climate.airCtrl`. |
| `kia_start_charge` | `comfort` | Verified. Needs the car plugged in — unplugged, Kia accepts the request and nothing happens. Confirm via `evStatus.batteryCharge`. |
| `kia_stop_charge` | `comfort` | Verified. Confirm via `evStatus.batteryCharge`. |
| `kia_set_charge_limits` | `comfort` | Verified, and re-read against `evc/gts` afterwards. Send both plug types — the list replaces the stored one. |
| `kia_lock_doors` | `all` | Verified by re-reading `doorLock`. |
| `kia_unlock_doors` | `all` | Leaves the car physically unsecured. Only run it when the user explicitly asked. |

The four door/climate endpoints and both reads were verified live against a 2024 EV9 on 2026-07-27; the three `evc/*` command endpoints were not, and every tool that touches one says so in its description *and* in its result. The full protocol write-up is in [`docs/KIA-API.md`](docs/KIA-API.md).

## Hosted connector

The same tools can run as a Cloudflare Worker for use as a remote connector on [claude.ai](https://claude.ai). The MFA bootstrap cannot work there (the passcode arrives minutes later, on another device), so you bootstrap locally, export the token with `kia_export_refresh_token`, and hand it to the connector's login page, which stores it in your encrypted credentials. See [`docs/DEPLOY-CONNECTOR.md`](docs/DEPLOY-CONNECTOR.md).

## Development

```bash
npm test              # unit tests (no network — fetch is mocked throughout)
npm run test:coverage # the same, with the enforced 100% thresholds
npm run build         # tsc + esbuild bundle
npm run worker:test   # the hosted-connector suite, under the Workers runtime
```

## License

[MIT](LICENSE)
