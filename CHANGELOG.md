# Changelog

## [0.7.0](https://github.com/chrischall/kiaaccess-mcp/compare/v0.6.2...v0.7.0) (2026-08-31)


### Features

* **tools:** add kia_healthcheck ([#57](https://github.com/chrischall/kiaaccess-mcp/issues/57)) ([6c796f8](https://github.com/chrischall/kiaaccess-mcp/commit/6c796f8ca225d7419c0bdc7ab50ec08e62c467bb))

## [0.6.2](https://github.com/chrischall/kiaaccess-mcp/compare/v0.6.1...v0.6.2) (2026-08-26)


### Documentation

* **skill:** declare the name this skill actually publishes under ([#52](https://github.com/chrischall/kiaaccess-mcp/issues/52)) ([8b8ec75](https://github.com/chrischall/kiaaccess-mcp/commit/8b8ec758f8d6392673d7ca1c2898f1f6b72aa90c))

## [0.6.1](https://github.com/chrischall/kiaaccess-mcp/compare/v0.6.0...v0.6.1) (2026-08-11)


### Bug Fixes

* **session:** stop kia_forget_session hiding a valid KIA_RMTOKEN ([#43](https://github.com/chrischall/kiaaccess-mcp/issues/43)) ([639a90e](https://github.com/chrischall/kiaaccess-mcp/commit/639a90ef8f00f94c2846ed336ed6fc95b7e9ee1a)), closes [#41](https://github.com/chrischall/kiaaccess-mcp/issues/41)

## [0.6.0](https://github.com/chrischall/kiaaccess-mcp/compare/v0.5.1...v0.6.0) (2026-08-10)


### Features

* **session:** accept a bootstrapped rmtoken via KIA_RMTOKEN ([#40](https://github.com/chrischall/kiaaccess-mcp/issues/40)) ([5b3336a](https://github.com/chrischall/kiaaccess-mcp/commit/5b3336a57b86f4c114112f227c68ee8c29947321))

## [0.5.1](https://github.com/chrischall/kiaaccess-mcp/compare/v0.5.0...v0.5.1) (2026-08-07)


### Refactor

* **connector:** retire the standalone Cloudflare Worker connector ([#34](https://github.com/chrischall/kiaaccess-mcp/issues/34)) ([8bd6ad2](https://github.com/chrischall/kiaaccess-mcp/commit/8bd6ad29a9ded3998b35edfae1c7190e3aebca62))

## [0.5.0](https://github.com/chrischall/kiaaccess-mcp/compare/v0.4.1...v0.5.0) (2026-07-28)


### Features

* **vehicles:** report per-seat heat/vent state in kia_vehicle_status ([#28](https://github.com/chrischall/kiaaccess-mcp/issues/28)) ([34c11be](https://github.com/chrischall/kiaaccess-mcp/commit/34c11be3b84338820773a11d373474f65b9ad68f))

## [0.4.1](https://github.com/chrischall/kiaaccess-mcp/compare/v0.4.0...v0.4.1) (2026-07-28)


### Bug Fixes

* **client:** recover a rotated vinkey and accept a quoted temperature ([#23](https://github.com/chrischall/kiaaccess-mcp/issues/23)) ([400feb5](https://github.com/chrischall/kiaaccess-mcp/commit/400feb525c8b03bebf89b5d994752831a2f2bcb0))


### Documentation

* **connector:** correct the code-box behaviour on the login page ([#26](https://github.com/chrischall/kiaaccess-mcp/issues/26)) ([b349c44](https://github.com/chrischall/kiaaccess-mcp/commit/b349c443ea2ab4bf0ef0d3fdec3b54d3bcd712dd)), closes [#18](https://github.com/chrischall/kiaaccess-mcp/issues/18)

## [0.4.0](https://github.com/chrischall/kiaaccess-mcp/compare/v0.3.0...v0.4.0) (2026-07-28)


### Features

* **connector:** drop the error banner from the code prompt ([#20](https://github.com/chrischall/kiaaccess-mcp/issues/20)) ([43f15e2](https://github.com/chrischall/kiaaccess-mcp/commit/43f15e2507ee66061d426ba7f71759525211fbb0))
* **connector:** hide the code box until Kia has actually sent a code ([#17](https://github.com/chrischall/kiaaccess-mcp/issues/17)) ([fcb4945](https://github.com/chrischall/kiaaccess-mcp/commit/fcb49455354ba6938fe54116db530ea9c3fd743e))


### Bug Fixes

* **connector:** keep the code box revealed when OTP verification fails ([#21](https://github.com/chrischall/kiaaccess-mcp/issues/21)) ([9d994d0](https://github.com/chrischall/kiaaccess-mcp/commit/9d994d004aea4e67f3c85fdb34bd685b73c12148))

## [0.3.0](https://github.com/chrischall/kiaaccess-mcp/compare/v0.2.0...v0.3.0) (2026-07-28)


### Features

* **connector:** complete Kia's MFA in the login page, not by hand ([#10](https://github.com/chrischall/kiaaccess-mcp/issues/10)) ([30d42fc](https://github.com/chrischall/kiaaccess-mcp/commit/30d42fcca0c6542f6b17a3c208df84e0d615f286))
* **connector:** keep the form filled when Kia asks for the code ([#14](https://github.com/chrischall/kiaaccess-mcp/issues/14)) ([38b4018](https://github.com/chrischall/kiaaccess-mcp/commit/38b40181b4bb09bb02dccd5fc50af060f8bef3d7))


### Bug Fixes

* **deps:** override @hono/node-server to the patched 2.0.5+ ([#15](https://github.com/chrischall/kiaaccess-mcp/issues/15)) ([54f27c2](https://github.com/chrischall/kiaaccess-mcp/commit/54f27c21acf68014b42ada925f8c262bf28d9383))


### Documentation

* **charging:** record the documented plugType mapping, flagged as unconfirmed ([#16](https://github.com/chrischall/kiaaccess-mcp/issues/16)) ([4389684](https://github.com/chrischall/kiaaccess-mcp/commit/4389684725f7fb1c80541f9df5760346e2107f7d))
* **connector:** drop the last paste-flow references and pin the otp assertion ([#13](https://github.com/chrischall/kiaaccess-mcp/issues/13)) ([529dafd](https://github.com/chrischall/kiaaccess-mcp/commit/529dafda27492863e4065b8d8a305299a75932fa)), closes [#11](https://github.com/chrischall/kiaaccess-mcp/issues/11) [#6](https://github.com/chrischall/kiaaccess-mcp/issues/6)

## [0.2.0](https://github.com/chrischall/kiaaccess-mcp/compare/v0.1.0...v0.2.0) (2026-07-28)


### Features

* **charging:** verify evc commands against a real vehicle ([#5](https://github.com/chrischall/kiaaccess-mcp/issues/5)) ([0fff3c8](https://github.com/chrischall/kiaaccess-mcp/commit/0fff3c85949cf02ceccfa2ad8a6bda837a70cc38))
* **connector:** raise hosted KIA_WRITE_MODE to "all" ([#7](https://github.com/chrischall/kiaaccess-mcp/issues/7)) ([8956e6d](https://github.com/chrischall/kiaaccess-mcp/commit/8956e6d35e9b6c5a2cef14a4c41cf3e0553f6a79))
* **skills:** add kiaaccess-curl shell-out skill ([#2](https://github.com/chrischall/kiaaccess-mcp/issues/2)) ([8c62dd0](https://github.com/chrischall/kiaaccess-mcp/commit/8c62dd0cce1bdad297d8cb13118e1731c3d0e917))

## 0.1.0 (2026-07-28)


### Features

* Kia Access MCP server with vehicle status, doors, climate and charging ([11bc890](https://github.com/chrischall/kiaaccess-mcp/commit/11bc8902c4f63d2f5f13d680f6c3757db21e12b6))
