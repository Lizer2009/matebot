# Desktop icons

The shared icon sources and export notes are in
[`packages/ui-tokens/assets`](../../../packages/ui-tokens/assets/README.md).

Mac packaging requires Xcode 26 or newer. Electron builder compiles `Matebot.icon` into
`Assets.car` for Tahoe and generates `icon.icns` for older macOS versions.
`icon-macos.png` is the matching development export with Dock margins.

`icon.png` and `icon.ico` are the Matebot exports for Linux and Windows. Refresh them with
`pnpm --filter @matebot/ui-tokens export:matebot`.
