// SPDX-License-Identifier: GPL-2.0-or-later
//
// Cloud Sync Indicator – status indicator for the “OneDrive Client for Linux” (abraunegg)
// running as a systemd user service. Not an official Microsoft product.
//
// Design:
//  - The service state comes from systemd via D-Bus (PropertiesChanged signals).
//  - A single `journalctl -f` provides additional information (last sync, transfers,
//    sign-in errors). If the client changes its log messages, only these extras are lost;
//    the basic status keeps working.
//  - Sign-in and resync run in separate processes; the shell only waits asynchronously.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as CheckBox from 'resource:///org/gnome/shell/ui/checkBox.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Marks strings for xgettext that are translated later, at runtime: while the module is
// being loaded, the extension's translation domain is not bound yet.
const N_ = s => s;

const DEFAULT_UNIT = 'onedrive.service';
const SYSTEMD = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const MANAGER_IFACE = 'org.freedesktop.systemd1.Manager';
const DEFAULT_CONF_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'onedrive']);
const RUNNING = ['active', 'activating', 'reloading'];

// Client log messages (v2.5.x).
const RE_SYNC_START = /Starting a sync with Microsoft OneDrive/;
const RE_SYNC_DONE = /Sync with Microsoft OneDrive is complete/;
// File operations, shown under "Recent Messages" when "file-operations-only" is set.
// Progress lines ("Uploading: … 42%") and notices ("Trying to delete …") are left out.
const RE_FILE_OP = new RegExp([
    '^Uploading (new|modified) file: ',
    '^Downloading file: ',
    '^Deleting (local (file|directory)|item from Microsoft OneDrive): ',
    '^Moving .+ to ',
    '^Successfully created the remote directory ',
].join('|'));
const RE_AUTH = /AADSTS\d+|invalid_grant|authori[sz]e this application|re-?authenticat|refresh[_ ]token.*(invalid|expired|missing)/i;
const RE_OFFLINE = /Cannot connect to Microsoft OneDrive|Unable to (reach|access) Microsoft OneDrive|network connection.*(not |un)available|Internet connectivity.*(lost|unavailable)/i;
const RE_ONLINE = /Successfully reached Microsoft OneDrive/;
// Messages of every sync cycle that would only clutter the full message list.
const RE_ROUTINE = /Microsoft OneDrive Login Service|^Starting a sync|^Syncing changes from|is complete$/;

const STATES = {
    ok: {icon: 'weather-overcast-symbolic', text: N_('Up to date')},
    syncing: {icon: 'view-refresh-symbolic', text: N_('Syncing …')},
    resyncing: {icon: 'view-refresh-symbolic', text: N_('Resync running …'), style: 'cloud-sync-warning'},
    starting: {icon: 'content-loading-symbolic', text: N_('Starting …')},
    stopping: {icon: 'content-loading-symbolic', text: N_('Stopping …')},
    paused: {icon: 'media-playback-pause-symbolic', text: N_('Paused')},
    offline: {icon: 'network-offline-symbolic', text: N_('No connection to OneDrive'), style: 'cloud-sync-warning'},
    auth: {icon: 'dialog-password-symbolic', text: N_('Sign-in required'), style: 'cloud-sync-error', notify: true},
    resync: {icon: 'dialog-warning-symbolic', text: N_('Resync required'), style: 'cloud-sync-error', notify: true},
    error: {icon: 'dialog-error-symbolic', text: N_('Error'), style: 'cloud-sync-error', notify: true},
    unknown: {icon: 'weather-overcast-symbolic', text: N_('Status unknown'), style: 'cloud-sync-warning'},
};

// Terminals for “Full Log in Terminal”, each with the argument that precedes the command.
const TERMINALS = [
    ['xdg-terminal-exec'],
    ['ptyxis', '--new-window', '--'],
    ['gnome-terminal', '--'],
    ['konsole', '-e'],
    ['xterm', '-e'],
];

// Exit status of auth-window.js
const LOGIN_OK = 0;
const LOGIN_CLOSED = 10;
const LOGIN_REJECTED = 11;

function promisifyAsyncMethods() {
    // GJS ignores a second _promisify of the same function. GNOME Shell already promisifies
    // some functions itself (ui/environment.js), including DataInputStream.read_line_async
    // with read_line_finish – so it returns bytes, not text.
    Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
    Gio._promisify(Gio.File.prototype, 'load_contents_async');
    Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
    Gio._promisify(Gio.File.prototype, 'delete_async');
    Gio._promisify(Gio.File.prototype, 'make_directory_async');
    Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
    Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
}

function dbusCall(path, iface, method, params, replyType = null) {
    return Gio.DBus.session.call(SYSTEMD, path, iface, method, params,
        replyType ? new GLib.VariantType(replyType) : null,
        Gio.DBusCallFlags.NONE, -1, null);
}

// Unpack only the properties needed: systemd returns many uint64 values (e.g. 2^64-1 for
// “unlimited”), and unpacking each of them makes GJS log a warning.
async function getProps(path, iface, keys) {
    const reply = await dbusCall(path, 'org.freedesktop.DBus.Properties', 'GetAll',
        new GLib.Variant('(s)', [iface]), '(a{sv})');
    const dict = reply.get_child_value(0);
    const out = {};
    for (const key of keys)
        out[key] = dict.lookup_value(key, null)?.deepUnpack();
    return out;
}

function unitJob(method, unit) {
    return dbusCall(MANAGER_PATH, MANAGER_IFACE, method,
        new GLib.Variant('(ss)', [unit, 'replace']), '(o)');
}

