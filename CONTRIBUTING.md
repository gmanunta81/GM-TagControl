# Contributing

1. Fork and create a branch (`feature/xyz`).
2. `npm install` then `npm run build` and `npm run lint` must pass.
3. Test with `npm start watch` and in a real Dataverse environment (`pac pcf push`).
4. Bump `version` in `TagControl/ControlManifest.Input.xml` and update `CHANGELOG.md`.
5. Open a pull request describing the change and the tables used for testing.
