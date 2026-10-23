# Changelog

## 1.0.3

- Focus stays in the input after typing the delimiter, so several tags can be typed in a row without clicking the box again.

## 1.0.2

- Configuration is split into individual properties (Tag table, Tag name column, Bridge table, lookups, delimiter, max tags, …) because the form designer limits static values to 100 characters. The legacy `config` JSON is still supported.

## 1.0.1

- Maintenance release: record id / table name resolved from the form context.

## 1.0.0

- First public release.
- Strict validation of the `config` JSON with explicit error messages.
- GUID validation for `entityId` and server ids.
- Server privileges are no longer reset on every `updateView`.
- `refresh` is fully guarded: on any Dataverse error the control falls back to the text column instead of rendering empty.
- Tolerant privilege check for hosts that do not implement `hasEntityPrivilege`.
- Metadata lookups validated (`PrimaryIdAttribute`, `EntitySetName`).
- Delimiter is stripped from tag names; whitespace normalized.
- Output change notified only when the value actually changes.
- Fixed CSS resource path casing in the manifest.
