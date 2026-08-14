const Applet = imports.ui.applet;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Util = imports.misc.util;
const AppletManager = imports.ui.appletManager;
const Cairo = imports.cairo;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const DEFAULT_COMMAND = "/opt/apps/codexbar/codexbar";
const DEFAULT_PROVIDER = "both";
const DEFAULT_REFRESH_SECONDS = 60;
const PANEL_GAUGE_WIDTH = 30;
const PANEL_GAUGE_HEIGHT = 18;

// Konzentrische Ringe: Abstand und Strichstaerke so gewaehlt, dass zwei Ringe
// in einem 30x18-Panelbereich klar getrennt bleiben.
const RING_SPACING = 4.5;
const RING_WIDTH = 3.0;

// Providerfarben: Claude im markentypischen Orange (#D97757), Codex in einem
// klar abgesetzten Blau. Diese Farbe traegt der Fuellbogen, damit die Ringe auf
// einen Blick zuzuordnen sind.
const PROVIDER_TINTS = {
    codex: [0.31, 0.60, 0.96],
    claude: [0.85, 0.47, 0.34]
};

// Ab diesem Fuellstand wird das Bogenende zusaetzlich in Ampelfarbe markiert.
const WARN_THRESHOLD = 0.85;

// Claude-Live-Werte liefert claude-usage-tray (pipx): das Tool liest den
// OAuth-Token aus ~/.claude/.credentials.json und fragt die Anthropic-API
// direkt ab - damit zaehlt jeder Client (Code, Desktop, Copilot), nicht nur
// die Terminal-Statusline. "claude-usage --cli" schreibt das Ergebnis als
// JSON nach ~/.claude/usage-monitor-cache.json; das Applet startet den Abruf
// und liest anschliessend diesen Cache.
const CLAUDE_USAGE_BIN = "/.local/bin/claude-usage";
const CLAUDE_MONITOR_CACHE_PATH = "/.claude/usage-monitor-cache.json";

// Ab diesem Alter des Caches gilt der Live-Abruf als fehlgeschlagen und der
// Ring wird halbtransparent gezeichnet.
const CLAUDE_STALE_SECONDS = 600;

class CodexBarApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this.appletPath = metadata.path || (AppletManager.appletMeta[metadata.uuid] && AppletManager.appletMeta[metadata.uuid].path) || ".";
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menuManager.addMenu(this.menu);

        // Bei jedem Oeffnen die Helligkeit des Menuehintergrunds messen und
        // die Kontrastklasse setzen - so stimmen die Textfarben auf hellen
        // wie dunklen Themes, ohne dass etwas hartkodiert wird.
        this.menu.connect("open-state-changed", Lang.bind(this, function(menu, open) {
            if (open) {
                this._applyContrastClass();
            }
        }));

        this.refreshTimerId = 0;
        this.refreshing = false;
        this.lastUpdated = null;
        this.lastError = null;
        this.records = [];
        this.panelPercent = 0;
        this.panelGaugeMode = "loading";

        this.panelGauge = new St.DrawingArea({ style_class: "codexbar-panel-gauge" });
        this.panelGauge.set_size(PANEL_GAUGE_WIDTH, PANEL_GAUGE_HEIGHT);
        this.panelGauge.connect("repaint", Lang.bind(this, this._drawPanelGauge));
        this._layoutBin.set_child(this.panelGauge);
        this._layoutBin.show();

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("command-path", "commandPath", this._onSettingsChanged);
        this.settings.bind("provider", "provider", this._onSettingsChanged);
        this.settings.bind("refresh-interval", "refreshInterval", this._onSettingsChanged);

        this._setLoadingState();
        this._buildMenu();
        this._refresh();
        this._scheduleRefresh();
    }

    on_applet_clicked() {
        this._buildMenu();
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        this._clearRefreshTimer();
        this.settings.finalize();
    }

    // Liest die Hintergrundfarbe des Menues aus dem Theme-Knoten und haengt
    // codexbar-on-light oder codexbar-on-dark an den Container. Schlaegt die
    // Messung fehl (z. B. transparenter Hintergrund), bleibt die geerbte
    // Theme-Farbe als Fallback.
    _applyContrastClass() {
        let actor = this.menu.actor;
        if (!actor) {
            return;
        }

        let chosen = null;
        let targets = [actor, this.menu.box];

        for (let i = 0; i < targets.length; i++) {
            let target = targets[i];
            if (!target) {
                continue;
            }
            try {
                let bg = target.get_theme_node().get_background_color();
                if (bg && bg.alpha > 200) {
                    let luminance = 0.299 * bg.red + 0.587 * bg.green + 0.114 * bg.blue;
                    chosen = luminance > 140 ? "codexbar-on-light" : "codexbar-on-dark";
                    break;
                }
            } catch (e) {
                // naechstes Ziel probieren
            }
        }

        actor.remove_style_class_name("codexbar-on-light");
        actor.remove_style_class_name("codexbar-on-dark");
        if (chosen) {
            actor.add_style_class_name(chosen);
        }
    }

    // Baut das Menue um, ohne es dabei zu schliessen: Cinnamon's
    // PopupMenuManager schliesst ein offenes Menue, wenn das Schluessel-
    // fokussierte Item zerstoert wird (_onKeyFocusChanged). Genau das passiert
    // beim Klick auf "Refresh now": der Klick fokussiert das Item, der
    // Rebuild zerstoert es, der Manager schliesst. Deshalb den Fokus vor dem
    // Rebuild auf den Menue-Container ziehen - der bleibt bestehen.
    _rebuildMenu() {
        if (this.menu.isOpen) {
            this.menu.actor.can_focus = true;
            this.menu.actor.grab_key_focus();
        }
        this._buildMenu();
    }

    _onSettingsChanged() {
        this.commandPath = this.commandPath || DEFAULT_COMMAND;
        this.provider = this.provider || DEFAULT_PROVIDER;
        this.refreshInterval = Math.max(15, Number(this.refreshInterval || DEFAULT_REFRESH_SECONDS));
        this._applyIconPreference();
        this._clearRefreshTimer();
        this._refresh();
        this._scheduleRefresh();
    }

    _applyIconPreference() {
        this.hide_applet_icon();
    }

    _setLoadingState() {
        this._applyIconPreference();
        this._setPanelGauge(0, "loading");
        this.set_applet_tooltip("CodexBar: refreshing");
    }

    _setRecords(records) {
        this.records = records || [];
        this.lastUpdated = new Date();

        let rings = [];
        let tooltipParts = [];
        let errors = 0;

        for (let i = 0; i < this.records.length; i++) {
            let record = this.records[i];
            let name = record && record.provider ? record.provider : "unknown";
            let tint = PROVIDER_TINTS[name] || null;

            if (record && record.error) {
                errors += 1;
                rings.push({ percent: 100, mode: "error", tint: tint });
                tooltipParts.push(this._titleCase(name) + ": " + this._errorMessage(record.error));
                continue;
            }

            let rows = this._usageRows(record);
            rings.push({
                percent: this._gaugeLimitPercent(record),
                mode: record && record.stale ? "stale" : "normal",
                tint: tint
            });
            tooltipParts.push(this._tooltip(this._titleCase(name), rows, this._extraUsage(record)));
        }

        this.panelRings = rings;
        this.lastError = errors === this.records.length && this.records.length > 0
            ? this._errorMessage(this.records[0].error)
            : null;

        // panelPercent bleibt fuer den Einzelring-Fallback gesetzt.
        this.panelPercent = rings.length > 0 ? rings[0].percent : 0;
        this.panelGaugeMode = rings.length > 0 ? rings[0].mode : "loading";
        this.panelGauge.queue_repaint();

        this.set_applet_tooltip(tooltipParts.length > 0
            ? tooltipParts.join("\n\n")
            : "CodexBar: waiting for data");
        this._rebuildMenu();
    }

    _setErrorState(message) {
        this.lastUpdated = new Date();
        this.lastError = message || "Unknown CodexBar error";
        this.panelRings = [{ percent: 100, mode: "error", tint: null }];
        this._setPanelGauge(100, "error");
        this.set_applet_tooltip("CodexBar: " + this.lastError);
        this._rebuildMenu();
    }

    _setPanelGauge(percent, mode) {
        this.panelPercent = Math.max(0, Math.min(100, Number(percent || 0)));
        this.panelGaugeMode = mode || "normal";
        this.panelGauge.queue_repaint();
    }

    _drawPanelGauge(area) {
        let cr = area.get_context();
        let [width, height] = area.get_surface_size();
        let cx = width / 2;
        let cy = height - 2.5;
        let outerRadius = Math.min(width / 2 - 2, height - 3);

        cr.setLineCap(Cairo.LineCap.ROUND);

        let rings = this.panelRings || [];
        if (rings.length === 0) {
            rings = [{ percent: this.panelPercent, mode: this.panelGaugeMode, tint: null }];
        }

        // Aeusserer Ring zuerst, weiter innen liegende Ringe danach. Jeder Ring
        // bekommt einen eigenen Radius, damit sich die Boegen nicht ueberdecken.
        for (let i = 0; i < rings.length; i++) {
            let ring = rings[i];
            let radius = outerRadius - i * RING_SPACING;
            if (radius < 2) {
                break;
            }

            this._drawRing(cr, cx, cy, radius, ring);
        }

        cr.$dispose();
    }

    _drawRing(cr, cx, cy, radius, ring) {
        let start = Math.PI;
        let end = Math.PI * 2;
        let mode = ring.mode || "normal";
        let percent = mode === "loading" ? 0 : Math.max(0, Math.min(100, Number(ring.percent || 0)));
        let ratio = percent / 100;
        let activeEnd = start + (end - start) * ratio;

        cr.setLineWidth(RING_WIDTH);

        // Grundbogen neutral grau: die Providerfarbe soll allein vom Fuellbogen
        // kommen, sonst konkurrieren zwei Toene derselben Farbe miteinander.
        cr.arc(cx, cy, radius, start, end);
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.3);
        cr.stroke();

        if (mode === "error") {
            cr.setSourceRGBA(0.95, 0.22, 0.18, 1);
        } else if (mode === "loading") {
            cr.setSourceRGBA(0.45, 0.65, 1, 0.8);
        } else {
            // Der Fuellbogen traegt die Providerfarbe, nicht die Ampelfarbe:
            // sonst sehen beide Ringe im gruenen Bereich identisch aus und die
            // Zuordnung Codex/Claude geht verloren.
            let color = ring.tint || this._usageColor(ratio);
            cr.setSourceRGBA(color[0], color[1], color[2], mode === "stale" ? 0.5 : 1);
        }

        if (ratio > 0 || mode !== "normal") {
            cr.arc(cx, cy, radius, start, Math.max(start + 0.04, activeEnd));
            cr.stroke();
        }

        // Auslastungswarnung als kurze Markierung am Bogenende, damit die
        // Providerfarbe erhalten bleibt und hohe Werte trotzdem auffallen.
        if (mode === "normal" && ratio >= WARN_THRESHOLD) {
            let warn = this._usageColor(ratio);
            cr.setSourceRGBA(warn[0], warn[1], warn[2], 1);
            cr.arc(cx, cy, radius, Math.max(start, activeEnd - 0.28), activeEnd);
            cr.stroke();
        }
    }

    _usageColor(ratio) {
        if (ratio < 0.65) {
            return [0.29, 0.87, 0.45];
        }
        if (ratio < 0.85) {
            return [1.0, 0.72, 0.18];
        }
        return [0.96, 0.25, 0.20];
    }

    _scheduleRefresh() {
        this._clearRefreshTimer();
        this.refreshTimerId = Mainloop.timeout_add_seconds(this.refreshInterval || DEFAULT_REFRESH_SECONDS, Lang.bind(this, function() {
            this._refresh(false);
            return true;
        }));
    }

    _clearRefreshTimer() {
        if (this.refreshTimerId) {
            Mainloop.source_remove(this.refreshTimerId);
            this.refreshTimerId = 0;
        }
    }

    _selectedProviders() {
        let mode = this.provider || DEFAULT_PROVIDER;
        if (mode === "both") {
            // Claude zuerst: das 5h-Fenster kippt mehrmals taeglich und ist
            // damit der Wert, den man im Blick behalten muss. Codex laeuft
            // nur einmal pro Woche ab und kommt an zweiter Stelle.
            return ["claude", "codex"];
        }
        return [mode];
    }

    _refresh(manual) {
        if (this.refreshing) {
            if (manual && this.menu.isOpen) {
                this._rebuildMenu();
            }
            return;
        }

        this.refreshing = true;
        this.set_applet_tooltip("CodexBar: refreshing");
        if (this.menu.isOpen) {
            this._rebuildMenu();
        }

        let providers = this._selectedProviders();
        let collected = {};
        let pending = providers.length;

        // Beide Quellen laufen unabhaengig; erst wenn alle geantwortet haben,
        // wird einmal gerendert. Sonst wuerde der zweite Ring den ersten
        // ueberschreiben, sobald eine Quelle langsamer ist.
        let finish = Lang.bind(this, function() {
            pending -= 1;
            if (pending > 0) {
                return;
            }

            this.refreshing = false;

            let records = [];
            for (let i = 0; i < providers.length; i++) {
                let record = collected[providers[i]];
                if (record) {
                    records.push(record);
                }
            }

            this._setRecords(records);

            if (manual) {
                this._scheduleRefresh();
            }
        });

        for (let i = 0; i < providers.length; i++) {
            let name = providers[i];
            if (name === "claude") {
                this._readClaudeRecord(function(record) {
                    collected[name] = record;
                    finish();
                });
            } else {
                this._readCliRecord(name, function(record) {
                    collected[name] = record;
                    finish();
                });
            }
        }
    }

    _readCliRecord(providerName, done) {
        try {
            Util.spawnCommandLineAsyncIO(null, Lang.bind(this, function(stdout, stderr, exitCode) {
                let output = (stdout || "").trim();

                if (!output && stderr) {
                    done({ provider: providerName, error: { message: "CodexBar failed: " + stderr.trim() } });
                    return;
                }

                try {
                    let parsed = JSON.parse(output || "[]");
                    let list = Array.isArray(parsed) ? parsed : [parsed];
                    done(list.length > 0 ? list[0] : { provider: providerName, error: { message: "No data returned." } });
                } catch (e) {
                    done({ provider: providerName, error: { message: "Could not parse CodexBar JSON: " + e.message } });
                }
            }), {
                argv: [
                    this.commandPath || DEFAULT_COMMAND,
                    "usage",
                    "--format",
                    "json",
                    "--provider",
                    providerName
                ]
            });
        } catch (e) {
            done({ provider: providerName, error: { message: "Could not run CodexBar: " + e.message } });
        }
    }

    _readClaudeRecord(done) {
        // "claude-usage --cli" holt frische Werte von der Anthropic-OAuth-API
        // und schreibt sie in den Monitor-Cache. Die Textausgabe des Befehls
        // ignorieren wir; gelesen wird anschliessend die Cache-Datei. So
        // bekommt das Applet maschinenlesbares JSON statt formatierten Text.
        let bin = GLib.get_home_dir() + CLAUDE_USAGE_BIN;
        try {
            Util.spawnCommandLineAsyncIO(null, Lang.bind(this, function(stdout, stderr, exitCode) {
                let record = this._recordFromMonitorCache();

                // Ein alter Cache ist besser als keiner: bei API-Fehler zeigt
                // der Ring den letzten bekannten Stand, als stale markiert.
                if (!record && exitCode !== 0) {
                    record = {
                        provider: "claude",
                        error: { message: "claude-usage failed: " + ((stderr || "").trim() || "exit " + exitCode) }
                    };
                }
                if (!record) {
                    record = {
                        provider: "claude",
                        error: { message: "No Claude usage data. Run 'claude-usage --cli' once in a terminal." }
                    };
                }
                done(record);
            }), {
                argv: [bin, "--cli"]
            });
        } catch (e) {
            let fallback = this._recordFromMonitorCache();
            done(fallback || { provider: "claude", error: { message: "Could not run claude-usage: " + e.message } });
        }
    }

    _recordFromMonitorCache() {
        // Cache-Format von claude-usage-tray: { ts, windows: [{ name,
        // label, utilization, resets_at }], ... }. In die Struktur bringen,
        // die _modelFromRecords erwartet: usage.primary = 5h-, secondary =
        // 7d-Fenster.
        try {
            let path = GLib.get_home_dir() + CLAUDE_MONITOR_CACHE_PATH;
            let file = Gio.File.new_for_path(path);

            if (!file.query_exists(null)) {
                return null;
            }

            let [ok, contents] = file.load_contents(null);
            if (!ok) {
                return null;
            }

            let text = contents instanceof Uint8Array
                ? imports.byteArray.toString(contents)
                : String(contents);

            let cache = JSON.parse(text);

            let windows = {};
            let list = cache.windows || [];
            for (let i = 0; i < list.length; i++) {
                windows[list[i].name] = list[i];
            }

            // Zusaetzliche API-Fenster (z. B. 7-Day Opus/Sonnet/Cowork/OAuth
            // Apps) werden generisch durchgereicht: Sobald Anthropic sie
            // liefert, tauchen sie als eigene Zeilen im Popup auf, ohne dass
            // hier etwas nachgebaut werden muss.
            let extras = [];
            for (let i = 0; i < list.length; i++) {
                let w = list[i];
                if (w.name === "five_hour" || w.name === "seven_day") {
                    continue;
                }
                if (w.utilization === null || w.utilization === undefined) {
                    continue;
                }
                extras.push({
                    title: w.label || w.name,
                    usedPercent: w.utilization,
                    resetsAt: w.resets_at || null
                });
            }

            let toWindow = function(window) {
                if (!window || window.utilization === null || window.utilization === undefined) {
                    return null;
                }

                let result = { usedPercent: window.utilization };
                if (window.resets_at) {
                    result.resetsAt = window.resets_at;
                }
                return result;
            };

            let age = cache.ts
                ? Math.floor(Date.now() / 1000 - cache.ts)
                : null;

            let stale = age === null || age > CLAUDE_STALE_SECONDS;

            // Alter offen ausweisen: stale heisst hier, der Live-Abruf ist
            // fehlgeschlagen und der Ring zeigt den letzten bekannten Stand.
            let source = "oauth api";
            if (stale && age !== null) {
                source = "oauth api · " + this._formatAge(age) + " alt";
            }

            return {
                provider: "claude",
                stale: stale,
                ageSeconds: age,
                source: source,
                usage: {
                    primary: toWindow(windows.five_hour),
                    secondary: toWindow(windows.seven_day),
                    extraRateWindows: extras,
                    updatedAt: cache.ts
                        ? new Date(cache.ts * 1000).toISOString()
                        : null
                }
            };
        } catch (e) {
            return { provider: "claude", error: { message: "Could not parse Claude monitor cache: " + e.message } };
        }
    }

    _formatAge(seconds) {
        if (seconds < 60) {
            return seconds + "s";
        }
        if (seconds < 3600) {
            return Math.floor(seconds / 60) + "min";
        }
        let hours = Math.floor(seconds / 3600);
        if (hours < 24) {
            return hours + "h";
        }
        return Math.floor(hours / 24) + "d";
    }

    _buildMenu() {
        this.menu.removeAll();

        if (this.records.length === 0) {
            this._addHeader(this._modelFromRecords([]));
            this._addMessage("No usage data returned yet.", "codexbar-muted");
            this._addSectionSeparator();
            this._addActions();
            return;
        }

        // Pro Provider ein eigener Block, damit beide Ringe im Panel eine
        // erklaerende Entsprechung im Menue haben.
        for (let i = 0; i < this.records.length; i++) {
            if (i > 0) {
                this._addSectionSeparator();
            }

            let model = this._modelFromRecords([this.records[i]]);
            this._addHeader(model, this._ringColorFor(this.records[i]));

            if (model.error) {
                this._addMessage(model.error, "codexbar-error");
            } else if (model.rows.length === 0) {
                this._addMessage("No usage data returned yet.", "codexbar-muted");
            } else {
                for (let r = 0; r < model.rows.length; r++) {
                    this._addUsageRow(model.rows[r]);
                }
            }

            if (model.extraUsage) {
                this._addUsageRow(model.extraUsage);
            }

            if (model.costLines.length > 0) {
                this._addCostSection(model.costLines);
            }

            // Veraltete Claude-Werte klar benennen: stale heisst jetzt, der
            // Live-Abruf ueber claude-usage ist fehlgeschlagen (API oder Netz
            // nicht erreichbar) - gezeigt wird der letzte bekannte Stand.
            let record = this.records[i];
            if (record && record.provider === "claude" && record.stale && !record.error) {
                this._addMessage(
                    "Wert ist " + this._formatAge(record.ageSeconds || 0)
                        + " alt. Der Live-Abruf ueber claude-usage ist fehlgeschlagen;"
                        + " gezeigt wird der letzte bekannte Stand.",
                    "codexbar-muted");
            }
        }

        this._addSectionSeparator();
        this._addActions();
    }

    _ringColorFor(record) {
        let name = record && record.provider ? record.provider : null;
        let tint = name ? PROVIDER_TINTS[name] : null;
        if (!tint) {
            return null;
        }

        return "rgb(" + Math.round(tint[0] * 255) + ","
            + Math.round(tint[1] * 255) + ","
            + Math.round(tint[2] * 255) + ")";
    }

    _addHeader(model, ringColor) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: "codexbar-popup-item" });
        let box = new St.BoxLayout({ vertical: true, style_class: "codexbar-card" });
        let top = new St.BoxLayout({ vertical: false });
        let title = new St.Label({ text: model.title, style_class: "codexbar-title" });
        let right = new St.Label({ text: model.headerRight, style_class: "codexbar-muted" });

        // Farbpunkt in der Ringfarbe des Providers - stellt die Verbindung
        // zwischen Panel-Ring und Menue-Block her.
        if (ringColor) {
            let dot = new St.Bin({ style_class: "codexbar-dot" });
            dot.set_style("background-color: " + ringColor + ";");
            top.add_actor(dot);
        }

        title.x_expand = true;
        top.add_actor(title);
        top.add_actor(right);
        box.add_actor(top);
        box.add_actor(new St.Label({ text: model.subtitle, style_class: "codexbar-subtitle" }));
        item.addActor(box, { span: -1, expand: true });
        this.menu.addMenuItem(item);
    }

    _addUsageRow(row) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: "codexbar-popup-item" });
        let box = new St.BoxLayout({ vertical: true, style_class: "codexbar-row" });
        let titleLine = new St.BoxLayout({ vertical: false });
        let title = new St.Label({ text: row.title, style_class: "codexbar-row-title" });
        let reset = new St.Label({ text: row.right || "", style_class: "codexbar-reset" });

        title.x_expand = true;
        titleLine.add_actor(title);
        titleLine.add_actor(reset);
        box.add_actor(titleLine);
        box.add_actor(this._progressBar(row.percent));

        let detailLine = new St.BoxLayout({ vertical: false });
        let detail = new St.Label({ text: row.detail || "", style_class: "codexbar-detail" });
        detail.x_expand = true;
        detailLine.add_actor(detail);
        if (row.trailing) {
            detailLine.add_actor(new St.Label({ text: row.trailing, style_class: "codexbar-muted" }));
        }
        box.add_actor(detailLine);

        if (row.note) {
            let note = new St.Label({ text: row.note, style_class: "codexbar-muted" });
            note.clutter_text.line_wrap = true;
            box.add_actor(note);
        }

        item.addActor(box, { span: -1, expand: true });
        this.menu.addMenuItem(item);
    }

    _progressBar(percent) {
        let numericPercent = Number(percent || 0);
        let clamped = Math.max(0, Math.min(100, numericPercent));
        if (Math.round(clamped) === 100) {
            clamped = 100;
        }

        let track = new St.BoxLayout({ style_class: "codexbar-progress-track" });
        let fill = new St.Bin({ style_class: "codexbar-progress-fill" });
        let updateFillWidth = function () {
            let trackWidth = track.get_width();
            let fillWidth = Math.round((trackWidth * clamped) / 100);

            fill.set_width(clamped > 0 ? Math.max(3, fillWidth) : 0);
        };

        track.x_expand = true;
        track.add_actor(fill);
        track.connect("notify::allocation", updateFillWidth);
        return track;
    }

    _addCostSection(lines) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: "codexbar-popup-item" });
        let box = new St.BoxLayout({ vertical: true, style_class: "codexbar-row" });
        box.add_actor(new St.Label({ text: "Cost", style_class: "codexbar-row-title" }));

        for (let i = 0; i < lines.length; i++) {
            box.add_actor(new St.Label({ text: lines[i], style_class: "codexbar-detail" }));
        }

        item.addActor(box, { span: -1, expand: true });
        this.menu.addMenuItem(item);
    }

    _addActions() {
        let refreshItem = new PopupMenu.PopupIconMenuItem("Refresh now", "view-refresh", St.IconType.SYMBOLIC);
        // Cinnamon schliesst das Menue bei jedem activate, es sei denn, das
        // Item meldet keepMenu=true (so machen es die Submenue-Klassen).
        // Beim Refresh soll das Menue offen bleiben, damit das Ergebnis
        // direkt sichtbar wird - _setRecords baut es mit neuen Werten um.
        refreshItem.activate = function(event) {
            PopupMenu.PopupBaseMenuItem.prototype.activate.call(this, event, true);
        };
        refreshItem.label.add_style_class_name("codexbar-action");
        refreshItem.connect("activate", Lang.bind(this, this._onRefreshClicked));
        this.menu.addMenuItem(refreshItem);

        this._addMessage("Updated: " + this._formatUpdated(this.lastUpdated), "codexbar-muted");
    }

    _onRefreshClicked() {
        this._refresh(true);
    }

    _addMessage(text, styleClass) {
        let item = new PopupMenu.PopupMenuItem(text, { reactive: false });
        item.label.add_style_class_name(styleClass);
        item.label.clutter_text.line_wrap = true;
        this.menu.addMenuItem(item);
    }

    _addSectionSeparator() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _modelFromRecords(records) {
        let record = this._firstRecord(records);
        let provider = record && record.provider ? this._titleCase(record.provider) : "Codex";
        let source = record && record.source ? record.source : "auto";

        if (!record) {
            return {
                title: "Codex",
                subtitle: "Waiting for data",
                headerRight: "",
                gaugePercent: 0,
                tooltip: "CodexBar: waiting for data",
                error: null,
                rows: [],
                extraUsage: null,
                costLines: []
            };
        }

        if (record.error) {
            let message = this._errorMessage(record.error);
            return {
                title: provider,
                subtitle: source,
                headerRight: "!",
                gaugePercent: 100,
                tooltip: "CodexBar: " + message,
                error: message,
                rows: [],
                extraUsage: null,
                costLines: []
            };
        }

        let gaugePercent = this._gaugeLimitPercent(record);
        let rows = this._usageRows(record);
        let extraUsage = this._extraUsage(record);
        let costLines = this._costLines(record);

        return {
            title: provider,
            subtitle: this.refreshing ? "Refreshing..." : "Updated " + this._relativeUpdated(this.lastUpdated),
            headerRight: this.refreshing ? "" : source,
            gaugePercent: gaugePercent,
            tooltip: this._tooltip(provider, rows, extraUsage),
            error: null,
            rows: rows,
            extraUsage: extraUsage,
            costLines: costLines
        };
    }

    _usageRows(record) {
        let rows = [];
        let primary = this._limitWindow(record, "primary");
        let secondary = this._limitWindow(record, "secondary");

        if (primary) {
            rows.push(this._limitRow("Session", primary));
        }

        if (secondary) {
            rows.push(this._limitRow("Weekly", secondary));
        }

        // Zusaetzliche Fenster (aktuell nur von der Claude-OAuth-API geliefert,
        // z. B. 7-Day Opus/Cowork) als normale Limit-Zeilen darstellen.
        let windows = this._getPath(record, ["usage", "extraRateWindows"]) || [];
        for (let i = 0; i < windows.length; i++) {
            rows.push(this._limitRow(windows[i].title || "Usage", windows[i]));
        }

        let reviewRemaining = this._deepFind(record, "codeReviewRemaining");
        if (reviewRemaining !== null && reviewRemaining !== undefined) {
            rows.push({
                title: "Code review",
                percent: 0,
                detail: this._displayValue(reviewRemaining) + " remaining",
                right: "",
                note: ""
            });
        }

        return rows;
    }

    _gaugeLimitPercent(record) {
        let primary = this._limitWindow(record, "primary");
        let percent = primary ? this._firstNumber(primary, ["usedPercent", "percentUsed", "usagePercent", "used_percent"]) : null;
        if (percent !== null) {
            return percent;
        }

        let secondary = this._limitWindow(record, "secondary");
        percent = secondary ? this._firstNumber(secondary, ["usedPercent", "percentUsed", "usagePercent", "used_percent"]) : null;
        return percent === null ? 0 : percent;
    }

    _limitWindow(record, name) {
        let paths = [
            ["usage", name],
            ["usage", "limits", name],
            ["usage", "rateLimits", name],
            ["usage", "rate_limits", name],
            ["limits", name],
            ["rateLimits", name],
            ["rate_limits", name],
            [name]
        ];

        for (let i = 0; i < paths.length; i++) {
            let value = this._getPath(record, paths[i]);
            if (value) {
                return value;
            }
        }

        return null;
    }

    _limitRow(title, value) {
        let percent = this._firstNumber(value, ["usedPercent", "percentUsed", "usagePercent", "used_percent"]);
        let resetDescription = this._firstValue(value, ["resetDescription"]);
        let reset = this._firstValue(value, ["resetsAt", "resetAt", "reset_at"]);
        let right = "";

        if (resetDescription) {
            right = "Resets " + resetDescription;
        } else if (reset) {
            right = "Resets " + this._relativeTime(reset);
        }

        return {
            title: title,
            percent: percent || 0,
            detail: this._percentText(percent),
            right: right,
            note: ""
        };
    }

    _paceRow(title, value) {
        let percent = this._firstNumber(value, ["usedPercent", "percentUsed", "usagePercent", "used_percent"]);
        let reset = this._firstValue(value, ["resetsAt", "resetAt", "reset_at"]);
        let delta = this._firstNumber(value, ["deltaPercent", "delta_percent"]);
        let stage = this._firstValue(value, ["stage"]);
        let summary = this._firstValue(value, ["summary"]);
        let detail = this._percentText(percent);

        return {
            title: title,
            percent: percent || 0,
            detail: detail,
            right: reset ? "Resets " + this._relativeTime(reset) : "",
            note: summary || this._paceNote(stage, delta)
        };
    }

    _extraUsage(record) {
        let credits = this._getPath(record, ["credits"]);
        if (!credits) {
            return null;
        }

        let remaining = this._firstValue(credits, ["remaining", "available"]);
        let limit = this._firstValue(credits, ["limit", "monthlyLimit", "included"]);
        let used = this._firstValue(credits, ["used"]);
        let percent = this._firstNumber(credits, ["usedPercent", "percentUsed"]);

        if (remaining === null && limit === null && used === null && percent === null) {
            return null;
        }

        let detail = "Remaining: " + this._displayValue(remaining);
        if (used !== null || limit !== null) {
            detail = "This month: " + this._displayValue(used || 0) + " / " + this._displayValue(limit || remaining);
        }

        return {
            title: "Extra usage",
            percent: percent || 0,
            detail: detail,
            trailing: this._percentText(percent || 0),
            right: "",
            note: ""
        };
    }

    _costLines(record) {
        let lines = [];
        let cost = this._getPath(record, ["usage", "cost"]) || this._getPath(record, ["cost"]);

        if (!cost) {
            return lines;
        }

        let today = this._firstValue(cost, ["today", "todayCost"]);
        let last30 = this._firstValue(cost, ["last30Days", "last30DaysCost", "month"]);
        let tokensToday = this._firstValue(cost, ["todayTokens"]);
        let tokens30 = this._firstValue(cost, ["last30DaysTokens"]);

        if (today !== null) {
            lines.push("Today: " + this._displayMoney(today) + (tokensToday !== null ? " · " + this._displayValue(tokensToday) + " tokens" : ""));
        }

        if (last30 !== null) {
            lines.push("Last 30 days: " + this._displayMoney(last30) + (tokens30 !== null ? " · " + this._displayValue(tokens30) + " tokens" : ""));
        }

        return lines;
    }

    _firstRecord(records) {
        if (!records || records.length === 0) {
            return null;
        }

        for (let i = 0; i < records.length; i++) {
            if (records[i] && !records[i].error) {
                return records[i];
            }
        }

        return records[0];
    }

    _firstValue(object, keys) {
        if (!object) {
            return null;
        }

        for (let i = 0; i < keys.length; i++) {
            if (Object.prototype.hasOwnProperty.call(object, keys[i]) && object[keys[i]] !== null && object[keys[i]] !== undefined) {
                return object[keys[i]];
            }
        }

        return null;
    }

    _firstNumber(object, keys) {
        let value = this._firstValue(object, keys);
        if (value === null) {
            return null;
        }

        let numberValue = Number(value);
        return isNaN(numberValue) ? null : numberValue;
    }

    _getPath(object, path) {
        let cursor = object;
        for (let i = 0; i < path.length; i++) {
            if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, path[i])) {
                return null;
            }
            cursor = cursor[path[i]];
        }

        return cursor;
    }

    _deepFind(value, key) {
        if (!value || typeof value !== "object") {
            return null;
        }

        if (Object.prototype.hasOwnProperty.call(value, key)) {
            return value[key];
        }

        let keys = Object.keys(value);
        for (let i = 0; i < keys.length; i++) {
            let found = this._deepFind(value[keys[i]], key);
            if (found !== null && found !== undefined) {
                return found;
            }
        }

        return null;
    }

    _tooltip(provider, rows, extraUsage) {
        let parts = [provider];
        for (let i = 0; i < rows.length; i++) {
            // right enthaelt die Reset-Angabe ("Resets ..."); ohne sie sagt der
            // Tooltip nur den Prozentwert, ohne Bezug wann das Fenster kippt.
            let line = rows[i].title + ": " + rows[i].detail;
            if (rows[i].right) {
                line += " · " + rows[i].right;
            }
            parts.push(line);
        }
        if (extraUsage) {
            parts.push(extraUsage.title + ": " + extraUsage.detail);
        }
        return parts.join("\n");
    }

    _errorMessage(error) {
        if (!error) {
            return "Unknown error";
        }
        if (typeof error === "string") {
            return error;
        }
        return error.message || JSON.stringify(error);
    }

    _paceNote(stage, delta) {
        let parts = [];
        if (stage) {
            parts.push("Pace: " + this._titleCase(stage));
        }
        if (delta !== null && delta !== undefined) {
            parts.push((delta > 0 ? "+" : "") + Math.round(delta) + "%");
        }
        return parts.join(" · ");
    }

    _percentText(percent) {
        return Math.round(Number(percent || 0)) + "% used";
    }

    _displayValue(value) {
        if (value === null || value === undefined || value === "") {
            return "0";
        }
        if (typeof value === "number") {
            return value >= 1000 ? Math.round(value).toLocaleString() : String(value);
        }
        return String(value);
    }

    _displayMoney(value) {
        let numberValue = Number(value);
        if (isNaN(numberValue)) {
            return String(value);
        }
        return "$ " + numberValue.toFixed(2);
    }

    _titleCase(value) {
        let text = String(value || "");
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    _relativeUpdated(date) {
        if (!date) {
            return "soon";
        }

        let seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 45) {
            return "just now";
        }
        if (seconds < 3600) {
            return Math.floor(seconds / 60) + "m ago";
        }
        return date.toLocaleTimeString();
    }

    _formatUpdated(date) {
        return date ? date.toLocaleTimeString() : "never";
    }

    _relativeTime(value) {
        let date = new Date(value);
        if (isNaN(date.getTime())) {
            return String(value);
        }

        let minutes = Math.max(0, Math.floor((date.getTime() - Date.now()) / 60000));
        let days = Math.floor(minutes / 1440);
        let hours = Math.floor((minutes % 1440) / 60);
        let mins = minutes % 60;

        if (days > 0) {
            return "in " + days + "d " + hours + "h";
        }
        if (hours > 0) {
            return "in " + hours + "h " + mins + "m";
        }
        return "in " + mins + "m";
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new CodexBarApplet(metadata, orientation, panelHeight, instanceId);
}
