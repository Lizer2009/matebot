# Mobile builds and store releases

Matebot's public repository does not contain production App Store Connect,
Google Play, Apple team, or private EAS submission identifiers. Those values
belong in the release operator's private configuration.

Self-hosters normally do not need to publish their own mobile app: the Matebot
client can select a compatible server from the sign-in screen. If you distribute
your own branded build, use your own Expo and store accounts.

This fork's own build is linked in `apps/mobile/app.json` to the Expo project
`@lizer-expo/matebot` (project id `4d08d2e7-5be4-4446-a430-8781f9203fae`), with
scheme `matebot`, iOS bundle id `com.matebot.app` and Android package
`com.matebot.app`. The `EXPO_TOKEN` Actions secret must grant access to it.

## Configure a build

1. Link `apps/mobile` to an Expo project owned by your account.
2. Choose unique iOS and Android application identifiers.
3. Configure `EXPO_PUBLIC_API_URL` in the EAS build environment. Production
   builds require a valid HTTPS URL.
4. Keep store application IDs, team IDs, signing credentials, API keys, and
   review-account credentials out of Git.
5. Before a native iOS or Android build, run
   `pnpm --filter @matebot/mobile exec expo install --check`. Attachment pickers
   and other Expo native modules must match the SDK (SDK 57 needs
   `expo-image-picker@~57.0.11`, not 17.x). Use `pnpm exec expo install --fix`
   from `apps/mobile` if that check fails.

From `apps/mobile`:

```sh
eas project:init
eas env:create --environment production --name EXPO_PUBLIC_API_URL --value https://app.example.com --visibility plaintext
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

EAS can prompt for store identity interactively. For automated submission, add
the required identifiers through a private CI configuration or a short-lived
local change that is never committed.

Before submission, verify the production API, account deletion, sign-in,
notifications, store privacy answers, age rating, screenshots, support page,
and review account on a physical device.

## Release

Bump `expo.version` in `apps/mobile/app.json` when native code changes (see
Over-the-air updates below), then run the `release-mobile` workflow from `main`
with the App Store "What's New" text. It builds iOS on EAS, uploads it to App
Store Connect, puts the build on that App Store version with the notes, and
submits it for review; Apple releases it once approved. The same run publishes
the Android APK below.

It needs these repository secrets:

- `EXPO_TOKEN`: an Expo access token for the project.
- `ASC_APP_ID`: the app's Apple ID, shown under App Information in App Store
  Connect.
- `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY`: an App Store Connect API
  key with the App Manager role, from Users and Access > Integrations. The
  private key is the contents of the downloaded `.p8` file.

Re-running it for a version that is already in review leaves that submission
alone.

## Android APK

For manual installation, an APK remains available. `release-mobile` publishes it,
or run the `release-android-apk` workflow from `main` on its own:

```sh
gh workflow run release-android-apk.yml --repo Lizer2009/matebot --ref main
gh run list --repo Lizer2009/matebot --workflow release-android-apk.yml --limit 3
```

It builds the `android-apk` EAS profile, signed with the project's managed
keystore, and replaces the rolling `android` GitHub release, so the download link
stays the same:

```text
https://github.com/Lizer2009/matebot/releases/download/android/matebot.apk
```

The marketing site hands out that file from `/api/download?platform=android`,
which reads the `android` release by tag (not `releases/latest`, which the desktop
updater owns). The homepage and the download page link to that redirect without
checking GitHub at build time, so the first published APK needs no site rebuild;
until one exists the redirect falls back to the releases page instead of a dead
link.

The APK uses the production update channel, so JavaScript changes reach it
through the over-the-air updates below without a new APK. The rolling release is
never GitHub's "latest", so a desktop release stays the newest download.

Do not assemble a release APK with local Gradle on a low-memory Linux host: it
OOMs or hangs in Kotlin compile. Prefer this EAS workflow. If a local Gradle
attempt is already running, how to stop it and what to delete is in
[local-test-packaging.md](./local-test-packaging.md).

## Android push

For Android push notifications, create a Firebase project and register the app's
Android package. Download `google-services.json` and, from `apps/mobile`, store
it as an EAS file environment variable:

```sh
eas env:set production --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret
```

Keep the file and credentials out of Git. Upload an FCM V1 service account key
with `eas credentials` under Android > Google Service Account > FCM V1. Then
rebuild the APK: Firebase configuration is native, so an OTA update cannot add
it to an existing binary. Without the variable the `release-android-apk` workflow
still builds and publishes the APK, logs a warning, and the installed app simply
receives no push while closed: builds without it remain supported.

## Over-the-air updates

Production and preview builds include `expo-updates` and use the corresponding
EAS Update channel. The runtime version follows the public app version, so bump
`expo.version` whenever native code, config plugins, permissions, or native
dependencies change, then create and submit new store builds.

After the full GitHub Actions test suite passes on `main`, CI publishes a
production OTA update when the revision only changes the mobile JavaScript,
TypeScript, or bundled CSS. CI deliberately skips OTA publishing when native
configuration, modules, dependencies, assets, or the update workflow changed.
The repository needs an `EXPO_TOKEN` Actions secret with access to the linked
Expo project.

To publish a compatible update manually from `apps/mobile`:

```sh
eas update --platform all --channel production --environment production --message "Short description"
```

Installed release builds download a compatible update in the background on
launch and apply it after the next restart. Builds created before
`expo-updates` was configured cannot receive OTA updates and must be replaced
with a new iOS and Android build once.
