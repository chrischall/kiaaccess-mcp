# Ready-to-run requests

Every shape here was verified live on 2026-07-27 against a 2024 Kia EV9, except
the `evc/*` commands, which are flagged UNVERIFIED.

## Header helper

Source this first. It regenerates the mandatory `date` per call and keeps the
device id stable.

```bash
KIA_BASE='https://api.owners.kia.com/apigw/v1'
: "${KIA_DEVICE:?export KIA_DEVICE=\$(uuidgen) first}"

kia_headers() {
  # usage: kia_headers [extra-header ...]
  local off; off=$(( $(date +%z | cut -c1-3) ))
  printf '%s\n' \
    "content-type: application/json;charset=utf-8" \
    "accept: application/json" \
    "accept-language: en-US,en;q=0.9" \
    "accept-charset: utf-8" \
    "apptype: L" "appversion: 7.22.0" "clientid: SPACL716-APL" \
    "clientuuid: ${KIA_DEVICE}" "deviceid: ${KIA_DEVICE}" \
    "from: SPA" "host: api.owners.kia.com" "language: 0" \
    "offset: ${off}" "ostype: iOS" "osversion: 15.8.5" "phonebrand: iPhone" \
    "secretkey: sydnat-9kykci-Kuhtep-h5nK" "to: APIGW" "tokentype: A" \
    "date: $(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S GMT')" \
    "user-agent: KIAPrimo_iOS/37 CFNetwork/1335.0.3.4 Darwin/21.6.0" \
    "$@" | sed 's/^/-H\n/'
}

# curl wrapper: kia_curl <method> <path> [body] -- [extra headers...]
kia_curl() {
  local method="$1" path="$2" body="${3:-}"; shift 3 2>/dev/null || shift 2
  [ "${1:-}" = "--" ] && shift
  local args=(); while IFS= read -r line; do args+=("$line"); done < <(kia_headers "$@")
  curl -sS -X "$method" "${KIA_BASE}/${path}" "${args[@]}" \
    ${body:+--data "$body"} -D /tmp/kia_hdrs --compressed
}
```

`secretkey` is a **static app constant**, not a user secret — it is the same for
every install.

## 1. Login (one-time MFA)

```bash
# Step 1 — authenticate. Captures otpKey (body) and xid (RESPONSE HEADER).
kia_curl POST prof/authUser "$(jq -nc \
  --arg u "$KIA_USERNAME" --arg p "$KIA_PASSWORD" \
  '{deviceKey:"",deviceType:2,userCredential:{userId:$u,password:$p},tncFlag:1}')" \
  | tee /tmp/kia_auth.json | jq '.status, .payload.nextAction'

OTPKEY=$(jq -r '.payload.otpKey' /tmp/kia_auth.json)
XID=$(grep -i '^xid:' /tmp/kia_hdrs | tr -d '\r' | cut -d' ' -f2)
```

> Stop here if `status.errorCode` is `1001` or `1037`. Fix the credential — do
> **not** loop. Repeated failures set `enforceRecaptcha` and permanently break
> shell login.

```bash
# Step 2 — send the code. notifytype is SMS or EMAIL.
kia_curl POST cmm/sendOTP '{}' -- \
  "otpkey: $OTPKEY" "notifytype: SMS" "xid: $XID" | jq '.status, .payload.message'

# Step 3 — verify. sid + rmtoken come back as RESPONSE HEADERS.
read -r -p 'code: ' CODE
kia_curl POST cmm/verifyOTP "$(jq -nc --arg o "$CODE" '{otp:$o}')" -- \
  "otpkey: $OTPKEY" "xid: $XID" | jq '.status'

SID=$(grep -i '^sid:'     /tmp/kia_hdrs | tr -d '\r' | cut -d' ' -f2)
RMTOKEN=$(grep -i '^rmtoken:' /tmp/kia_hdrs | tr -d '\r' | cut -d' ' -f2)

mkdir -p ~/.kiaaccess-mcp && chmod 700 ~/.kiaaccess-mcp
jq -nc --arg r "$RMTOKEN" --arg d "$KIA_DEVICE" '{rmtoken:$r,deviceId:$d}' \
  > ~/.kiaaccess-mcp/session.json
chmod 600 ~/.kiaaccess-mcp/session.json
```

## 2. Refresh — no MFA, use this every other time

```bash
RMTOKEN=$(jq -r .rmtoken ~/.kiaaccess-mcp/session.json)
KIA_DEVICE=$(jq -r .deviceId ~/.kiaaccess-mcp/session.json)

kia_curl POST prof/authUser "$(jq -nc \
  --arg u "$KIA_USERNAME" --arg p "$KIA_PASSWORD" --arg d "$KIA_DEVICE" \
  '{deviceKey:$d,deviceType:2,userCredential:{userId:$u,password:$p}}')" \
  -- "rmtoken: $RMTOKEN" | jq '.status.statusCode'

SID=$(grep -i '^sid:' /tmp/kia_hdrs | tr -d '\r' | cut -d' ' -f2)
```

The `rmtoken` is **not** rotated — the stored one keeps working.

## 3. Reads

