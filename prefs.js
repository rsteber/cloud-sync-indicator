// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CloudSyncIndicatorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage();
        window.add(page);

        const group = new Adw.PreferencesGroup({title: _('Menu')});
        page.add(group);

        // The limits come from the schema (<range>) so they are defined in one place only.
        const [min, max] = settings.settings_schema.get_key('log-entries')
            .get_range().deepUnpack()[1].deepUnpack();
        const row = new Adw.SpinRow({
            title: _('Recent Entries'),
            subtitle: _('Number of entries shown (at most %s)').replace('%s', max),
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1, page_increment: 5}),
        });
        settings.bind('log-entries', row, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);

        const filterRow = new Adw.SwitchRow({
            title: _('File Operations Only'),
            subtitle: _('Uploads, downloads, deletions and moves; otherwise all client messages'),
        });
        settings.bind('file-operations-only', filterRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(filterRow);

        // Names only appear in the menu with more than one account.
        const units = settings.get_strv('known-accounts');
        if (units.length > 1)
            page.add(this._accountsGroup(settings, units));
    }

    _accountsGroup(settings, units) {
        const group = new Adw.PreferencesGroup({
            title: _('Accounts'),
            description: _('Names shown in the menu. Leave empty to show the address used to sign in.'),
        });
        const loginNames = settings.get_value('login-names').deepUnpack();
        for (const unit of units) {
            const row = new Adw.EntryRow({
                title: loginNames[unit] ? `${unit} · ${loginNames[unit]}` : unit,
                text: settings.get_value('account-names').deepUnpack()[unit] ?? '',
                show_apply_button: true,
            });
            row.connect('apply', () => {
                const names = settings.get_value('account-names').deepUnpack();
                const name = row.text.trim();
                if (name)
                    names[unit] = name;
                else
                    delete names[unit];
                settings.set_value('account-names', new GLib.Variant('a{ss}', names));
            });
            group.add(row);
        }
        return group;
    }
}
