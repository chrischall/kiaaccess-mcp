// Single source of truth for the server version. release-please rewrites the
// literal below on release; every manifest that carries a version is listed in
// release-please-config.json's extra-files and is kept in lockstep by
// tests/version-sync.test.ts.
//
// Keep the release marker comment on the export line only — the version-sync
// test scans every line carrying that marker and fails any that has no version
// literal on it, including prose in comments.
export const VERSION = '0.4.1'; // x-release-please-version