async function exists(path) {
    try {
        await Gio.File.new_for_path(path).query_info_async('standard::type',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        return true;
    } catch {
        return false;
    }
}

async function readText(path) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

// Writes via a temporary file and a rename – readers never see a partial file.
function writeText(path, text) {
    return Gio.File.new_for_path(path).replace_contents_bytes_async(
        new GLib.Bytes(new TextEncoder().encode(text)), null, false,
        Gio.FileCreateFlags.PRIVATE, null);
}

// Deletes a directory with everything in it; symbolic links are deleted, not followed.
async function deleteTree(dir) {
    let enumerator;
    try {
        enumerator = await dir.enumerate_children_async('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return;
        throw e;
    }
    for (;;) {
        const infos = await enumerator.next_files_async(50, GLib.PRIORITY_DEFAULT, null);
        if (infos.length === 0)
            break;
        for (const info of infos) {
            const child = dir.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                await deleteTree(child);
            else
                await child.delete_async(GLib.PRIORITY_DEFAULT, null);
        }
    }
    await dir.delete_async(GLib.PRIORITY_DEFAULT, null);
}

function expandHome(path) {
    return path === '~' || path.startsWith('~/') ? GLib.get_home_dir() + path.slice(1) : path;
}

// True if one path is the other or lies inside it.
function overlaps(a, b) {
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// Version of the onedrive client as [major, minor, patch], or null if unknown. Not cached:
// the client may be updated while the shell is running.
async function getClientVersion() {
    try {
        const proc = Gio.Subprocess.new(['onedrive', '--version'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        const [out] = await proc.communicate_utf8_async(null, null);
        const m = out?.match(/v(\d+)\.(\d+)\.(\d+)/);
        return m ? m.slice(1, 4).map(Number) : null;
    } catch {
        return null; // not installed
    }
}

async function clientOlderThan(version) {
    const current = await getClientVersion();
    if (!current)
        return false;
    for (let i = 0; i < 3; i++) {
        if (current[i] !== version[i])
            return current[i] < version[i];
    }
    return false;
}

function formatTime(dt) {
    if (!dt)
        return '';
    const local = dt.to_local();
    const today = GLib.DateTime.new_now_local().format('%F') === local.format('%F');
    // Translators: strftime formats for times today and on other days
    return local.format(today ? _('%H:%M') : _('%b %d, %H:%M'));
}

// Replaces each %s in turn, so translations can still reorder the surrounding text.
function fmt(template, ...args) {
    return template.replace(/%s/g, () => String(args.shift() ?? ''));
}

function lastLines(text, n = 3) {
    return (text ?? '').trim().split('\n').slice(-n).join(' ');
}

function sleep(ms, cancellable) {
    return new Promise((resolve, reject) => {
        let cancelId = 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (cancelId)
                cancellable.disconnect(cancelId);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        if (cancellable) {
            cancelId = cancellable.connect(() => {
                GLib.source_remove(id);
                reject(new Error('cancelled'));
            });
        }
    });
}

function launchUri(uri) {
    Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
}

// ---------------------------------------------------------------------------
// Confirmation dialog

const ConfirmDialog = GObject.registerClass(
class ConfirmDialog extends ModalDialog.ModalDialog {
    _init({title, description, okLabel = _('Continue'), checkLabel = null, checked = false}, onContinue) {
        super._init({styleClass: 'cloud-sync-dialog'});
        this.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));
        let check = null;
        if (checkLabel) {
            check = new CheckBox.CheckBox(checkLabel);
            check.checked = checked;
            this.contentLayout.add_child(check);
        }
        this.setButtons([
            {label: _('Cancel'), action: () => this.close(), key: Clutter.KEY_Escape},
            {
                label: okLabel,
                default: true,
                action: () => {
                    this.close();
                    onContinue(check?.checked ?? false);
                },
            },
        ]);
    }
});

// ---------------------------------------------------------------------------
// Dialog for a new account: name and folder. onAdd(name, folder) throws to report a problem;
// the dialog then stays open.

const AddAccountDialog = GObject.registerClass(
class AddAccountDialog extends ModalDialog.ModalDialog {
    _init(onAdd) {
        super._init({styleClass: 'cloud-sync-dialog'});
        this._onAdd = onAdd;
        this.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: _('Add OneDrive Account'),
            description: _('The account gets a folder of its own. It is synchronized while you ' +
                'are logged in and the extension is enabled. After “Add”, the sign-in window opens.'),
        }));

        this._nameEntry = this._addField(_('Name'), _('e.g. Private'));
        this._dirEntry = this._addField(_('Folder'), '~/OneDrive-…');
        this._error = new St.Label({style_class: 'cloud-sync-dialog-error', text: ''});
        this._error.clutter_text.line_wrap = true;
        this.contentLayout.add_child(this._error);

        // The folder follows the name until it is edited.
        let settingDir = false;
        let dirEdited = false;
        this._dirEntry.clutter_text.connect('text-changed', () => {
            if (!settingDir)
                dirEdited = true;
        });
        this._nameEntry.clutter_text.connect('text-changed', () => {
            if (dirEdited)
                return;
            // No slashes or spaces in the folder name.
            const name = this._nameEntry.text.trim().split('/').join(' ').replace(/\s+/g, '-');
            settingDir = true;
            this._dirEntry.text = name ? `~/OneDrive-${name}` : '';
            settingDir = false;
        });
        this._nameEntry.clutter_text.connect('activate', () => this._dirEntry.grab_key_focus());
        this._dirEntry.clutter_text.connect('activate', () => this._add());

        this.setButtons([
            {label: _('Cancel'), action: () => this.close(), key: Clutter.KEY_Escape},
            {label: _('Add'), default: true, action: () => this._add()},
        ]);
        this.setInitialKeyFocus(this._nameEntry);
    }

    _addField(label, hint) {
        this.contentLayout.add_child(new St.Label({text: label, style_class: 'cloud-sync-dialog-label'}));
        const entry = new St.Entry({hint_text: hint, can_focus: true, x_expand: true});
        this.contentLayout.add_child(entry);
        return entry;
    }

    async _add() {
        if (this._busy)
            return;
        this._busy = true;
        this._error.text = '';
        try {
            await this._onAdd(this._nameEntry.text.trim(), this._dirEntry.text.trim());
            this.close();
        } catch (e) {
            this._error.text = e.message;
        } finally {
            this._busy = false;
        }
    }
});

// ---------------------------------------------------------------------------
// Sign-in: onedrive [--reauth] --auth-files URL_FILE:RESPONSE_FILE
//
// The client writes the sign-in address to the first file and waits until the second one
// contains the response address (…/nativeclient?code=…). The dedicated sign-in window
// (auth-window.js) provides it, because in a browser Microsoft redirects away from that page
// immediately. Only the confirmation is modal, so the sign-in window and browser stay usable.

class AuthFlow {
    constructor(account) {
        this._account = account;
        this._cancellable = new Gio.Cancellable();
        this._client = null;
        this._clientDone = null;
        this._clientExited = false;
        this._loginWin = null;
        this._authUrl = null;
        this._loginName = null;
        this._notification = null;
        this._wasRunning = false;
        this._ended = false;
        this.waitingForClipboard = false;

        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(),
            `cloud-sync-indicator-auth-${account.id}`]);
        this._dir = Gio.File.new_for_path(dir);
        this._urlFile = GLib.build_filenamev([dir, 'auth-url']);
        this._respFile = GLib.build_filenamev([dir, 'response-url']);
    }

    async run() {
        try {
            const onedrive = GLib.find_program_in_path('onedrive');
            if (!onedrive)
                throw new Error(_('The “onedrive” client is not installed.'));
            await this._prepareDir();

            this._wasRunning = await this._account.isServiceRunning();
            if (this._wasRunning) {
                this._account.setAuthHint(_('Stopping OneDrive …'));
                await this._account.stopServiceAndWait(this._cancellable);
            }

            // --reauth discards the existing sign-in right away, not only on success.
            const argv = [onedrive, ...this._account.clientArgs];
            if (await exists(this._account.tokenFile))
                argv.push('--reauth');
            argv.push('--auth-files', `${this._urlFile}:${this._respFile}`);
            this._account.setAuthHint(_('Requesting sign-in address …'));
            this._client = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_MERGE);
            this._clientDone = this._client.communicate_utf8_async(null, this._cancellable)
                // The promise resolves to [stdout, stderr] (without the boolean result).
                .then(([out]) => out ?? '')
                .finally(() => (this._clientExited = true));
            this._clientDone.catch(() => {});

            for (let waited = 0; !await exists(this._urlFile); waited += 300) {
                if (this._clientExited)
                    throw new Error(fmt(_('The client exited early: %s'), lastLines(await this._clientDone)));
                if (waited > 30000)
                    throw new Error(_('The client did not provide a sign-in address.'));
                await sleep(300, this._cancellable);
            }
            await sleep(200, this._cancellable); // let the client finish writing the file
            this._authUrl = (await readText(this._urlFile))?.trim();
            if (!this._authUrl?.startsWith('https://'))
                throw new Error(_('Unexpected content in the sign-in address file.'));

            await this._runLoginWindow();
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                await this._fail(e.message);
        }
    }

    async _prepareDir() {
        try {
            await this._dir.make_directory_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
        await this._removeFiles();
    }

    // auth-window.js is not imported: WebKitGTK cannot be loaded into the shell process,
    // so it runs as a separate GJS process.
    async _runLoginWindow() {
        const script = GLib.build_filenamev([this._account.extensionPath, 'auth-window.js']);
        let win;
        try {
            // stdout: only the "login-name:" line; stderr: error messages.
            const argv = ['gjs', '-m', script, this._authUrl, this._respFile];
            if (await clientOlderThan([2, 5, 10]))
                argv.push('--strict-code');
            win = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._useBrowser(fmt(_('The sign-in window could not be started (%s).'), e.message));
            return;
        }
        this._loginWin = win;
        this._account.setAuthHint(_('Sign in using the sign-in window'));
        const [stdout, output] = await win.communicate_utf8_async(null, this._cancellable);
        if (this._loginWin !== win)
            return; // cancelled
        this._loginWin = null;

        // Do not check success via the response file: the client reads and deletes it at once.
        // get_exit_status() is only valid after a normal exit, not after a signal.
        switch (win.get_if_exited() ? win.get_exit_status() : -1) {
        case LOGIN_OK:
            this._loginName = stdout?.match(/^login-name: ([^\s@]+@[^\s@]+)$/m)?.[1] ?? null;
            await this._finish();
            break;
        case LOGIN_REJECTED:
            await this._fail(output?.trim() || _('Microsoft rejected the sign-in.'));
            break;
        case LOGIN_CLOSED:
            this._useBrowser(_('Sign-in window closed.'));
            break;
        default:
            log(`cloud-sync-indicator: sign-in window: ${lastLines(output)}`);
            this._useBrowser(_('The sign-in window could not be started (is WebKitGTK 6.0 for GJS installed?).'));
        }
    }

    // Fallback: regular browser; the response address comes from the clipboard on click.
    _useBrowser(reason) {
        try {
            launchUri(this._authUrl);
        } catch (e) {
            logError(e, 'cloud-sync-indicator: browser');
        }
        this._askForClipboard(reason);
    }

    _askForClipboard(reason) {
        this.waitingForClipboard = true;
        this._account.setAuthHint(_('Copy the response address from the browser'));
        this._showNotification(fmt(_('%s Sign in using the browser'), reason),
            _('After signing in, copy the address of the blank page (…/nativeclient?code=…) – ' +
              'if the page redirects, it is in the browser history – then choose ' +
              '“Sign in from clipboard” (also in the indicator menu).'),
            [
                [_('Sign in from clipboard'), () => this.fromClipboard()],
                [_('Cancel'), () => this.cancel()],
            ]);
    }

    // Clipboard access (declared in metadata.json): read once, only when the user picks
    // "Sign in from clipboard"; the text is only passed to the local client.
    fromClipboard() {
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            const response = (text ?? '').trim();
            if (!/^https:\/\/login\.microsoftonline\.com\/\S*[?&]code=/.test(response)) {
                this._askForClipboard(_('The clipboard does not contain a response address with “code=”.'));
                return;
            }
            this.waitingForClipboard = false;
            writeText(this._respFile, `${response}\n`)
                .then(() => this._finish())
                .catch(e => this._fail(e.message));
        });
    }

    async _finish() {
        this._clearNotification();
        this._account.setAuthHint(_('Completing sign-in …'));
        const started = Date.now() - 10000;
        const timeout = new Gio.Cancellable();
        try {
            const output = await Promise.race([
                this._clientDone,
                sleep(60000, timeout).then(() => {
                    throw new Error(_('Timed out while completing sign-in.'));
                }),
            ]);
            if (!await this._tokenWrittenSince(started))
                throw new Error(lastLines(output) || _('No sign-in token was saved.'));
            this._account.authSucceeded(this._loginName);
            Main.notify(this._account.title, _('Signed in. Restarting OneDrive.'));
            await this._end(true);
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                await this._fail(e.message);
        } finally {
            timeout.cancel();
        }
    }

    async _tokenWrittenSince(ms) {
        try {
            const info = await Gio.File.new_for_path(this._account.tokenFile).query_info_async(
                'time::modified', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
            return info.get_modification_date_time().to_unix() * 1000 >= ms;
        } catch {
            return false;
        }
    }

    async _fail(message) {
        // Also in the journal: the notification disappears once it has been clicked.
        console.warn(`cloud-sync-indicator: sign-in failed (${this._account.unit}): ${message}`);
        this._clearNotification();
        Main.notify(_('OneDrive: sign-in failed'), message);
        await this._end(false);
    }

    cancel() {
        if (this._ended)
            return;
        this._cancellable.cancel();
        Main.notify(this._account.title, _('Sign-in cancelled.'));
        this._end(false).catch(logError);
    }

    // When the extension is disabled: only clean up, leave the service alone.
    abort() {
        this._ended = true;
        this._cancellable.cancel();
        this._killProcs();
        this._clearNotification();
        this._removeFiles().catch(() => {});
    }

    async _end(startService) {
        if (this._ended)
            return;
        this._ended = true;
        this.waitingForClipboard = false;
        this._killProcs();
        this._clearNotification();
        await this._removeFiles();
        this._account.authEnded(this);
        if (startService || this._wasRunning)
            await this._account.startService();
    }

    _killProcs() {
        // force_exit() has no effect after the process has exited, so it is always safe.
        this._loginWin?.force_exit();
        this._loginWin = null;
        this._client?.force_exit();
    }

    _showNotification(title, body, actions) {
        this._clearNotification();
        const source = MessageTray.getSystemSource();
        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            urgency: MessageTray.Urgency.CRITICAL, // stays until resolved
            resident: true,
        });
        for (const [label, callback] of actions)
            notification.addAction(label, callback);
        notification.connect('destroy', () => {
            if (this._notification === notification)
                this._notification = null;
        });
        this._notification = notification;
        source.addNotification(notification);
    }

    _clearNotification() {
        const notification = this._notification;
        this._notification = null;
        notification?.destroy();
    }

    async _removeFiles() {
        for (const path of [this._urlFile, this._respFile]) {
            try {
                await Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null);
            } catch {
                // does not exist
            }
        }
    }
}

