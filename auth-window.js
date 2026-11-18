#!@GJS@ -m
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Sign-in window for the OneDrive client – a standalone GJS script running in its own
// process (GTK/WebKit must not be loaded into the gnome-shell process).
//
// Usage: gjs -m auth-window.js AUTH_URL RESPONSE_FILE
//
// Loads the Microsoft sign-in and intercepts the redirect to …/oauth2/nativeclient?code=…
// before Microsoft redirects away from it. The full response address is written atomically
// to RESPONSE_FILE; nothing else leaves this window.
//
// Exit status: 0 = response written, 10 = window closed,
//              11 = Microsoft reported an error, 12 = wrong usage.
// (Status 1 comes from gjs itself, e.g. when WebKitGTK 6.0 is missing.)

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import WebKit from 'gi://WebKit?version=6.0';
import Gettext from 'gettext';
import System from 'system';

// Translations from the extension's locale/ directory (next to this script).
const DOMAIN = 'cloud-sync-indicator';
const scriptDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
Gettext.bindtextdomain(DOMAIN, GLib.build_filenamev([scriptDir, 'locale']));
const _ = s => Gettext.dgettext(DOMAIN, s);

const EXIT_OK = 0;
const EXIT_CLOSED = 10;
const EXIT_REJECTED = 11;
const EXIT_USAGE = 12;

const [authUrl, responseFile] = System.programArgs;
if (!authUrl?.startsWith('https://login.microsoftonline.com/') || !responseFile) {
    printerr('Usage: gjs -m auth-window.js AUTH_URL RESPONSE_FILE');
    System.exit(EXIT_USAGE);
}

const REDIRECT = /^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/nativeclient\?/;
let exitCode = EXIT_CLOSED;

const app = new Adw.Application({application_id: 'io.github.rsteber.CloudSyncIndicator.Login'});

app.connect('activate', () => {
    const title = new Adw.WindowTitle({title: _('Sign In to OneDrive'), subtitle: ''});
    const header = new Adw.HeaderBar({title_widget: title});

    // Ephemeral session: no cookies or data remain after closing.
    const view = new WebKit.WebView({
        network_session: WebKit.NetworkSession.new_ephemeral(),
        vexpand: true,
        hexpand: true,
    });

    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    box.append(header);
    box.append(view);

    const win = new Adw.ApplicationWindow({
        application: app,
        default_width: 520,
        default_height: 720,
        content: box,
    });

    let done = false;
    const check = uri => {
        if (done || !uri || !REDIRECT.test(uri))
            return false;
        done = true;
        // '+' means a space in the query; parse_params() only decodes %XX.
        const query = uri.split('?')[1].split('#')[0].replace(/\+/g, '%20');
        const params = GLib.Uri.parse_params(query, -1, '&', GLib.UriParamsFlags.NONE);
        if (params.code) {
            GLib.file_set_contents(responseFile, `${uri}\n`);
            exitCode = EXIT_OK;
        } else {
            printerr(_('Microsoft reports: %s – %s')
                .replace('%s', params.error ?? '?')
                .replace('%s', params.error_description ?? ''));
            exitCode = EXIT_REJECTED;
        }
        view.stop_loading();
        // Not win.close(): this may run before present(); quit the application instead.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            app.quit();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    };

    // Intercept redirects and navigations before the page is loaded.
    view.connect('decide-policy', (_view, decision, type) => {
        if (type === WebKit.PolicyDecisionType.NAVIGATION_ACTION ||
            type === WebKit.PolicyDecisionType.NEW_WINDOW_ACTION) {
            const uri = decision.get_navigation_action().get_request().get_uri();
            if (check(uri)) {
                decision.ignore();
                return true;
            }
        }
        return false;
    });
    // Fallback for server redirects that do not go through decide-policy.
    view.connect('notify::uri', () => {
        const uri = view.get_uri();
        if (!check(uri)) {
            try {
                title.subtitle = GLib.Uri.parse(uri, GLib.UriFlags.NONE).get_host() ?? '';
            } catch {
                title.subtitle = '';
            }
        }
    });

    view.load_uri(authUrl);
    if (!done)
        win.present();
});

app.run([]);
System.exit(exitCode);
