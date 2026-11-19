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
- **Several accounts:** add and remove accounts from the menu; client instances set up by
  hand as systemd user units are found automatically (see [Several accounts](#several-accounts)).
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
  `$XDG_RUNTIME_DIR/cloud-sync-indicator-auth-<account>/` that is deleted afterwards.
  After a successful sign-in it also reports the address typed into the Microsoft sign-in
  form; the extension stores it in its settings (`login-names`) and shows it as the
  account's name in the menu. The password is never read.
- No telemetry. The extension itself does not access the network; only the sign-in window
  loads the Microsoft sign-in page.

## Several accounts

The client handles one account per instance: each needs its own configuration directory
(`--confdir`), its own `sync_dir`, and its own systemd user process.

**From the menu:** “Add Account” asks for a name and a folder and opens the sign-in window.
The extension then runs the client as a transient systemd unit
(`systemd-run --user --unit=onedrive-<name>.service … onedrive --monitor --disable-notifications
--confdir ~/.config/onedrive-<name> --syncdir <folder>`) and writes no files itself; the client
creates its configuration directory. A transient unit ends with the session, so the extension
starts it again at the next login. Such an account is therefore synchronized while you are
logged in and the extension is enabled. Paused accounts stay paused. “Remove Account” stops
the account and, if chosen, deletes its configuration directory (sign-in and sync database);
the synchronized files are always kept.

**By hand:** the extension also finds every user unit named `onedrive*.service` whose
`ExecStart` runs `onedrive --monitor`, and takes the configuration directory from
`--confdir`. Units added later are found after `systemctl --user daemon-reload`. Such accounts
run independently of the extension; it does not remove them.

Example, following the client's documentation:

```bash
mkdir -p ~/.config/onedrive-work
echo 'sync_dir = "~/OneDrive-Work"' > ~/.config/onedrive-work/config
```

`~/.config/systemd/user/onedrive-work.service`:

```ini
[Unit]
Description=OneDrive Client for Linux (work)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/onedrive --monitor --disable-notifications --confdir="/home/USER/.config/onedrive-work"
Restart=on-failure
RestartSec=3
RestartPreventExitStatus=126
TimeoutStopSec=90

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable onedrive-work.service
```

Then sign in using the account's entry in the menu. `--disable-notifications` leaves
notifications to the extension; setting `disable_notifications` in the configuration file
instead makes client 2.5.4 require a resync.

With more than one account, each account has its own submenu, the top bar shows the account
that most needs attention, and recent messages are listed together, each with the account's
name. The name is the address used to sign in, or one you set in the preferences. The
client's own `onedrive.service` is left out when it is unused and other accounts exist.

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
- **Personal accounts cannot sign in with clients before 2.5.10.** Microsoft returns long
  authorization codes for personal accounts that contain characters such as `*`, `!` or `$`.
  Older clients cut the code off at these characters, and Microsoft rejects the rest with
  AADSTS70000 ([abraunegg/onedrive#3625](https://github.com/abraunegg/onedrive/pull/3625)).
  With such a client the sign-in window reports this instead of passing on the code. Debian 13
  ships 2.5.4; newer versions are available from the client's
  [own package repository](https://github.com/abraunegg/onedrive/blob/master/docs/install.md).

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
