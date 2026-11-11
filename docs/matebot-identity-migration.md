# Matebot identity migration

Every identity in this repository uses Matebot naming. A deployment created under the previous
names needs one pass to reach it. This page is the input for that pass; nothing here runs on its own.

## What changed

| Identity | Before | Now |
| --- | --- | --- |
| Settings | `RAKAZO_*` | `MATEBOT_*` |
| Migration role / app role / database | `rakazo`, `rakazo_app`, `rakazo` | `matebot`, `matebot_app`, `matebot` |
| Compose project (images stack) | `rakazo` | `matebot` |
| Compose project (production stack) | `rakazo-prod` | `matebot-prod` |
| Volumes | `rakazo_pgdata`, `rakazo_appdata`, `rakazo_webassets` | `pgdata`, `appdata`, `webassets` |
| Images | `ghcr.io/elie222/rakazo/{app,computer,updater}` | `ghcr.io/lizer2009/matebot/{app,computer,updater}` |
| Client headers | `x-rakazo-*` | `x-matebot-*` |
| Storage keys | `rakazo.<key>` | `matebot.<key>` |
| Sandbox bridge prefix | `rakazo-c` | `matebot-` |
| PITR helper / spool | `rakazo-pitr`, `/var/lib/rakazo-pitr` | `matebot-pitr`, `/var/lib/matebot-pitr` |
| Capture library | `librakazo-xcapture.so`, `rakazo_xcapture_*` | `libmatebot-xcapture.so`, `matebot_xcapture_*` |
| systemd units, APT drop-ins, helper commands | `rakazo-*` | `matebot-*` |
| Plugin gettext catalog | `rakazo-web` | `matebot-web` |

Client-side names (local storage, native module registration, notification channels) changed with
the release that ships them, so an upgraded client migrates itself. Server-side names did not: a
deployment keeps the objects it already has until an operator moves them.

## Migration order

Do these in order. Each step is verifiable before the next one starts.

1. **Back up.** Run `infra/compose/backup-prod.sh` and confirm the dump restores into a scratch database.
2. **Rename the settings.** Rewrite `.env`: prefix every `RAKAZO_` with `MATEBOT_`. Check the file
   for any name the tables above do not mention and decide it explicitly.
3. **Rename the database objects.** With the stack stopped:
   ```sql
   ALTER ROLE rakazo_app RENAME TO matebot_app;
   ALTER ROLE rakazo RENAME TO matebot;
   ALTER DATABASE rakazo RENAME TO matebot;
   ```
   The application connects as `matebot_app`, so its grants and row-level policies follow the role.
4. **Move the volumes.** Stop the stack, then rename each volume rather than letting Compose create
   an empty one:
   ```sh
   docker volume create matebot_pgdata
   docker run --rm -v rakazo_pgdata:/from -v matebot_pgdata:/to alpine \
     sh -c 'cd /from && cp -a . /to/'
   ```
   Repeat for the app and webasset volumes. Keep the old volumes until the new stack is verified.
5. **Update the install.** Re-run `install-images-matebot.sh` so the compose project and the image
   defaults come from the new names, then start the stack.
6. **Confirm.** The checks below should all pass.

## Acceptance checks

- `docker compose ls` shows `matebot` (or `matebot-prod`) and no project under the old name.
- The API answers `GET /health` and the web app loads.
- A bot run completes, which proves the database role, the encryption keys, and the worker all match
  the data that was migrated rather than a fresh empty database.
- An existing passkey still signs in. Server-side passkey settings moved with `MATEBOT_PASSKEY_RP_ID`;
  a passkey registered against a different domain needs re-registration, as it always has.
- `restrict-computer-egress.sh --print` shows `matebot-` interfaces, and a computer starts with
  restricted networking on.
- A backup taken after the migration restores, which proves the PITR spool path matches the image.

## What is not migrated

Nothing on the old names is kept as an alias. A deployment that skips a step does not silently fall
back: it fails to find its keys, its database, or its volumes, and says so. That is deliberate — an
alias would leave the old name in the product forever, which is what this migration removes.

Upstream attribution is not part of this migration. `LICENSE`, `NOTICE`, and the credit lines in
the READMEs name the project this fork came from, and they stay.
