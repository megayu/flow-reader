# Flow Reader shell integrations

This directory owns the native Windows and macOS components that render EPUB thumbnails outside the Flow Reader process, plus packaged-application validation for platform shell integration.

It is intentionally isolated from the main Tauri crate and is built only by explicit thumbnail or installed-package commands.

## Components

| Path | Responsibility | Output |
|---|---|---|
| `windows-provider/` | Rust COM server implementing `IInitializeWithStream` and `IThumbnailProvider`. | `FlowReaderThumbnail.dll` |
| `macos-ffi/` | Rust C ABI wrapper around the shared EPUB thumbnail renderer. | `libflow_thumbnail_macos.a` |
| `macos-extension/` | Swift Quick Look Thumbnail Extension and its Xcode project. | `FlowReaderThumbnail.appex` |
| `packaging/windows/` | Production NSIS hook template and generated-config preparation. | Ignored files under `dist/windows/` |
| `tests/windows/` | Installed NSIS lifecycle validation. | Test-only installers under `dist/windows/lifecycle/` |
| `tests/macos/` | Bundled extension, signing, registration, and Quick Look validation. | Temporary test app and thumbnail |
| `tests/linux/` | AppImage contents and direct-open validation. | Temporary extracted package and app data |

The Cargo manifest at this directory is a virtual workspace for the Windows provider and macOS Rust FFI package.

Both packages depend on `crates/epub-thumbnail`; neither depends on `src-tauri`.

The native providers render only raster EPUB covers in JPEG, PNG, GIF, or WebP format. SVG covers and EPUBs without a cover deliberately return no thumbnail so the operating system can fall back to the associated application icon without carrying SVG or font-rendering engines in the provider.

The Xcode project consumes the universal Rust static library generated under `dist/macos/`.

## Build commands

Run these commands from the repository root.

```text
pnpm thumbnail:check
pnpm thumbnail:build:windows
pnpm thumbnail:build:macos
pnpm bundle:windows:installed
pnpm bundle:macos:installed
pnpm bundle:linux:installed
```

The two `thumbnail:build:*` commands build platform components for development and real-machine testing.

The Windows and macOS `bundle:*:installed` commands produce local-use packages and are the only commands that embed thumbnail components. Successful public bundle commands move their final application artifacts to `release/`.

The Linux command produces an AppImage that declares `application/epub+zip` and accepts selected EPUB paths; it intentionally does not package a thumbnailer because Linux desktop environments do not share one portable thumbnail extension contract.

Developer builds use Cargo's default `release` settings.

Application bundle commands inject `opt-level=3`, LTO, one codegen unit, symbol stripping, and aborting panics into the existing Cargo `release` profile. Bundled thumbnail providers use the size-oriented `opt-level=z`, fat LTO, one codegen unit, and symbol stripping while retaining panic unwinding because both FFI boundaries catch panics. Both paths reuse the default target directories; the project does not define a second publish profile.

On x64 Windows, the NSIS application build uses `src-tauri/target/release`; only the x64 COM provider uses its explicit target-triple directory.

The macOS installed application remains a universal target and therefore cannot reuse a single-architecture host output directory.

Ordinary `pnpm tauri:build` does not build this workspace or the Xcode extension. It is a compile validation command, not a supported portable distribution.

Installed commands build the local-use distribution shape. CI invokes the parallel `bundle:*:release:tauri` stages for tagged releases so future release-only capabilities, such as automatic updates, do not leak into local packages. Both shapes currently contain the same application features.

## Stable platform identities

`windows-identifiers.json` is the canonical source for the Windows provider CLSID, Microsoft's thumbnail handler category GUID, and the Flow Reader EPUB ProgID.

The provider build validates that manifest and generates its Rust CLSID constant, while `prepare-nsis.ps1` uses the same values to generate installer hooks.

The Windows provider CLSID is a permanent product identity and must not change between upgrades after public release.

The Windows thumbnail handler category GUID is owned by Microsoft and must never be replaced with a generated GUID.

Cargo emits the internal compiler artifact `flow_reader_thumbnail.dll` under `target/`. The distribution build copies it to `dist/windows/FlowReaderThumbnail.dll`; signing, CI uploads, NSIS input, and the installed provider all use that canonical product name.

The installed Windows provider uses the stable name `FlowReaderThumbnail.dll` beside `Flow Reader.exe`; NSIS uses the internal temporary name `FlowReaderThumbnail.pending.dll` only while replacing a loaded provider and schedules the stable-path replacement for reboot when required.

The macOS extension bundle identifier must remain under the final main application bundle identifier and must be updated together with it before the first public release.

The `tauri.shell-windows.conf.json`, `tauri.shell-macos.conf.json`, and `tauri.shell-linux.conf.json` files are partial Tauri overlays passed explicitly with `--config`; only the complete `tauri.conf.json` declares the Tauri JSON schema.

Build output under `target/`, generated packaging files under `dist/`, and Xcode DerivedData are ignored and must not be committed.
