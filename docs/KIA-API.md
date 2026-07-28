# Kia Owners API (`api.owners.kia.com/apigw/v1/`)

Undocumented API behind the Kia Access iOS app. Every shape below was verified
live on 2026-07-27 against a real US account (EV9). No credentials, session
ids, VINs, or tokens appear in this file — only request/response *shapes*.

## Why not the iOS app capture, and why not the web portal

- **The iOS app pins its TLS certificate.** A mitmproxy capture on a stock
  iPhone fails with *"client disconnected during the handshake"* for
  `api.owners.kia.com` while `www.google.com` decrypts fine through the same
  proxy 13 seconds later. Pinning blocks *observing* the app; it does not block
  *being* a client, which is what this server does.
- **The web portal (`owners.kia.com`) is read-only.** Its dashboard exposes no
  lock/unlock/climate/charge controls, and the `apiurl` headers on its
  `apigwServlet.html` proxy show only read endpoints (`ownr/gvl`, `cmm/gvi`,
  `lbs/svm/inquire`, `ownr/ecu/ota/history`, `vrm/mnt/grd`, `alt/gas`,
  `notify/gurn`, `prof/gcp`, `bil/sub/getsub`) — never `rems/*` or `evc/*`.
  Its login also encrypts credentials client-side into an opaque blob, so it is
  not server-side reproducible. It did, however, independently corroborate the
  `cmm/gvi` body shape below.

## Static request headers

Sent on **every** call. Values are the current iOS client's and are accepted as
of 2026-07-27.

| Header | Value | Notes |
| --- | --- | --- |
| `content-type` | `application/json;charset=utf-8` | |
| `accept` | `application/json` | |
| `accept-language` | `en-US,en;q=0.9` | |
| `accept-charset` | `utf-8` | |
| `apptype` | `L` | |
| `appversion` | `7.22.0` | |
| `clientid` | `SPACL716-APL` | |
| `clientuuid` | `<device uuid>` | same as `deviceid` |
| `from` | `SPA` | |
| `host` | `api.owners.kia.com` | |
| `language` | `0` | |
| `offset` | `<gmt offset hours>` | e.g. `-4` |
| `ostype` | `iOS` | |
| `osversion` | `15.8.5` | |
| `phonebrand` | `iPhone` | |
| `secretkey` | `sydnat-9kykci-Kuhtep-h5nK` | static app key, not a user secret |
| `to` | `APIGW` | |
| `tokentype` | `A` | |
| `deviceid` | `<device uuid>` | stable per install |
| `date` | RFC 1123 UTC | **mandatory** |
| `user-agent` | `KIAPrimo_iOS/37 CFNetwork/1335.0.3.4 Darwin/21.6.0` | |

> **Omitting `date` fails the request** with
> `{"status":{"statusCode":1,"errorType":3,"errorCode":9200,"errorMessage":"Missing mandatory data in header"}}`.
> This is easy to miss because every other header can be present and the call
> still fails with a message that does not name the culprit.

Authenticated calls add `sid`; vehicle-scoped calls add `vinkey`.

## Auth — three-step MFA bootstrap, then silent refresh

Kia enforces MFA on password login. All four calls return HTTP 200; success is
signalled by `status.statusCode === 0`, **not** by the HTTP status.

### 1. `POST prof/authUser`

```json
{
  "deviceKey": "",
  "deviceType": 2,
  "userCredential": { "userId": "<email>", "password": "<password>" },
  "tncFlag": 1
}
```

Response `payload`:

```json
{
  "otpKey": "<45 chars>",
  "hasEmail": true, "hasPhone": true,
  "email": "<masked>", "phone": "<masked>",
  "emailVerifyStatus": true, "phoneVerifyStatus": true,
  "nextAction": "MFA_REQUIRED"
}
```

The **`xid` is in the response *headers***, not the body — it is required by
both following calls and is easy to overlook.

Credential failures (do not retry blindly — Kia counts attempts and escalates
to reCAPTCHA, which would break server-side login entirely):

| errorCode | errorMessage | Meaning |
| --- | --- | --- |
| `1001` | Invalid Email or Password | wrong credentials; `payload.loginAttempt` increments, `payload.enforceRecaptcha` flips once exceeded |
| `1037` | Please enter valid email address | email rejected on format/domain before credentials are checked |

### 2. `POST cmm/sendOTP`

Headers add `otpkey`, `xid`, and `notifytype` — **`SMS`** or **`EMAIL`**.
Body is `{}`.

Response `payload`: `{ "phone": "<masked>", "message": "OTP sent successfully", "expiresIn": <epoch ms> }`.
The window observed was **~2 minutes**.

### 3. `POST cmm/verifyOTP`

Headers add `otpkey`, `xid`. Body `{ "otp": "<6 digits>" }`.

Returns **`sid`** (36 chars) and **`rmtoken`** (45 chars) as *response headers*.

### 4. Refresh — `POST prof/authUser` with `rmtoken`

Headers add `rmtoken` (no `sid` needed). Body is the same credential payload as
step 1 minus `tncFlag`, with `deviceKey` set to the device uuid.

Returns a fresh `sid` header with **`nextAction` absent and no MFA challenge**.
The `rmtoken` is **not** rotated. This is what makes MFA a one-time bootstrap:
persist `rmtoken` and mint sids from it indefinitely.

## Read endpoints

### `GET ownr/gvl` — vehicle list

`payload.vehicleSummary[]`, fields used here:

| Field | Type | Notes |
| --- | --- | --- |
| `vehicleKey` | string | the `vinkey` for all vehicle-scoped calls |
| `vin` | string | |
| `nickName`, `modelName`, `modelYear`, `trim`, `colorName` | string | |
| `mileage` | string | |
| `fuelType` | number | EV detection |
| `telematicsUnit`, `enrollmentStatus`, `generation` | number | |