// ---------------------------------------------------------------------------
// One-shot named timers; scheduling the same name again replaces the old one.

class Timers {
    constructor() {
        this._sources = new Map(); // name → GLib source
    }

    schedule(name, ms, callback) {
        this.unschedule(name);
        this._sources.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sources.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    unschedule(name) {
        const id = this._sources.get(name);
        if (id) {
            GLib.source_remove(id);
            this._sources.delete(name);
        }
    }

    clear() {
        for (const id of this._sources.values())
            GLib.source_remove(id);
        this._sources.clear();
    }
}

// True if a unit of this name exists (unit file, or a loaded – e.g. transient – unit).
async function unitExists(unit) {
    const [path] = (await dbusCall(MANAGER_PATH, MANAGER_IFACE, 'LoadUnit',
        new GLib.Variant('(s)', [unit]), '(o)')).deepUnpack();
    const {LoadState} = await getProps(path, 'org.freedesktop.systemd1.Unit', ['LoadState']);
    return LoadState !== 'not-found';
}

// Object path of a unit, derived from its name. Unlike LoadUnit, this does not create a
// placeholder unit (which would trigger UnitNew/UnitRemoved).
function unitObjectPath(unit) {
    return `${MANAGER_PATH}/unit/${unit.replace(/[^A-Za-z0-9]/g,
        c => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
}

// ---------------------------------------------------------------------------
// Account: one instance of the client – a systemd user unit with its own configuration
// directory. Keeps the state of that instance; the indicator only displays it.

class Account {
    constructor(indicator, {unit, confDir, clientArgs, managed = false, syncDir = null}) {
        this._indicator = indicator;
        this.unit = unit;
        this.id = unit.replace(/\.service$/, '');
        this.resyncUnit = `cloud-sync-indicator-resync-${this.id}.service`;
        this.confDir = confDir;
        this.tokenFile = GLib.build_filenamev([confDir, 'refresh_token']);
        this.configFile = GLib.build_filenamev([confDir, 'config']);
        // Arguments that select this account's configuration, e.g. ['--confdir', …].
        this.clientArgs = clientArgs;
        // Created by the extension: runs as a transient unit, which the extension starts.
        this.managed = managed;
        this._syncDir = syncDir;
        this.extensionPath = indicator.extensionPath;

        this.props = {};
        this.hasToken = true;
        this.resyncRunning = false;
        this.auth = null;
        this.authHint = null;
        this.stateKey = null;
        this.resetJournalState();

        this._unitPath = null;
        this._signalIds = [];
        this._confMonitor = null;
        this._confMonitorId = 0;
        this._cancellable = new Gio.Cancellable();
        this._timers = new Timers();
    }

    get title() {
        return this._indicator.titleFor(this);
    }

    get name() {
        return this._indicator.nameFor(this);
    }

    start() {
        this._watchConfDir();
        this._initDBus().catch(e => this._dbusFailed(e));
    }

    _changed() {
        if (!this._cancellable.is_cancelled())
            this._indicator.accountChanged(this);
    }

    async syncDir() {
        if (this._syncDir)
            return this._syncDir;
        const conf = await readText(this.configFile) ?? '';
        const m = conf.match(/^\s*sync_dir\s*=\s*"([^"]*)"/m);
        const dir = m ? m[1] : '~/OneDrive';
        return dir.startsWith('~') ? GLib.get_home_dir() + dir.slice(1) : dir;
    }

    openFolder() {
        this.syncDir().then(dir => this._launch(Gio.File.new_for_path(dir).get_uri()));
    }

    editConfig() {
        this._launch(Gio.File.new_for_path(this.configFile).get_uri());
    }

    _launch(uri) {
        try {
            launchUri(uri);
        } catch (e) {
            this._notifyError(e);
        }
    }

    _notifyError(e) {
        Main.notify(this.title, e.message ?? String(e));
    }

    // --- systemd -----------------------------------------------------------

    async _initDBus() {
        // The indicator has already called Subscribe (see SyncIndicator._initDBus()).
        const [path] = (await dbusCall(MANAGER_PATH, MANAGER_IFACE, 'LoadUnit',
            new GLib.Variant('(s)', [this.unit]), '(o)')).deepUnpack();
        if (this._cancellable.is_cancelled())
            return;
        this._unitPath = path;

        const refresh = () => this._timers.schedule('refresh', 150, () =>
            this._refresh().catch(e => this._dbusFailed(e)));
        const bus = Gio.DBus.session;
        this._signalIds = [
            bus.signal_subscribe(SYSTEMD, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                path, null, Gio.DBusSignalFlags.NONE, refresh),
            bus.signal_subscribe(SYSTEMD, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                unitObjectPath(this.resyncUnit), null, Gio.DBusSignalFlags.NONE, refresh),
            bus.signal_subscribe(SYSTEMD, MANAGER_IFACE, 'UnitNew', MANAGER_PATH,
                this.resyncUnit, Gio.DBusSignalFlags.NONE, refresh),
            bus.signal_subscribe(SYSTEMD, MANAGER_IFACE, 'UnitRemoved', MANAGER_PATH,
                this.resyncUnit, Gio.DBusSignalFlags.NONE, refresh),
        ];
        await this._refresh();
        await this._autostart();
    }

    // A transient unit ends with the session: start it again when the extension is enabled –
    // unless the account is paused or not signed in yet. After the screen was unlocked the
    // unit still exists, so nothing happens.
    async _autostart() {
        if (!this.managed || this.props.load !== 'not-found' || this._indicator.isPaused(this))
            return;
        if (await exists(this.tokenFile) && !this._cancellable.is_cancelled())
            await this.startService();
    }

    _dbusFailed(e) {
        if (this._cancellable.is_cancelled())
            return;
        logError(e, `cloud-sync-indicator: systemd not reachable (${this.unit})`);
        this.props = {};
        this._changed();
        // Setup did not finish: try again later instead of staying in "unknown".
        if (!this._unitPath) {
            this._timers.schedule('dbus-retry', 30000, () =>
                this._initDBus().catch(err => this._dbusFailed(err)));
        }
    }

    async _refresh() {
        if (!this._unitPath)
            return;
        const unit = await getProps(this._unitPath, 'org.freedesktop.systemd1.Unit',
            ['ActiveState', 'SubState', 'LoadState']);
        const svc = await getProps(this._unitPath, 'org.freedesktop.systemd1.Service',
            ['Result', 'ExecMainStatus', 'NRestarts']);
        // ListUnitsByPatterns returns loaded units only and does not load any itself.
        const [units] = (await dbusCall(MANAGER_PATH, MANAGER_IFACE, 'ListUnitsByPatterns',
            new GLib.Variant('(asas)', [[], [this.resyncUnit]]), '(a(ssssssouso))')).deepUnpack();
        if (this._cancellable.is_cancelled())
            return;

        this.props = {
            active: unit.ActiveState,
            sub: unit.SubState,
            load: unit.LoadState,
            result: svc.Result,
            status: svc.ExecMainStatus,
            restarts: svc.NRestarts,
        };
        const resyncActive = units.some(u => ['active', 'activating', 'deactivating'].includes(u[3]));
        if (this.resyncRunning && !resyncActive)
            this._resyncEnded();
        this.resyncRunning = resyncActive;
        this._changed();
    }

    get running() {
        return RUNNING.includes(this.props.active);
    }

    async isServiceRunning() {
        await this._refresh();
        return this.running;
    }

    async stopServiceAndWait(cancellable) {
        await unitJob('StopUnit', this.unit);
        // The client finishes running transfers first (TimeoutStopSec=90 in the unit).
        for (let i = 0; i < 240; i++) {
            await this._refresh();
            if (['inactive', 'failed'].includes(this.props.active))
                return;
            await sleep(500, cancellable);
        }
        throw new Error(_('OneDrive could not be stopped.'));
    }

    async startService() {
        try {
            if (!this.managed) {
                await unitJob('StartUnit', this.unit);
                return;
            }
            this._indicator.setPaused(this, false);
            await this._refresh();
            // After it was stopped, a transient unit no longer exists; a failed one still does.
            if (this.props.load === 'loaded')
                await unitJob('StartUnit', this.unit);
            else
                await this._runTransient();
        } catch (e) {
            this._notifyError(e);
        }
    }

    async _runTransient() {
        const onedrive = GLib.find_program_in_path('onedrive');
        if (!onedrive)
            throw new Error(_('The “onedrive” client is not installed.'));
        // The same settings as the client's own onedrive.service.
        const proc = Gio.Subprocess.new([
            'systemd-run', '--user', `--unit=${this.unit}`,
            `--description=OneDrive Client for Linux (${this.name})`,
            '-p', 'After=network-online.target', '-p', 'Wants=network-online.target',
            '-p', 'Restart=on-failure', '-p', 'RestartSec=3', '-p', 'RestartPreventExitStatus=126',
            '-p', 'TimeoutStopSec=90', '-p', 'ProtectSystem=full',
            onedrive, '--monitor', '--disable-notifications', ...this.clientArgs,
        ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        const [out] = await proc.communicate_utf8_async(null, this._cancellable);
        if (!proc.get_successful())
            throw new Error(lastLines(out) || _('systemd-run failed.'));
    }

    toggleService() {
        if (!this.running) {
            this.startService();
            return;
        }
        // Remembered, so that a paused account is not started again at the next login.
        if (this.managed)
            this._indicator.setPaused(this, true);
        unitJob('StopUnit', this.unit).catch(e => this._notifyError(e));
    }

    restartService() {
        unitJob('RestartUnit', this.unit).catch(e => this._notifyError(e));
    }

    // --- Journal -----------------------------------------------------------

    // Before the journal is read (again) from the start.
    resetJournalState() {
        this.syncing = false;
        this.offline = false;
        this.authError = false;
        this.lastSync = null;
        this.lastActivity = null;
        this.log = [];       // all messages except routine lines
        this.fileLog = [];   // file operations only
    }

    handleMessage(time, msg) {
        if (msg.startsWith(`Started ${this.unit}`)) {
            this.syncing = false;
            this.offline = false;
        } else if (RE_SYNC_START.test(msg)) {
            this.syncing = true;
        } else if (RE_SYNC_DONE.test(msg)) {
            this.syncing = false;
            this.authError = false;
            this.lastSync = time;
        }
        if (RE_AUTH.test(msg))
            this.authError = true;
        if (RE_OFFLINE.test(msg))
            this.offline = true;
        else if (RE_ONLINE.test(msg))
            this.offline = false;

        // Both lists are kept, so that switching the setting takes effect immediately.
        const entry = {time, msg, account: this};
        if (RE_FILE_OP.test(msg)) {
            this.lastActivity = entry;
            this._pushLog(this.fileLog, entry);
        }
        if (!RE_ROUTINE.test(msg))
            this._pushLog(this.log, entry);
    }

    _pushLog(list, entry) {
        list.push(entry);
        if (list.length > this._indicator.logMax)
            list.shift();
    }

    // --- Config directory --------------------------------------------------

    // Watches the config directory: the sign-in token (refresh_token) and the configuration.
    _watchConfDir() {
        this._checkToken();
        try {
            this._confMonitor = Gio.File.new_for_path(this.confDir).monitor_directory(
                Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._confMonitorId = this._confMonitor.connect('changed', (_monitor, file, other, event) => {
                const names = [file?.get_basename(), other?.get_basename()];
                if (names.includes('refresh_token'))
                    this._checkToken();
                if (names.includes('config') && [Gio.FileMonitorEvent.CHANGES_DONE_HINT,
                    Gio.FileMonitorEvent.RENAMED, Gio.FileMonitorEvent.MOVED_IN,
                    Gio.FileMonitorEvent.CREATED].includes(event))
                    // Editors often save in several steps – collect them briefly.
                    this._timers.schedule('config-notice', 2000, () => this._configChanged());
            });
        } catch (e) {
            logError(e, 'cloud-sync-indicator: watching config directory');
        }
    }

    async _checkToken() {
        const found = await exists(this.tokenFile);
        if (this._cancellable.is_cancelled())
            return;
        this.hasToken = found;
        this._changed();
    }

    // The client reads its configuration only at startup; version 2.5.4 requires a resync
    // after almost any change (exit 126).
    _configChanged() {
        const source = MessageTray.getSystemSource();
        const notification = new MessageTray.Notification({
            source,
            title: _('OneDrive configuration changed'),
            body: _('The change takes effect after the client restarts. ' +
                    'Version 2.5.4 then usually requires a resync.'),
        });
        notification.addAction(_('Restart Now'), () => this.restartService());
        source.addNotification(notification);
    }

    // --- State -------------------------------------------------------------

    computeState() {
        const p = this.props;
        if (!p.active)
            return ['unknown', _('systemd service not reachable')];
        // An account created by the extension has no unit while it is stopped.
        if (p.load === 'not-found' && !this.managed)
            return ['error', fmt(_('%s is not installed'), this.unit)];
        if (this.auth)
            return ['auth', this.authHint ?? _('Signing in …')];
        if (this.resyncRunning)
            return ['resyncing', _('Rebuilding the local database – this may take a while')];
        if (!this.hasToken || this.authError)
            return ['auth', _('Sign in again via “Sign In”')];

        switch (p.active) {
        case 'active':
        case 'reloading':
            if (this.offline)
                return ['offline', _('The client keeps retrying')];
            return [this.syncing ? 'syncing' : 'ok', null];
        case 'activating':
            if (p.sub === 'auto-restart' || p.restarts >= 2)
                return ['error', fmt(_('Restarting repeatedly (%s×) – see recent messages'), p.restarts)];
            return ['starting', null];
        case 'deactivating':
            return ['stopping', null];
        case 'failed':
            if (p.status === 126)
                return ['resync', _('Use “Resync” – or run in a terminal: onedrive --sync --resync')];
            // The client exits with status 15 on SIGTERM – a normal stop.
            if (p.status === 15 || p.result === 'success')
                return ['paused', null];
            return ['error', fmt(_('Exited with status %s (%s)'), p.status, p.result)];
        default:
            return ['paused', null];
        }
    }

    // Called after each update outside the journal replay: notifies when the account enters
    // a state that needs attention.
    noteState(key, hint) {
        if (key === this.stateKey)
            return;
        const previous = this.stateKey;
        this.stateKey = key;
        const state = STATES[key];
        if (state.notify && previous !== null && !this.auth) {
            const text = _(state.text);
            Main.notify(this.title, hint ? `${text} – ${hint}` : text);
        }
    }

    // At the end of the replay, an error that already exists should still be reported.
    replayEnded() {
        this.stateKey ??= 'unknown';
    }

    // --- Sign-in -----------------------------------------------------------

    authAction() {
        this._indicator.menu.close();
        if (this.auth) {
            this.auth.cancel();
            return;
        }
        new ConfirmDialog({
            title: this.hasToken ? _('Sign In to OneDrive Again') : _('Sign In to OneDrive'),
            description: [
                _('OneDrive will be stopped briefly.'),
                this.hasToken ? _('The current sign-in will be discarded.') : '',
                _('After “Continue”, a separate sign-in window with the Microsoft sign-in ' +
                  'opens. It closes by itself once you have signed in.'),
            ].filter(Boolean).join('\n\n'),
        }, () => this.beginAuth()).open();
    }

    beginAuth() {
        if (this.auth || this._cancellable.is_cancelled())
            return;
        this.auth = new AuthFlow(this);
        this.authHint = null;
        this._changed();
        this.auth.run().catch(logError);
    }

    // --- Removal (accounts created by the extension only) ------------------

    removeAction() {
        this._indicator.menu.close();
        if (!this.managed || this.auth)
            return;
        new ConfirmDialog({
            title: fmt(_('Remove the Account “%s”'), this.name),
            description: _('The account is stopped and removed from the menu. ' +
                'Its folder and the files in it are kept.'),
            okLabel: _('Remove'),
            checkLabel: _('Also delete the sign-in and the local sync database'),
            checked: true,
        }, deleteConfig => this._remove(deleteConfig).catch(e => this._notifyError(e))).open();
    }

    async _remove(deleteConfig) {
        await this._refresh();
        if (this.props.load === 'loaded') {
            if (!['inactive', 'failed'].includes(this.props.active))
                await this.stopServiceAndWait(this._cancellable);
            // A failed transient unit stays until it is reset.
            await dbusCall(MANAGER_PATH, MANAGER_IFACE, 'ResetFailedUnit',
                new GLib.Variant('(s)', [this.unit]), null).catch(() => {});
        }
        if (deleteConfig)
            await deleteTree(Gio.File.new_for_path(this.confDir));
        // Removes this account from the settings; discovery then destroys this object.
        this._indicator.forgetAccount(this);
    }

    setAuthHint(text) {
        this.authHint = text;
        this._changed();
    }

    authEnded(flow) {
        if (this.auth === flow) {
            this.auth = null;
            this.authHint = null;
        }
        this._changed();
    }

    // loginName: the address typed into the sign-in window, if known.
    authSucceeded(loginName) {
        this.authError = false;
        // For a new account the config directory did not exist yet, so its monitor may
        // report the token late.
        this._checkToken();
        if (loginName)
            this._indicator.setLoginName(this, loginName);
    }

    // --- Resync ------------------------------------------------------------

    resyncAction() {
        this._indicator.menu.close();
        new ConfirmDialog({
            title: _('Resync OneDrive'),
            description: [
                _('The client requires a resync. The local sync database is discarded and ' +
                  'rebuilt, and all files online and locally are compared again. Depending on ' +
                  'the amount of data, this may take a while.'),
                _('No files are deleted. If a file differs locally and online, the client ' +
                  'keeps both versions (the local one as a backup copy).'),
                _('The resync runs independently of the shell as a separate systemd unit; ' +
                  'afterwards OneDrive continues as usual.'),
            ].join('\n\n'),
            okLabel: _('Start Resync'),
        }, () => this._startResync()).open();
    }

    // Run as a transient systemd unit, so the resync survives a restart of the shell.
    async _startResync() {
        try {
            const onedrive = GLib.find_program_in_path('onedrive');
            if (!onedrive)
                throw new Error(_('The “onedrive” client is not installed.'));
            if (await this.isServiceRunning())
                throw new Error(_('OneDrive is running – resync only when the client asks for it.'));
            const proc = Gio.Subprocess.new([
                'systemd-run', '--user', `--unit=${this.resyncUnit}`, '--collect',
                '--description=OneDrive resync (Cloud Sync Indicator)', '-p', 'ProtectSystem=full',
                // On success, start the service from within the unit, not from the shell.
                // Paths and unit names are passed as arguments, never as part of the script.
                '/bin/sh', '-c', 'unit=$1; shift; "$0" "$@" && exec systemctl --user start "$unit"',
                onedrive, this.unit, '--sync', '--resync', '--resync-auth', ...this.clientArgs,
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
            const [out] = await proc.communicate_utf8_async(null, this._cancellable);
            if (!proc.get_successful())
                throw new Error(lastLines(out) || _('systemd-run failed.'));
            this.resyncRunning = true;
            this._changed();
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                this._notifyError(e);
        }
    }

    // The unit's result cannot be queried (--collect removes it at once). On success it has
    // started the service – that tells us the outcome.
    _resyncEnded() {
        this._timers.schedule('resync-result', 3000, () => {
            Main.notify(this.title, this.running
                ? _('Resync finished, OneDrive is running again.')
                : _('Resync failed – see “Full Log in Terminal”.'));
        });
    }

    destroy() {
        this._cancellable.cancel();
        this.auth?.abort();
        this.auth = null;
        this._timers.clear();
        if (this._confMonitorId)
            this._confMonitor.disconnect(this._confMonitorId);
        this._confMonitor?.cancel();
        this._confMonitor = null;
        this._confMonitorId = 0;
        for (const id of this._signalIds)
            Gio.DBus.session.signal_unsubscribe(id);
        this._signalIds = [];
        this.log = [];
        this.fileLog = [];
    }
}


// ---------------------------------------------------------------------------
// Account discovery: every systemd user unit named onedrive*.service whose ExecStart runs
// `onedrive --monitor` is an account; its config directory comes from --confdir. This is
// how the client's documentation sets up several accounts, so units created by hand are
// found as well.

const UNIT_PATTERN = 'onedrive*.service';

function parseExecStart(execStart) {
    for (const [path, argv] of execStart ?? []) {
        if (GLib.path_get_basename(path) !== 'onedrive' ||
            !argv.some(arg => arg === '--monitor' || arg === '-m'))
            continue;
        let dir = null;
        for (let i = 1; i < argv.length; i++) {
            if (argv[i] === '--confdir')
                dir = argv[i + 1] ?? null;
            else if (argv[i].startsWith('--confdir='))
                dir = argv[i].slice('--confdir='.length);
        }
        if (!dir)
            return {confDir: DEFAULT_CONF_DIR, clientArgs: []};
        if (dir.startsWith('~'))
            dir = GLib.get_home_dir() + dir.slice(1);
        dir = Gio.File.new_for_path(dir).get_path(); // normalised, e.g. without a trailing /
        return {confDir: dir, clientArgs: ['--confdir', dir]};
    }
    return null;
}

// managed: the accounts created by the extension (setting "managed-accounts"); they are listed
// whether their transient unit exists right now or not.
async function findAccounts(managed) {
    const [files] = (await dbusCall(MANAGER_PATH, MANAGER_IFACE, 'ListUnitFilesByPatterns',
        new GLib.Variant('(asas)', [[], [UNIT_PATTERN]]), '(a(ss))')).deepUnpack();
    // Loaded units as well: instances of a template unit have no unit file of their own.
    const [loaded] = (await dbusCall(MANAGER_PATH, MANAGER_IFACE, 'ListUnitsByPatterns',
        new GLib.Variant('(asas)', [[], [UNIT_PATTERN]]), '(a(ssssssouso))')).deepUnpack();
    const fileStates = new Map(files.map(([path, state]) => [GLib.path_get_basename(path), state]));
    const activeStates = new Map(loaded.map(u => [u[0], u[3]]));
    const units = [...new Set([...fileStates.keys(), ...activeStates.keys()])]
        .filter(unit => !unit.includes('@.')) // a template itself is not an account
        .filter(unit => !(unit in managed))
        .sort();

    const found = Object.entries(managed).map(([unit, {'conf-dir': confDir, 'sync-dir': syncDir}]) => ({
        unit, confDir, syncDir, managed: true, used: true,
        clientArgs: ['--confdir', confDir, '--syncdir', syncDir],
    }));
    for (const unit of units) {
        const [path] = (await dbusCall(MANAGER_PATH, MANAGER_IFACE, 'LoadUnit',
            new GLib.Variant('(s)', [unit]), '(o)')).deepUnpack();
        const {ExecStart} = await getProps(path, 'org.freedesktop.systemd1.Service', ['ExecStart']);
        const spec = parseExecStart(ExecStart);
        if (!spec)
            continue;
        const used = (fileStates.get(unit) ?? '').startsWith('enabled') ||
            ['active', 'activating', 'reloading', 'failed'].includes(activeStates.get(unit)) ||
            await exists(GLib.build_filenamev([spec.confDir, 'refresh_token']));
        found.push({unit, used, ...spec});
    }

    // Units with the same config directory are one account: keep the one in use.
    const accounts = [];
    for (const spec of [...found.filter(s => s.used), ...found.filter(s => !s.used)]) {
        if (!accounts.some(a => a.confDir === spec.confDir))
            accounts.push(spec);
    }
    // The client's packaged onedrive.service is left out when it is unused and other accounts
    // exist. Without any account it is always listed: the menu then offers the first sign-in,
    // or reports that the client is not installed.
    const result = accounts
        .filter(a => a.used || a.unit !== DEFAULT_UNIT || accounts.length === 1)
        .sort((a, b) => (b.unit === DEFAULT_UNIT) - (a.unit === DEFAULT_UNIT) ||
            a.unit.localeCompare(b.unit));
    return result.length ? result : [{unit: DEFAULT_UNIT, confDir: DEFAULT_CONF_DIR, clientArgs: []}];
}

// ---------------------------------------------------------------------------
// Menu items of one account. With a single account they are placed directly in the menu,
// as before; with several, each account gets a submenu with its actions, and its details
// below it.

// A client message in short form: a symbol instead of the verb, and only the path.
// Returns {icon, symbol, text}; icon and symbol are null for other messages.
const FILE_OPS = [
    [/^Uploading (?:new|modified) file: (.+)$/, 'go-up-symbolic', '↑'],
    [/^Downloading file: (.+)$/, 'go-down-symbolic', '↓'],
    [/^Deleting (?:local (?:file|directory)|item from Microsoft OneDrive): (.+)$/, 'user-trash-symbolic', '✕'],
    [/^Successfully created the remote directory (.+?)(?: on Microsoft OneDrive)?$/, 'folder-new-symbolic', '+'],
];

function shortMove(from, to) {
    const dir = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const base = p => p.slice(p.lastIndexOf('/') + 1);
    if (dir(from) === dir(to))   // renamed
        return `${from} → ${base(to)}`;
    if (base(from) === base(to)) // moved to another folder
        return `${from} → ${dir(to) || '.'}/`;
    return `${from} → ${to}`;
}

function compactMessage(msg) {
    // "… done" ends a completed transfer; anything else (e.g. "failed") stays visible.
    const text = msg.replace(/\s*\.\.\.\s*done\.?$/, '');
    for (const [re, icon, symbol] of FILE_OPS) {
        const m = text.match(re);
        if (m)
            return {icon, symbol, text: m[1]};
    }
    const move = text.match(/^Moving (.+) to (.+)$/);
    if (move)
        return {icon: 'go-next-symbolic', symbol: '→', text: shortMove(move[1], move[2])};
    return {icon: null, symbol: null, text: msg};
}

// One entry of "Recent Messages": symbol, path (shortened in the middle), time and account.
function logItem({time, msg, account}, showAccount) {
    const {icon, text} = compactMessage(msg);
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, style_class: 'cloud-sync-log-item'});
    // Other messages get an invisible icon, so that all texts start in the same column.
    item.add_child(new St.Icon({
        icon_name: icon ?? 'go-next-symbolic',
        style_class: 'popup-menu-icon',
        opacity: icon ? 255 : 0,
    }));
    const label = new St.Label({text, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
    label.style = 'max-width: 28em;';
    item.add_child(label);
    item.label_actor = label;
    const meta = new St.Label({
        text: [formatTime(time), showAccount ? account.name : null].filter(Boolean).join(' · '),
        style_class: 'cloud-sync-log-meta',
        y_align: Clutter.ActorAlign.CENTER,
    });
    meta.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    item.add_child(meta);
    return item;
}

function detailItem() {
    const item = new PopupMenu.PopupMenuItem('', {reactive: false, style_class: 'cloud-sync-log-item'});
    item.label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
    item.label.style = 'max-width: 36em;';
    return item;
}

class AccountView {
    constructor(account, section, single) {
        this.account = account;
        this._single = single;
        let actions;
        if (single) {
            this._status = new PopupMenu.PopupImageMenuItem('', STATES.unknown.icon, {reactive: false});
            section.addMenuItem(this._status);
            this._detail = detailItem();
            section.addMenuItem(this._detail);
            section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            actions = section;
        } else {
            this._sub = new PopupMenu.PopupSubMenuMenuItem('', true);
            section.addMenuItem(this._sub);
            this._detail = detailItem();
            section.addMenuItem(this._detail);
            actions = this._sub.menu;
        }

        actions.addAction(_('Open OneDrive Folder'), () => account.openFolder(), 'folder-symbolic');
        actions.addAction(_('Edit Configuration'), () => account.editConfig(), 'document-edit-symbolic');
        actions.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._toggleItem = actions.addAction('', () => account.toggleService(),
            'media-playback-pause-symbolic');
        this._resyncItem = actions.addAction(_('Resync'), () => account.resyncAction(),
            'view-refresh-symbolic');
        this._restartItem = actions.addAction(_('Restart'), () => account.restartService(),
            'system-reboot-symbolic');
        this._clipItem = actions.addAction(_('Sign in from clipboard'),
            () => account.auth?.fromClipboard(), 'edit-paste-symbolic');
        this._authItem = actions.addAction('', () => account.authAction(), 'dialog-password-symbolic');
        this._removeItem = null;
        if (account.managed) {
            this._removeItem = actions.addAction(_('Remove Account'), () => account.removeAction(),
                'user-trash-symbolic');
        } else if (!single) {
            // Menus have no tooltips: a disabled entry with the reason in a second, smaller line.
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
            item.add_child(new St.Icon({icon_name: 'user-trash-symbolic', style_class: 'popup-menu-icon'}));
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            const label = new St.Label({text: _('Remove Account')});
            box.add_child(label);
            box.add_child(new St.Label({
                text: _('Set up outside the extension – remove it with systemctl'),
                style_class: 'cloud-sync-log-item',
            }));
            item.add_child(box);
            item.label_actor = label;
            item.setSensitive(false);
            actions.addMenuItem(item);
        }
    }

    // Returns the account's state as [key, hint].
    update() {
        const account = this.account;
        const [key, hint] = account.computeState();
        const state = STATES[key];
        const stateText = _(state.text);

        if (this._single) {
            this._status.label.text = fmt(_('OneDrive: %s'), stateText);
            this._status.setIcon(state.icon);
        } else {
            this._sub.label.text = `${account.name}: ${stateText}`;
            this._sub.icon.icon_name = state.icon;
        }
        const details = [];
        if (hint)
            details.push(hint);
        if (account.lastSync)
            details.push(fmt(_('Last sync: %s'), formatTime(account.lastSync)));
        if (account.lastActivity) {
            const {symbol, text} = compactMessage(account.lastActivity.msg);
            details.push(`${formatTime(account.lastActivity.time)}  ${symbol ? `${symbol} ` : ''}${text}`);
        }
        this._detail.label.text = details.join('\n') || ' ';
        // A detail line without content only takes up space below a submenu.
        this._detail.visible = this._single || details.length > 0;

        const known = !!account.props.active;
        this._toggleItem.label.text = account.running ? _('Pause') : _('Start');
        this._toggleItem.setIcon(account.running ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic');
        this._toggleItem.visible = known && !account.resyncRunning;
        this._restartItem.visible = known && account.props.active !== 'inactive' && !account.resyncRunning;
        this._resyncItem.visible = key === 'resync';
        this._authItem.label.text = account.auth ? _('Cancel Sign-in')
            : account.hasToken ? _('Sign In Again') : _('Sign In');
        this._authItem.setIcon(account.auth ? 'process-stop-symbolic' : 'dialog-password-symbolic');
        this._clipItem.visible = !!account.auth?.waitingForClipboard;
        if (this._removeItem)
            this._removeItem.visible = !account.auth;
        return [key, hint];
    }
}

// The panel icon shows the account that most needs attention.
const SEVERITY = ['error', 'resync', 'auth', 'offline', 'unknown', 'resyncing', 'paused',
    'starting', 'stopping', 'syncing', 'ok'];

// ---------------------------------------------------------------------------
// Panel indicator

const SyncIndicator = GObject.registerClass(
class SyncIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Cloud Sync Indicator', false);
        this.extensionPath = extension.path;
        this._settings = extension.getSettings();
        this.logMax = this._settings.settings_schema.get_key('log-entries')
            .get_range().deepUnpack()[1].deepUnpack()[1];
        this._cancellable = new Gio.Cancellable();
        this._timers = new Timers();
        this._decoder = new TextDecoder();
        this._accounts = [];
        this._views = [];
        this._discovered = false;
        this._dbusSignalIds = [];
        this._replaying = false;
        this._journal = null;
        this._journalCancellable = null;
        this._menuOpenId = 0;
        this._pendingSignIn = null;
        this._settingsIds = [
            ...['account-names', 'login-names'].map(key =>
                this._settings.connect(`changed::${key}`, () => this._update())),
            this._settings.connect('changed::managed-accounts', () => this._rediscover()),
        ];

        // Compact like AppIndicator icons in their “compact mode”.
        this.set_style('-natural-hpadding: 10px');
        this._icon = new St.Icon({
            icon_name: STATES.unknown.icon,
            style_class: 'system-status-icon',
            style: 'padding: 0; margin: 0',
        });
        this.add_child(this._icon);

        this._buildMenu();
        this._rebuildViews();
        this._update();
        this._initDBus().catch(e => this._dbusFailed(e));
    }

    // --- Accounts ----------------------------------------------------------

    _dict(key) {
        return this._settings.get_value(key).deepUnpack();
    }

    nameFor(account) {
        return this._dict('account-names')[account.unit] || this._dict('login-names')[account.unit] ||
            (account.unit === DEFAULT_UNIT ? 'OneDrive'
                : account.id.replace(/^onedrive[-_@]?/, '') || account.id);
    }

    titleFor(account) {
        return this._accounts.length > 1 ? `OneDrive – ${this.nameFor(account)}` : 'OneDrive';
    }

    setLoginName(account, loginName) {
        const names = this._dict('login-names');
        names[account.unit] = loginName;
        this._settings.set_value('login-names', new GLib.Variant('a{ss}', names));
    }

    accountChanged(_account) {
        this._update();
    }

    _managed() {
        return this._dict('managed-accounts');
    }

    _setManaged(managed) {
        this._settings.set_value('managed-accounts', new GLib.Variant('a{sa{ss}}', managed));
    }

    isPaused(account) {
        return this._managed()[account.unit]?.paused === 'true';
    }

    setPaused(account, paused) {
        const managed = this._managed();
        const entry = managed[account.unit];
        if (!entry || (entry.paused === 'true') === paused)
            return;
        entry.paused = String(paused);
        this._setManaged(managed);
    }

    // Removes an account created by the extension from all settings.
    forgetAccount(account) {
        for (const key of ['account-names', 'login-names']) {
            const names = this._dict(key);
            if (account.unit in names) {
                delete names[account.unit];
                this._settings.set_value(key, new GLib.Variant('a{ss}', names));
            }
        }
        const managed = this._managed();
        delete managed[account.unit];
        this._setManaged(managed);
    }

    _addAccountAction() {
        this.menu.close();
        new AddAccountDialog((name, folder) => this._addAccount(name, folder)).open();
    }

    // Checks the input and stores the new account; discovery then creates it and the
    // sign-in starts (see _discover()). Throws with a message for the dialog.
    async _addAccount(name, folder) {
        if (!name)
            throw new Error(_('Enter a name for the account.'));
        if (!folder.startsWith('~') && !GLib.path_is_absolute(folder))
            throw new Error(_('Enter the folder as a full path, e.g. ~/OneDrive-Private.'));
        const dir = Gio.File.new_for_path(expandHome(folder)).get_path();
        if (dir === '/' || dir === GLib.get_home_dir() ||
            overlaps(dir, GLib.get_user_config_dir()))
            throw new Error(_('Choose a folder of its own for the account.'));
        for (const account of this._accounts) {
            if (overlaps(dir, await account.syncDir()))
                throw new Error(fmt(_('The folder overlaps with the folder of “%s”.'), account.name));
        }

        // Unit and config directory: onedrive-<name>, made unique.
        const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'account';
        const managed = this._managed();
        let unit, confDir;
        for (let n = 1; ; n++) {
            const id = n === 1 ? slug : `${slug}-${n}`;
            unit = `onedrive-${id}.service`;
            confDir = GLib.build_filenamev([GLib.get_user_config_dir(), `onedrive-${id}`]);
            if (!(unit in managed) && !await exists(confDir) && !await unitExists(unit))
                break;
        }

        const names = this._dict('account-names');
        names[unit] = name;
        this._settings.set_value('account-names', new GLib.Variant('a{ss}', names));
        // Paused until signed in, so it is not started without a sign-in.
        managed[unit] = {'conf-dir': confDir, 'sync-dir': dir, paused: 'true'};
        this._pendingSignIn = unit;
        this._setManaged(managed);
    }

    _rediscover() {
        this._timers.schedule('discover', 300, () =>
            this._discover().catch(e => logError(e, 'cloud-sync-indicator: finding accounts')));
    }

    async _initDBus() {
        // Without Subscribe, systemd sends no signals. There is no Unsubscribe in disable(),
        // because the subscription belongs to the shell's shared D-Bus connection. For the same
        // reason it is still active when the extension is enabled again (e.g. after the screen
        // was locked), and systemd then answers "AlreadySubscribed".
        try {
            await dbusCall(MANAGER_PATH, MANAGER_IFACE, 'Subscribe', null);
        } catch (e) {
            if (!Gio.DBusError.get_remote_error(e)?.endsWith('.AlreadySubscribed'))
                throw e;
        }
        if (this._cancellable.is_cancelled())
            return;
        if (this._dbusSignalIds.length === 0) {
            // Units enabled or disabled, or unit files added or removed (daemon-reload).
            const bus = Gio.DBus.session;
            this._dbusSignalIds = ['UnitFilesChanged', 'Reloading'].map(signal =>
                bus.signal_subscribe(SYSTEMD, MANAGER_IFACE, signal, MANAGER_PATH, null,
                    Gio.DBusSignalFlags.NONE, () => this._rediscover()));
        }
        await this._discover();
    }

    _dbusFailed(e) {
        if (this._cancellable.is_cancelled())
            return;
        logError(e, 'cloud-sync-indicator: systemd not reachable');
        // Setup did not finish: try again later instead of staying in "unknown".
        if (!this._discovered) {
            this._timers.schedule('dbus-retry', 30000, () =>
                this._initDBus().catch(err => this._dbusFailed(err)));
        }
    }

    // Keeps the Account objects of units that are still there, so their state is kept.
    async _discover() {
        const specs = await findAccounts(this._managed());
        if (this._cancellable.is_cancelled())
            return;
        this._discovered = true;
        const key = a => `${a.unit}\n${a.confDir}`;
        const old = new Map(this._accounts.map(a => [key(a), a]));
        const next = specs.map(spec => old.get(key(spec)) ?? new Account(this, spec));
        const added = next.filter(a => !this._accounts.includes(a));
        const removed = this._accounts.filter(a => !next.includes(a));
        if (added.length === 0 && removed.length === 0 &&
            next.every((a, i) => a === this._accounts[i])) {
            this._startPendingSignIn();
            return;
        }

        removed.forEach(a => a.destroy());
        this._accounts = next;
        const units = next.map(a => a.unit);
        if (this._settings.get_strv('known-accounts').join('\n') !== units.join('\n'))
            this._settings.set_strv('known-accounts', units);
        this._rebuildViews();
        added.forEach(a => a.start());
        this._startJournal();
        this._update();
        this._startPendingSignIn();
    }

    // A newly added account: sign in right away (the add dialog has explained it).
    _startPendingSignIn() {
        const account = this._accounts.find(a => a.unit === this._pendingSignIn);
        if (!account)
            return;
        this._pendingSignIn = null;
        account.beginAuth();
    }

    // --- Menu --------------------------------------------------------------

    _buildMenu() {
        this._accountSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._accountSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Add Account'), () => this._addAccountAction(), 'list-add-symbolic');
        this._logMenu = new PopupMenu.PopupSubMenuMenuItem(_('Recent Messages'), true);
        this._logMenu.icon.icon_name = 'document-open-recent-symbolic';
        this.menu.addMenuItem(this._logMenu);
        this._logMenu.menu.addAction(_('Full Log in Terminal'),
            () => this._openJournalInTerminal(), 'utilities-terminal-symbolic');
        this._logSection = new PopupMenu.PopupMenuSection();
        this._logMenu.menu.addMenuItem(this._logSection);

        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._fillLog();
        });
    }

    _rebuildViews() {
        this._accountSection.removeAll();
        const single = this._accounts.length === 1;
        this._views = this._accounts.map(a => new AccountView(a, this._accountSection, single));
        if (this._accounts.length === 0) {
            // Until systemd has answered.
            const status = new PopupMenu.PopupImageMenuItem(
                fmt(_('OneDrive: %s'), _(STATES.unknown.text)), STATES.unknown.icon, {reactive: false});
            const detail = detailItem();
            detail.label.text = _('systemd service not reachable');
            this._accountSection.addMenuItem(status);
            this._accountSection.addMenuItem(detail);
        }
    }

    _fillLog() {
        this._logSection.removeAll();
        const fileOps = this._settings.get_boolean('file-operations-only');
        const log = this._accounts.flatMap(a => fileOps ? a.fileLog : a.log)
            .sort((a, b) => a.time.compare(b.time));
        if (log.length === 0) {
            this._logSection.addMenuItem(new PopupMenu.PopupMenuItem(_('(none)'), {reactive: false}));
            return;
        }
        const several = this._accounts.length > 1;
        const count = this._settings.get_int('log-entries');
        for (const entry of log.slice(-count).reverse())
            this._logSection.addMenuItem(logItem(entry, several));
    }

    _journalUnitArgs() {
        return this._accounts.flatMap(a => ['-u', a.unit, '-u', a.resyncUnit]);
    }

    _openJournalInTerminal() {
        const command = ['journalctl', '--user', ...this._journalUnitArgs(), '-n', '200', '-f'];
        const terminal = TERMINALS.find(([name]) => GLib.find_program_in_path(name));
        if (!terminal) {
            Main.notify('OneDrive', fmt(_('No terminal found. Command: %s'), command.join(' ')));
            return;
        }
        try {
            Gio.Subprocess.new([...terminal, ...command], Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notify('OneDrive', e.message);
        }
    }

    // --- Journal -----------------------------------------------------------

    // A single journalctl for all accounts; restarted when the accounts change.
    _startJournal() {
        this._journalCancellable?.cancel();
        this._journalCancellable = null;
        this._journal?.force_exit();
        this._journal = null;
        this._timers.unschedule('journal-retry');
        if (this._cancellable.is_cancelled() || this._accounts.length === 0)
            return;

        // Older lines are replayed first (-n). No notifications meanwhile: they contain, for
        // example, sign-in errors that were resolved long ago.
        this._replaying = true;
        for (const account of this._accounts)
            account.resetJournalState();
        this._timers.schedule('replay-end', 1500, () => this._endReplay());
        const cancellable = new Gio.Cancellable();
        this._journalCancellable = cancellable;
        try {
            this._journal = Gio.Subprocess.new(
                ['journalctl', '--user', ...this._journalUnitArgs(), '-f', '-n', '1000',
                    '-o', 'json', '--output-fields=MESSAGE,USER_UNIT,_SYSTEMD_USER_UNIT'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const stream = new Gio.DataInputStream({base_stream: this._journal.get_stdout_pipe()});
            this._readJournal(stream, cancellable).catch(e => {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(e, 'cloud-sync-indicator: reading journal');
            }).finally(() => {
                if (this._journalCancellable === cancellable)
                    this._journalEnded();
            });
        } catch (e) {
            logError(e, 'cloud-sync-indicator: journalctl');
            this._journalEnded();
        }
    }

    async _readJournal(stream, cancellable) {
        for (;;) {
            // Returns bytes, see promisifyAsyncMethods().
            const [bytes] = await stream.read_line_async(GLib.PRIORITY_LOW, cancellable);
            if (bytes === null)
                return;
            this._handleLine(this._decoder.decode(bytes));
        }
    }

    _journalEnded() {
        this._journal = null;
        this._journalCancellable = null;
        if (!this._cancellable.is_cancelled())
            this._timers.schedule('journal-retry', 10000, () => this._startJournal());
    }

    _endReplay() {
        this._replaying = false;
        for (const account of this._accounts)
            account.replayEnded();
        this._update();
    }

    _handleLine(line) {
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            return;
        }
        // journalctl writes a message that is not valid UTF-8 as an array of bytes.
        let msg = entry.MESSAGE;
        if (Array.isArray(msg))
            msg = this._decoder.decode(new Uint8Array(msg));
        msg = typeof msg === 'string' ? msg.trim() : '';
        // Messages from systemd itself ("Started …") carry the unit in USER_UNIT.
        const unit = entry.USER_UNIT ?? entry._SYSTEMD_USER_UNIT;
        const account = this._accounts.find(a => a.unit === unit || a.resyncUnit === unit);
        if (!msg || !account)
            return;
        // __REALTIME_TIMESTAMP: microseconds since the epoch, as a string.
        const time = GLib.DateTime.new_from_unix_utc(0).add(Number(entry.__REALTIME_TIMESTAMP));
        account.handleMessage(time, msg);

        if (this._replaying)
            this._timers.schedule('replay-end', 1500, () => this._endReplay());
        else
            this._update();
    }

    // --- Display -----------------------------------------------------------

    _update() {
        if (this._cancellable.is_cancelled())
            return;
        const states = this._views.map(view => [view.account, ...view.update()]);
        const keys = states.map(([, key]) => key)
            .sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b));
        const state = STATES[keys[0] ?? 'unknown'];

        this._icon.icon_name = state.icon;
        this._icon.remove_style_class_name('cloud-sync-error');
        this._icon.remove_style_class_name('cloud-sync-warning');
        if (state.style)
            this._icon.add_style_class_name(state.style);

        if (!this._replaying) {
            for (const [account, key, hint] of states)
                account.noteState(key, hint);
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._journalCancellable?.cancel();
        this._journalCancellable = null;
        this._journal?.force_exit();
        this._journal = null;
        for (const account of this._accounts)
            account.destroy();
        this._accounts = [];
        this._views = [];
        this._timers.clear();
        for (const id of this._dbusSignalIds)
            Gio.DBus.session.signal_unsubscribe(id);
        this._dbusSignalIds = [];
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        if (this._menuOpenId)
            this.menu.disconnect(this._menuOpenId);
        this._menuOpenId = 0;
        super.destroy();
    }
});

export default class CloudSyncIndicatorExtension extends Extension {
    enable() {
        promisifyAsyncMethods();
        this._indicator = new SyncIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