```bash
# Vehicle list -> vinkey
kia_curl GET ownr/gvl '' -- "sid: $SID" | tee /tmp/kia_gvl.json \
  | jq '.payload.vehicleSummary[] | {nickName, modelYear, modelName, mileage, vehicleKey}'
VIN=$(jq -r '.payload.vehicleSummary[0].vehicleKey' /tmp/kia_gvl.json)
```

```bash
# Cached status. airTempRange/seatHeatCoolOption = "1" or the climate block is ABSENT.
GVI=$(jq -nc --arg v "$VIN" '{
  vehicleConfigReq:{airTempRange:"1",maintenance:"1",seatHeatCoolOption:"1",
                    vehicle:"1",vehicleFeature:"1"},
  vehicleInfoReq:{drivingActivty:"0",dtc:"1",enrollment:"1",functionalCards:"0",
                  location:"1",vehicleStatus:"1",weather:"0"},
  vinKey:[$v]}')

kia_curl POST cmm/gvi "$GVI" -- "sid: $SID" "vinkey: $VIN" > /tmp/kia_gvi.json

# The fields worth looking at
jq '.payload.vehicleInfoList[0].lastVehicleInfo.vehicleStatusRpt.vehicleStatus
    | {doorLock, ign3, engine,
       climate: {airCtrl: .climate.airCtrl, temp: .climate.airTemp.value},
       battery: .evStatus.batteryStatus,
       range:   .evStatus.drvDistance[0].rangeByFuel.totalAvailableRange.value,
       synced:  .syncDate.utc}' /tmp/kia_gvi.json
```

`drivingActivty` is **misspelled in Kia's API**. Correcting it drops the field.

```bash
# Location
jq '.payload.vehicleInfoList[0].lastVehicleInfo.location
    | {lat: .coord.lat, lon: .coord.lon, synced: .syncDate.utc}' /tmp/kia_gvi.json

# Force a fresh read from the vehicle (slow — wakes the telematics unit)
kia_curl POST rems/rvs '{"requestType":0}' -- "sid: $SID" "vinkey: $VIN" | jq '.status'

# EV charge targets (AC and DC)
kia_curl GET evc/gts '' -- "sid: $SID" "vinkey: $VIN" \
  | jq '.payload.targetSOClist[] | {plugType, targetSOClevel}'
```

## 4. Commands

```bash
# Snapshot the fields you intend to prove changed — NEVER include syncDate.
kia_state() {
  kia_curl POST cmm/gvi "$GVI" -- "sid: $SID" "vinkey: $VIN" \
    | jq -c '.payload.vehicleInfoList[0].lastVehicleInfo.vehicleStatusRpt.vehicleStatus
             | {doorLock, ign3, airCtrl: .climate.airCtrl}'
}
BEFORE=$(kia_state); echo "before: $BEFORE"
```

```bash
# Doors — VERIFIED
kia_curl GET rems/door/lock   '' -- "sid: $SID" "vinkey: $VIN" | jq '.status.statusCode'
kia_curl GET rems/door/unlock '' -- "sid: $SID" "vinkey: $VIN" | jq '.status.statusCode'

# Climate on — VERIFIED. duration is minutes; temperature is best-effort (see below).
kia_curl POST rems/start "$(jq -nc '{remoteClimate:{
    airTemp:{unit:1,value:"70"}, airCtrl:true, defrost:false,
    heatingAccessory:{rearWindow:0,sideMirror:0,steeringWheel:0,steeringWheelStep:0},
    ignitionOnDuration:{unit:4,value:10}}}')" \
  -- "sid: $SID" "vinkey: $VIN" | jq '.status.statusCode'

# Climate off — VERIFIED
kia_curl GET rems/stop '' -- "sid: $SID" "vinkey: $VIN" | jq '.status.statusCode'
```

Omit `heatVentSeat` unless you know the car supports the seats you name — Kia
validates seat capability per vehicle.

```bash
# UNVERIFIED — shapes from the OSS client, never run against a real vehicle
kia_curl POST evc/charge '{"chargeRatio":100}' -- "sid: $SID" "vinkey: $VIN"
kia_curl GET  evc/cancel ''                    -- "sid: $SID" "vinkey: $VIN"
kia_curl POST evc/sts '{"targetSOClist":[{"plugType":0,"targetSOClevel":80},
                                          {"plugType":1,"targetSOClevel":90}]}' \
  -- "sid: $SID" "vinkey: $VIN"
```

## 5. Prove it landed

```bash
# Poll the re-read. This — not cmm/gts — is the proof.
for i in $(seq 1 9); do
  sleep 10
  AFTER=$(kia_state)
  [ "$AFTER" != "$BEFORE" ] && { echo "changed: $BEFORE -> $AFTER"; break; }
  [ "$i" = 9 ] && echo "NO observed change in ~90s: $AFTER"
done
```

`plugType` 0 and 1 are the two charge connectors; `targetSOClevel` is a percentage.

## Error quick-reference

| errorCode | Meaning | Do |
| --- | --- | --- |
| `0` | success | — |
| `9200` | missing mandatory header | regenerate `date`; it must be fresh RFC-1123 |
| `1001` | invalid email or password | fix it; **do not retry in a loop** |
| `1037` | invalid email address | check the address format/domain |

Session expired (a previously-working `sid` starts failing) → re-run §2. It needs
no MFA.