### `POST cmm/gvi` — cached vehicle status

Body (shape independently confirmed against the web portal's own traffic):

```json
{
  "vehicleConfigReq": {
    "airTempRange": "0", "maintenance": "1", "seatHeatCoolOption": "0",
    "vehicle": "1", "vehicleFeature": "0"
  },
  "vehicleInfoReq": {
    "drivingActivty": "0", "dtc": "1", "enrollment": "1",
    "functionalCards": "0", "location": "1", "vehicleStatus": "1", "weather": "0"
  },
  "vinKey": ["<vehicleKey>"]
}
```

> `drivingActivty` is misspelled in the API itself. Correcting it silently drops
> the field.

Response: `payload.vehicleInfoList[]` of `{ vinKey, vehicleConfig: { vehicleDetail, maintenance, billingPeriod }, lastVehicleInfo: { vehicleNickName, vehicleStatusRpt, location, activeDTC, enrollment, financed, linkStatus, rsaStatus, ... } }`.

### `POST rems/rvs` — force a fresh read from the vehicle

Body `{ "requestType": 0 }`. Slower; wakes the telematics unit.

### `GET evc/gts` — EV charge targets

Response: `payload.targetSOClist[]` of `{ plugType: number, targetSOClevel: number }`
(one entry per plug type — AC and DC).

### `POST cmm/gts` — global status flags (**not** a per-action poll)

Body `{ "xid": "<action id>" }`, where the action id came back as the **`Xid`
response header** of the command call.

> **Verified 2026-07-27 and it does not do what its usage implies.** Despite
> taking an `xid`, the response is not keyed to that action — it returns global
> flags:
>
> ```json
> { "alertStatus": 0, "remoteStatus": 1, "evStatus": 0,
>   "locationStatus": 0, "calSyncStatus": 0 }
> ```
>
> Polled five times over ~20s while a lock command completed, the payload never
> changed (`remoteStatus` stayed `1`). It never reports per-action success or
> failure, so **do not gate a command's result on it** — a client that waits for
> this to flip waits forever.
>
> **The only proof a command took effect is re-reading `cmm/gvi`** and comparing
> the relevant field. That is what the write tools here do.

## Command endpoints

All four door + climate commands were exercised against the live vehicle and
confirmed by re-reading `cmm/gvi` (verified 2026-07-27). The EV charge commands
remain unverified.

Every command takes `sid` + `vinkey` headers, returns
`{"status":{"statusCode":0,...,"errorMessage":"Success with response body"}}`,
and carries an action id in the **`Xid`** response header. State changes landed
within ~30–60s. Do **not** gate on `cmm/gts` (see above) — re-read `cmm/gvi`.

### Verified

| Endpoint | Method | Proven by | Observed |
| --- | --- | --- | --- |
| `rems/door/lock` | GET | `doorLock` | `false` → `true` |
| `rems/door/unlock` | GET | `doorLock` | `true` → `false` |
| `rems/start` | POST | `climate.airCtrl`, `ign3` | both `false` → `true` |
| `rems/stop` | GET | `climate.airCtrl`, `ign3` | both `true` → `false` |

`rems/start` body (seat settings deliberately omitted — Kia validates seat
capability per-car, and omitting the key is accepted):

```json
{ "remoteClimate": {
    "airTemp": { "unit": 1, "value": "70" },
    "airCtrl": true,
    "defrost": false,
    "heatingAccessory": { "rearWindow": 0, "sideMirror": 0,
                          "steeringWheel": 0, "steeringWheelStep": 0 },
    "ignitionOnDuration": { "unit": 4, "value": 5 } } }
```

### Verification fields — climate is NESTED

The climate state is **not** a flat `airCtrlOn`. It lives under
`vehicleStatusRpt.vehicleStatus.climate`:

```json
{ "airCtrl": false, "defrost": false,
  "airTemp": { "value": "72", "unit": 1 },
  "heatingAccessory": { "steeringWheel": 0, "sideMirror": 0,
                        "rearWindow": 0, "steeringWheelStep": 0 },
  "heatVentSeat": { "driverSeat": { "heatVentType": 0, "heatVentLevel": 1 }, … } }
```

Two traps that cost a false "verified" during this build:

1. **`airCtrlOn` does not exist.** Reading it yields `undefined`, which silently
   compares equal across a command and looks like "no change".
2. **`syncDate` advances on every read**, whether or not anything happened.
   Including it in a before/after comparison makes *every* command report
   success. Exclude it from change detection.

Also note **`engine` stays `false` on an EV** even with climate running — the
ignition proxy is **`ign3`**. Gating an EV's climate verification on `engine`
would always report failure.

> **Unconfirmed:** `airTemp.value` still read `"72"` after a start requesting
> `"70"`. The reported value may be the car's own last-set target rather than
> the remote request, or the temperature may not apply the way the body implies.
> Treat the temperature argument as best-effort until verified.

The `climate`/`heatVentSeat` fields only appear when `cmm/gvi` is called with
`vehicleConfigReq.airTempRange: "1"` and `seatHeatCoolOption: "1"`; with those
at `"0"` the whole `climate` object is absent.

### Unverified

| Endpoint | Method | Body |
| --- | --- | --- |
| `evc/charge` | POST | `{ "chargeRatio": 100 }` |
| `evc/cancel` | GET | — |
| `evc/sts` | POST | `{ "targetSOClist": [{ "plugType": 0\|1, "targetSOClevel": <int> }] }` |
