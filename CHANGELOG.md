# Changelog

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
