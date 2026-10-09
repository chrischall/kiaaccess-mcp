/**
 * The one vehicle-key atom every vehicle-scoped tool validates with.
 *
 * The key is the `vehicleKey` from `kia_list_vehicles`; every call sends it as
 * the `vinkey` HEADER (and `cmm/gvi` also in the body). Two constraints, both
 * needed: mcp-utils' {@link SafePathSegment} floor (no `/ ? #`, whitespace or
 * `..`), and printable ASCII only (`!`–`~`) so a caller-supplied value can never
 * smuggle a CRLF or a non-ByteString character into the header block. Real keys
 * satisfy both; the cap is generous.
 */

import { SafePathSegment } from '@chrischall/mcp-utils';

export const VehicleKey = SafePathSegment.max(200).regex(
  /^[!-~]+$/,
  'the vehicle key must be printable ASCII with no whitespace or control characters',
);
