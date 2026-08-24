# Local updater verification

The updater test flavor compiles the same updater and restart code as a release while using a local HTTP endpoint and a separate test key. Normal local bundles remain updater-free.

## Exercise a real installed update

```text
pnpm updater:test:keygen
pnpm updater:test:build windows 0.0.3
pnpm updater:test:build windows 0.0.4
pnpm updater:test:build windows 0.1.0
pnpm updater:test:exercise windows 0.0.3 0.1.0
pnpm updater:test:exercise windows 0.0.4 0.1.0
```

Use `macos` or `linux` in all three platform positions on those operating systems. Both versions must have sections in `tests/updater/CHANGELOG.md`.

The key command is safe to repeat: it reuses a complete existing test key pair and rejects an incomplete pair. Builds are copied to `.local/updater-test/builds/<platform>/<version>/` and are ignored by Git.
Repeating a build for the same platform and version atomically replaces that version's test artifacts after the new artifacts have been copied successfully. Other versions are left unchanged.

`exercise` performs the environment setup needed for a real-client check:

- On Windows, silently uninstalls any previous isolated test installation, then installs the old NSIS package for the current user.
- On macOS or Linux, selects the old `.app` or AppImage.
- Starts the local server with the real new updater artifact and its real adjacent signature.
- Delays every update-manifest response by three seconds so the checking spinner remains observable.
- Streams the updater artifact over 10 seconds and prints a terminal countdown so the download UI remains observable.
- Launches the old application while keeping the server alive.

The application checks automatically shortly after startup. Exercise both changelog layouts:

- `0.0.4` to `0.1.0` shows only the short `0.1.0` section and must not need a scrollbar.
- `0.0.3` to `0.1.0` shows `0.1.0` and the long `0.0.4` section in that order, must have a changelog scrollbar, and must not show `0.0.3`, `0.0.2`, or `0.0.1`.

Choose Download and install, observe the ten-second progress bar in the same dialog, and wait for the application to relaunch. About must then show version `0.1.0`. Keep the terminal running until relaunch succeeds, then stop it with Ctrl+C.

The updater test application has a separate product name, application identifier, deep-link scheme, and data directory at `.local/updater-test/data`, with no file association or thumbnail extension. It does not replace the normal Flow Reader installation, library data, or system integration. Test builds use Cargo's default release profile for iteration speed; formal release bundles use the optimized profile in `scripts/bundle-cargo.ts`.

## Optional development UI iteration

After building the target updater artifact, serve it in terminal A:

```text
pnpm updater:test:serve windows 0.1.0
```

Start the updater-enabled development app with an older version in terminal B:

```text
pnpm updater:test:dev 0.0.3
```

This path uses the same real manifest, artifact, signature, changelog parser, updater code, and restart permission, but only the installed `exercise` path proves installer replacement and relaunch.
