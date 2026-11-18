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
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Marks strings for xgettext that are translated later, at runtime: while the module is
// being loaded, the extension's translation domain is not bound yet.
const N_ = s => s;

const UNIT = 'onedrive.service';
const RESYNC_UNIT = 'cloud-sync-indicator-resync.service';
const SYSTEMD = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const MANAGER_IFACE = 'org.freedesktop.systemd1.Manager';
const CONF_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'onedrive']);
const TOKEN_FILE = GLib.build_filenamev([CONF_DIR, 'refresh_token']);
const CONFIG_FILE = GLib.build_filenamev([CONF_DIR, 'config']);
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
const RE_UNIT_STARTED = /^Started onedrive\.service/;
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

function unitJob(method, unit = UNIT) {
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

async function syncDir() {
    const conf = await readText(CONFIG_FILE) ?? '';
    const m = conf.match(/^\s*sync_dir\s*=\s*"([^"]*)"/m);
    const dir = m ? m[1] : '~/OneDrive';
    return dir.startsWith('~') ? GLib.get_home_dir() + dir.slice(1) : dir;
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
    _init({title, description, okLabel = _('Continue')}, onContinue) {
        super._init({styleClass: 'cloud-sync-dialog'});
        this.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));
        this.setButtons([
            {label: _('Cancel'), action: () => this.close(), key: Clutter.KEY_Escape},
            {
                label: okLabel,
                default: true,
                action: () => {
                    this.close();
                    onContinue();
                },
            },
        ]);
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
    constructor(indicator) {
        this._indicator = indicator;
        this._cancellable = new Gio.Cancellable();
        this._client = null;
        this._clientDone = null;
        this._clientExited = false;
        this._loginWin = null;
        this._authUrl = null;
        this._notification = null;
        this._wasRunning = false;
        this._ended = false;
        this.waitingForClipboard = false;

        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'cloud-sync-indicator-auth']);
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

            this._wasRunning = await this._indicator.isServiceRunning();
            if (this._wasRunning) {
                this._indicator.setAuthHint(_('Stopping OneDrive …'));
                await this._indicator.stopServiceAndWait(this._cancellable);
            }

            // --reauth discards the existing sign-in right away, not only on success.
            const argv = [onedrive];
            if (await exists(TOKEN_FILE))
                argv.push('--reauth');
            argv.push('--auth-files', `${this._urlFile}:${this._respFile}`);
            this._indicator.setAuthHint(_('Requesting sign-in address …'));
            this._client = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_MERGE);
            this._clientDone = this._client.communicate_utf8_async(null, this._cancellable)
                .then(([, out]) => out ?? '')
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

    async _runLoginWindow() {
        const script = GLib.build_filenamev([this._indicator.extensionPath, 'auth-window.js']);
        let win;
        try {
            win = Gio.Subprocess.new(['gjs', '-m', script, this._authUrl, this._respFile],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            this._useBrowser(fmt(_('The sign-in window could not be started (%s).'), e.message));
            return;
        }
        this._loginWin = win;
        this._indicator.setAuthHint(_('Sign in using the sign-in window'));
        const [, output] = await win.communicate_utf8_async(null, this._cancellable);
        if (this._loginWin !== win)
            return; // cancelled
        this._loginWin = null;

        // Do not check success via the response file: the client reads and deletes it at once.
        // get_exit_status() is only valid after a normal exit, not after a signal.
        switch (win.get_if_exited() ? win.get_exit_status() : -1) {
        case LOGIN_OK:
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
        this._indicator.setAuthHint(_('Copy the response address from the browser'));
        this._showNotification(fmt(_('%s Sign in using the browser'), reason),
            _('After signing in, copy the address of the blank page (…/nativeclient?code=…) – ' +
              'if the page redirects, it is in the browser history – then choose ' +
              '“Sign in from clipboard” (also in the indicator menu).'),
            [
                [_('Sign in from clipboard'), () => this.fromClipboard()],
                [_('Cancel'), () => this.cancel()],
            ]);
    }

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
        this._indicator.setAuthHint(_('Completing sign-in …'));
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
            this._indicator.authSucceeded();
            Main.notify('OneDrive', _('Signed in. Restarting OneDrive.'));
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
            const info = await Gio.File.new_for_path(TOKEN_FILE).query_info_async(
                'time::modified', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
            return info.get_modification_date_time().to_unix() * 1000 >= ms;
        } catch {
            return false;
        }
    }

    async _fail(message) {
        this._clearNotification();
        Main.notify(_('OneDrive: sign-in failed'), message);
        await this._end(false);
    }

    cancel() {
        if (this._ended)
            return;
        this._cancellable.cancel();
        Main.notify('OneDrive', _('Sign-in cancelled.'));
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
        this._indicator.authEnded(this);
        if (startService || this._wasRunning)
            await this._indicator.startService();
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
// Panel indicator

const SyncIndicator = GObject.registerClass(
class SyncIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Cloud Sync Indicator', false);
        this.extensionPath = extension.path;
        this._settings = extension.getSettings();
        this._logMax = this._settings.settings_schema.get_key('log-entries')
            .get_range().deepUnpack()[1].deepUnpack()[1];
        this._cancellable = new Gio.Cancellable();

        this._unitPath = null;
        this._props = {};
        this._hasToken = true;
        this._syncing = false;
        this._offline = false;
        this._authError = false;
        this._lastSync = null;
        this._lastActivity = null;
        this._log = [];       // all messages except routine lines
        this._fileLog = [];   // file operations only
        this._decoder = new TextDecoder();
        this._stateKey = null;
        this._replaying = false;
        this._resyncRunning = false;
        this._auth = null;
        this._authHint = null;
        this._journal = null;
        this._confMonitor = null;
        this._signalIds = [];
        this._sources = new Map(); // name → GLib source, see _schedule()

        // Compact like AppIndicator icons in their “compact mode”.
        this.set_style('-natural-hpadding: 10px');
        this._icon = new St.Icon({
            icon_name: STATES.unknown.icon,
            style_class: 'system-status-icon',
            style: 'padding: 0; margin: 0',
        });
        this.add_child(this._icon);

        this._buildMenu();
        this._watchConfDir();
        this._initDBus().catch(e => this._dbusFailed(e));
        this._startJournal();
    }

    // One-shot named timers; scheduling the same name again replaces the old one.
    _schedule(name, ms, callback) {
        this._unschedule(name);
        this._sources.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sources.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _unschedule(name) {
        const id = this._sources.get(name);
        if (id) {
            GLib.source_remove(id);
            this._sources.delete(name);
        }
    }

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupImageMenuItem('', STATES.unknown.icon, {reactive: false});
        this._detailItem = new PopupMenu.PopupMenuItem('', {reactive: false, style_class: 'cloud-sync-log-item'});
        this._detailItem.label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        this._detailItem.label.style = 'max-width: 36em;';
        this.menu.addMenuItem(this._statusItem);
        this.menu.addMenuItem(this._detailItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction(_('Open OneDrive Folder'),
            () => syncDir().then(dir => this._launch(Gio.File.new_for_path(dir).get_uri())),
            'folder-symbolic');
        this.menu.addAction(_('Edit Configuration'),
            () => this._launch(Gio.File.new_for_path(CONFIG_FILE).get_uri()),
            'document-edit-symbolic');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._toggleItem = this.menu.addAction('', () => this._toggleService(),
            'media-playback-pause-symbolic');
        this._resyncItem = this.menu.addAction(_('Resync …'), () => this._resyncAction(),
            'view-refresh-symbolic');
        this._restartItem = this.menu.addAction(_('Restart'), () => this._restartService(),
            'system-reboot-symbolic');
        this._clipItem = this.menu.addAction(_('Sign in from clipboard'),
            () => this._auth?.fromClipboard(), 'edit-paste-symbolic');
        this._authItem = this.menu.addAction('', () => this._authAction(), 'dialog-password-symbolic');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._logMenu = new PopupMenu.PopupSubMenuMenuItem(_('Recent Messages'), true);
        this._logMenu.icon.icon_name = 'document-open-recent-symbolic';
        this.menu.addMenuItem(this._logMenu);
        this._logMenu.menu.addAction(_('Full Log in Terminal'),
            () => this._openJournalInTerminal(), 'utilities-terminal-symbolic');
        this._logSection = new PopupMenu.PopupMenuSection();
        this._logMenu.menu.addMenuItem(this._logSection);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._fillLog();
        });
    }

    _fillLog() {
        this._logSection.removeAll();
        const log = this._settings.get_boolean('file-operations-only') ? this._fileLog : this._log;
        if (log.length === 0) {
            this._logSection.addMenuItem(new PopupMenu.PopupMenuItem(_('(none)'), {reactive: false}));
            return;
        }
        const count = this._settings.get_int('log-entries');
        for (const {time, msg} of log.slice(-count).reverse()) {
            const item = new PopupMenu.PopupMenuItem(`${formatTime(time)}  ${msg}`,
                {reactive: false, style_class: 'cloud-sync-log-item'});
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            item.label.style = 'max-width: 36em;';
            this._logSection.addMenuItem(item);
        }
    }

    _pushLog(list, entry) {
        list.push(entry);
        if (list.length > this._logMax)
            list.shift();
    }

    _openJournalInTerminal() {
        const command = ['journalctl', '--user', '-u', UNIT, '-u', RESYNC_UNIT, '-n', '200', '-f'];
        const terminal = TERMINALS.find(([name]) => GLib.find_program_in_path(name));
        if (!terminal) {
            Main.notify('OneDrive', fmt(_('No terminal found. Command: %s'), command.join(' ')));
            return;
        }
        try {
            Gio.Subprocess.new([...terminal, ...command], Gio.SubprocessFlags.NONE);
        } catch (e) {
            this._notifyError(e);
        }
    }

    _launch(uri) {
        try {
            launchUri(uri);
        } catch (e) {
            this._notifyError(e);
        }
    }

    // --- systemd -----------------------------------------------------------

    async _initDBus() {
        // Without Subscribe, systemd sends no PropertiesChanged signals. There is no Unsubscribe
        // in disable(), because the subscription belongs to the shell's shared D-Bus connection.
        await dbusCall(MANAGER_PATH, MANAGER_IFACE, 'Subscribe', null);
        const [path] = (await dbusCall(MANAGER_PATH, MANAGER_IFACE, 'LoadUnit',
            new GLib.Variant('(s)', [UNIT]), '(o)')).deepUnpack();
        if (this._cancellable.is_cancelled())
            return;
        this._unitPath = path;

        // Derive the resync unit's object path from its name instead of calling LoadUnit:
        // loading would create a placeholder unit and trigger UnitNew/UnitRemoved.
        const resyncPath = `${MANAGER_PATH}/unit/${RESYNC_UNIT.replace(/[^A-Za-z0-9]/g,
            c => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
        const refresh = () => this._schedule('refresh', 150, () =>
            this._refresh().catch(e => this._dbusFailed(e)));
        const bus = Gio.DBus.session;
        this._signalIds = [
            bus.signal_subscribe(SYSTEMD, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                path, null, Gio.DBusSignalFlags.NONE, refresh),
            bus.signal_subscribe(SYSTEMD, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                resyncPath, null, Gio.DBusSignalFlags.NONE, refresh),
            bus.signal_subscribe(SYSTEMD, MANAGER_IFACE, 'UnitNew', MANAGER_PATH,
                RESYNC_UNIT, Gio.DBusSignalFlags.NONE, refresh),
            bus.signal_subscribe(SYSTEMD, MANAGER_IFACE, 'UnitRemoved', MANAGER_PATH,
                RESYNC_UNIT, Gio.DBusSignalFlags.NONE, refresh),
        ];
        await this._refresh();
    }

    _dbusFailed(e) {
        if (this._cancellable.is_cancelled())
            return;
        logError(e, 'cloud-sync-indicator: systemd not reachable');
        this._props = {};
        this._update();
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
            new GLib.Variant('(asas)', [[], [RESYNC_UNIT]]), '(a(ssssssouso))')).deepUnpack();
        if (this._cancellable.is_cancelled())
            return;

        this._props = {
            active: unit.ActiveState,
            sub: unit.SubState,
            load: unit.LoadState,
            result: svc.Result,
            status: svc.ExecMainStatus,
            restarts: svc.NRestarts,
        };
        const resyncActive = units.some(u => ['active', 'activating', 'deactivating'].includes(u[3]));
        if (this._resyncRunning && !resyncActive)
            this._resyncEnded();
        this._resyncRunning = resyncActive;
        this._update();
    }

    async isServiceRunning() {
        await this._refresh();
        return RUNNING.includes(this._props.active);
    }

    async stopServiceAndWait(cancellable) {
        await unitJob('StopUnit');
        // The client finishes running transfers first (TimeoutStopSec=90 in the unit).
        for (let i = 0; i < 240; i++) {
            await this._refresh();
            if (['inactive', 'failed'].includes(this._props.active))
                return;
            await sleep(500, cancellable);
        }
        throw new Error(_('OneDrive could not be stopped.'));
    }

    async startService() {
        try {
            await unitJob('StartUnit');
        } catch (e) {
            this._notifyError(e);
        }
    }

    _toggleService() {
        unitJob(RUNNING.includes(this._props.active) ? 'StopUnit' : 'StartUnit')
            .catch(e => this._notifyError(e));
    }

    _restartService() {
        unitJob('RestartUnit').catch(e => this._notifyError(e));
    }

    // --- Journal -----------------------------------------------------------

    _startJournal() {
        if (this._cancellable.is_cancelled())
            return;
        // Older lines are replayed first (-n). No notifications meanwhile: they contain, for
        // example, sign-in errors that were resolved long ago.
        this._replaying = true;
        this._schedule('replay-end', 1500, () => this._endReplay());
        try {
            this._journal = Gio.Subprocess.new(
                ['journalctl', '--user', '-u', UNIT, '-u', RESYNC_UNIT, '-f', '-n', '1000',
                    '-o', 'short-iso', '--no-hostname'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const stream = new Gio.DataInputStream({base_stream: this._journal.get_stdout_pipe()});
            this._readJournal(stream).catch(e => {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(e, 'cloud-sync-indicator: reading journal');
            }).finally(() => this._journalEnded());
        } catch (e) {
            logError(e, 'cloud-sync-indicator: journalctl');
            this._journalEnded();
        }
    }

    async _readJournal(stream) {
        for (;;) {
            // Returns bytes, see promisifyAsyncMethods().
            const [bytes] = await stream.read_line_async(GLib.PRIORITY_LOW, this._cancellable);
            if (bytes === null)
                return;
            this._handleLine(this._decoder.decode(bytes));
        }
    }

    _journalEnded() {
        this._journal = null;
        if (!this._cancellable.is_cancelled())
            this._schedule('journal-retry', 10000, () => this._startJournal());
    }

    _endReplay() {
        this._replaying = false;
        // On first start, an error that already exists should still be reported.
        this._stateKey ??= 'unknown';
        this._update();
    }

    _handleLine(line) {
        const m = line.match(/^(\S+)\s+[^:]+:\s?(.*)$/);
        const msg = m?.[2].trim();
        if (!msg)
            return;
        const time = GLib.DateTime.new_from_iso8601(m[1], null);

        if (RE_UNIT_STARTED.test(msg)) {
            this._syncing = false;
            this._offline = false;
        } else if (RE_SYNC_START.test(msg)) {
            this._syncing = true;
        } else if (RE_SYNC_DONE.test(msg)) {
            this._syncing = false;
            this._authError = false;
            this._lastSync = time;
        }
        if (RE_AUTH.test(msg))
            this._authError = true;
        if (RE_OFFLINE.test(msg))
            this._offline = true;
        else if (RE_ONLINE.test(msg))
            this._offline = false;

        // Both lists are kept, so that switching the setting takes effect immediately.
        const entry = {time, msg};
        if (RE_FILE_OP.test(msg)) {
            this._lastActivity = entry;
            this._pushLog(this._fileLog, entry);
        }
        if (!RE_ROUTINE.test(msg))
            this._pushLog(this._log, entry);

        if (this._replaying)
            this._schedule('replay-end', 1500, () => this._endReplay());
        else
            this._update();
    }

    // --- Config directory --------------------------------------------------

    // Watches ~/.config/onedrive: the sign-in token (refresh_token) and the configuration.
    _watchConfDir() {
        this._checkToken();
        try {
            this._confMonitor = Gio.File.new_for_path(CONF_DIR).monitor_directory(
                Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._confMonitor.connect('changed', (_monitor, file, other, event) => {
                const names = [file?.get_basename(), other?.get_basename()];
                if (names.includes('refresh_token'))
                    this._checkToken();
                if (names.includes('config') && [Gio.FileMonitorEvent.CHANGES_DONE_HINT,
                    Gio.FileMonitorEvent.RENAMED, Gio.FileMonitorEvent.MOVED_IN,
                    Gio.FileMonitorEvent.CREATED].includes(event))
                    // Editors often save in several steps – collect them briefly.
                    this._schedule('config-notice', 2000, () => this._configChanged());
            });
        } catch (e) {
            logError(e, 'cloud-sync-indicator: watching config directory');
        }
    }

    async _checkToken() {
        const found = await exists(TOKEN_FILE);
        if (this._cancellable.is_cancelled())
            return;
        this._hasToken = found;
        this._update();
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
        notification.addAction(_('Restart Now'), () => this._restartService());
        source.addNotification(notification);
    }

    // --- State -------------------------------------------------------------

    _computeState() {
        const p = this._props;
        if (!p.active)
            return ['unknown', _('systemd service not reachable')];
        if (p.load === 'not-found')
            return ['error', fmt(_('%s is not installed'), UNIT)];
        if (this._auth)
            return ['auth', this._authHint ?? _('Signing in …')];
        if (this._resyncRunning)
            return ['resyncing', _('Rebuilding the local database – this may take a while')];
        if (!this._hasToken || this._authError)
            return ['auth', _('Sign in again via “Sign In …”')];

        switch (p.active) {
        case 'active':
        case 'reloading':
            if (this._offline)
                return ['offline', _('The client keeps retrying')];
            return [this._syncing ? 'syncing' : 'ok', null];
        case 'activating':
            if (p.sub === 'auto-restart' || p.restarts >= 2)
                return ['error', fmt(_('Restarting repeatedly (%s×) – see recent messages'), p.restarts)];
            return ['starting', null];
        case 'deactivating':
            return ['stopping', null];
        case 'failed':
            if (p.status === 126)
                return ['resync', _('Use “Resync …” – or run in a terminal: onedrive --sync --resync')];
            // The client exits with status 15 on SIGTERM – a normal stop.
            if (p.status === 15 || p.result === 'success')
                return ['paused', null];
            return ['error', fmt(_('Exited with status %s (%s)'), p.status, p.result)];
        default:
            return ['paused', null];
        }
    }

    _update() {
        const [key, hint] = this._computeState();
        const state = STATES[key];

        this._icon.icon_name = state.icon;
        this._icon.remove_style_class_name('cloud-sync-error');
        this._icon.remove_style_class_name('cloud-sync-warning');
        if (state.style)
            this._icon.add_style_class_name(state.style);

        const stateText = _(state.text);
        this._statusItem.label.text = fmt(_('OneDrive: %s'), stateText);
        this._statusItem.setIcon(state.icon);
        const details = [];
        if (hint)
            details.push(hint);
        if (this._lastSync)
            details.push(fmt(_('Last sync: %s'), formatTime(this._lastSync)));
        if (this._lastActivity)
            details.push(`${formatTime(this._lastActivity.time)}  ${this._lastActivity.msg}`);
        this._detailItem.label.text = details.join('\n') || ' ';

        const running = RUNNING.includes(this._props.active);
        const known = !!this._props.active;
        this._toggleItem.label.text = running ? _('Pause') : _('Start');
        this._toggleItem.setIcon(running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic');
        this._toggleItem.visible = known && !this._resyncRunning;
        this._restartItem.visible = known && this._props.active !== 'inactive' && !this._resyncRunning;
        this._resyncItem.visible = key === 'resync';
        this._authItem.label.text = this._auth ? _('Cancel Sign-in')
            : this._hasToken ? _('Sign In Again …') : _('Sign In …');
        this._authItem.setIcon(this._auth ? 'process-stop-symbolic' : 'dialog-password-symbolic');
        this._clipItem.visible = !!this._auth?.waitingForClipboard;

        if (!this._replaying && key !== this._stateKey) {
            const previous = this._stateKey;
            this._stateKey = key;
            if (state.notify && previous !== null && !this._auth)
                Main.notify('OneDrive', hint ? `${stateText} – ${hint}` : stateText);
        }
    }

    // --- Sign-in -----------------------------------------------------------

    _authAction() {
        this.menu.close();
        if (this._auth) {
            this._auth.cancel();
            return;
        }
        new ConfirmDialog({
            title: this._hasToken ? _('Sign In to OneDrive Again') : _('Sign In to OneDrive'),
            description: [
                _('OneDrive will be stopped briefly.'),
                this._hasToken ? _('The current sign-in will be discarded.') : '',
                _('After “Continue”, a separate sign-in window with the Microsoft sign-in ' +
                  'opens. It closes by itself once you have signed in.'),
            ].filter(Boolean).join('\n\n'),
        }, () => {
            if (this._auth || this._cancellable.is_cancelled())
                return;
            this._auth = new AuthFlow(this);
            this._authHint = null;
            this._update();
            this._auth.run().catch(logError);
        }).open();
    }

    setAuthHint(text) {
        this._authHint = text;
        this._update();
    }

    authEnded(flow) {
        if (this._auth === flow) {
            this._auth = null;
            this._authHint = null;
        }
        if (!this._cancellable.is_cancelled())
            this._update();
    }

    authSucceeded() {
        this._authError = false;
    }

    // --- Resync ------------------------------------------------------------

    _resyncAction() {
        this.menu.close();
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
                'systemd-run', '--user', `--unit=${RESYNC_UNIT}`, '--collect',
                '--description=OneDrive resync (Cloud Sync Indicator)', '-p', 'ProtectSystem=full',
                // On success, start the service from within the unit, not from the shell.
                '/bin/sh', '-c',
                '"$0" --sync --resync --resync-auth && exec systemctl --user start onedrive.service',
                onedrive,
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
            const [, out] = await proc.communicate_utf8_async(null, this._cancellable);
            if (!proc.get_successful())
                throw new Error(lastLines(out) || _('systemd-run failed.'));
            this._resyncRunning = true;
            this._update();
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                this._notifyError(e);
        }
    }

    // The unit's result cannot be queried (--collect removes it at once). On success it has
    // started the service – that tells us the outcome.
    _resyncEnded() {
        this._schedule('resync-result', 3000, () => {
            Main.notify('OneDrive', RUNNING.includes(this._props.active)
                ? _('Resync finished, OneDrive is running again.')
                : _('Resync failed – see “Full Log in Terminal”.'));
        });
    }

    _notifyError(e) {
        Main.notify('OneDrive', e.message ?? String(e));
    }

    destroy() {
        this._cancellable.cancel();
        this._auth?.abort();
        this._auth = null;
        for (const id of this._sources.values())
            GLib.source_remove(id);
        this._sources.clear();
        this._confMonitor?.cancel();
        this._confMonitor = null;
        for (const id of this._signalIds)
            Gio.DBus.session.signal_unsubscribe(id);
        this._signalIds = [];
        this._journal?.force_exit();
        this._journal = null;
        this._log = [];
        this._fileLog = [];
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
