# Cloud Sync Indicator

GNOME Shell extension (GNOME 48): a status indicator for the
[“OneDrive Client for Linux”](https://github.com/abraunegg/onedrive) by abraunegg,
running as a systemd user service (`onedrive.service`).

> Not an official product; not affiliated with Microsoft. OneDrive is a trademark of Microsoft.

## Features

- **Status in the top bar:** up to date, syncing, paused, offline, sign-in required,
  resync required, error (including repeated restarts). On errors the icon changes color
  and a notification appears.
- **Menu:** open the OneDrive folder, edit the configuration, pause/start, restart,
  recent messages (number configurable, 1–30; by default only file operations such as
  uploads, downloads, deletions and moves), full log in a terminal.
- **Sign-in:** a dedicated sign-in window (WebKitGTK) that passes the response address of the
  Microsoft sign-in to the client by itself. Fallback: sign in using the browser and take the
  response address from the clipboard.
- **Resync:** when the client requires one (exit status 126), it can be started from the menu.
  It runs as a separate systemd unit and starts the service again afterwards.
- **Notice after configuration changes:** the client reads its configuration only at startup;
  after saving, a notification offers to restart it.
- **Languages:** English and German.

## Requirements

- GNOME Shell 48
- `onedrive` (abraunegg, tested with 2.5.4) with the user service `onedrive.service`
  and its configuration in `~/.config/onedrive`
- For the sign-in window: GJS with GTK 4, libadwaita and WebKitGTK 6.0
  (Debian/Ubuntu: `gir1.2-webkit-6.0`, `gir1.2-adw-1`, `gir1.2-gtk-4.0`).
  Without them, sign-in falls back to the browser.

## Privacy and access

- **Clipboard:** read only on click (“Sign in from clipboard”) and only in the browser fallback
  of the sign-in. The content is passed only to the local client.
- **Sign-in window:** an ephemeral WebKit session without stored cookies or data. It passes
  only the response address (`…/nativeclient?code=…`) to the client, through a file in
  `$XDG_RUNTIME_DIR/cloud-sync-indicator-auth/` that is deleted afterwards.
- No telemetry. The extension itself does not access the network; only the sign-in window
  loads the Microsoft sign-in page.

## Why a dedicated sign-in window?

After signing in, the client expects the address of the blank page
`https://login.microsoftonline.com/common/oauth2/nativeclient?code=…`. In a regular browser,
Microsoft now redirects away from that page immediately, so the address can only be copied
from the browser history. The sign-in window intercepts the redirect before it happens.

## Optional: icon for the sign-in window

GNOME assigns window icons through a desktop file. An extension must not create files outside
its own directory, so if you want the icon, copy it yourself:

```bash
cp extras/dev.steber.CloudSyncIndicator.Login.desktop ~/.local/share/applications/
cp extras/dev.steber.CloudSyncIndicator.Login.svg ~/.local/share/icons/hicolor/scalable/apps/
```

## Known quirks of the client (2.5.4)

- Even small changes to `~/.config/onedrive/config` can require a resync
  (the service then exits with status 126).
- `onedrive --reauth` discards the existing sign-in right away, not only on success.
  Cancelling the sign-in leaves you signed out.

## Translations

The source language is English; translations live in `po/`. To update the template and
merge it into a translation:

```bash
xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=N_ \
  --add-comments=Translators --package-name=cloud-sync-indicator \
  --msgid-bugs-address=https://github.com/rsteber/cloud-sync-indicator/issues \
  -o po/cloud-sync-indicator.pot extension.js prefs.js auth-window.js
msgmerge --update po/de.po po/cloud-sync-indicator.pot
```

To run the extension directly from the source directory, compile the translations:

```bash
msgfmt -o locale/de/LC_MESSAGES/cloud-sync-indicator.mo po/de.po
```

## Building the package

```bash
gnome-extensions pack --force --podir=po \
  --extra-source=auth-window.js \
  --schema=schemas/org.gnome.shell.extensions.cloud-sync-indicator.gschema.xml
```

## Versions and releases

extensions.gnome.org numbers every upload itself (1, 2, 3, …). The repository follows that
numbering: `version-name` in `metadata.json` and the git tag `vN` carry the same number as
the upload. For a release:

1. Set `"version-name"` in `metadata.json` to the next number and commit.
2. Build the package (see above) and upload it.
3. Tag the commit and push the tag:

   ```bash
   git tag -a vN -m "extensions.gnome.org version N"
   git push origin vN
   ```

## License

GPL-2.0-or-later, see [LICENSE](LICENSE).
