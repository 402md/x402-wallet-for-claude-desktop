# CLAUDE.md

## Versioning

When creating a new release tag (e.g. `v0.1.5`), always update the `version` field in `package.json` to match. The `.mcpb` installer reads the version from `package.json`, so if it's not bumped the installer will show a stale version.
