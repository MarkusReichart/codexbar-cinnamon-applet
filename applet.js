const Applet = imports.ui.applet;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Util = imports.misc.util;
const AppletManager = imports.ui.appletManager;
const Cairo = imports.cairo;

const DEFAULT_COMMAND = "/opt/apps/codexbar/codexbar";
const DEFAULT_PROVIDER = "both";
const DEFAULT_REFRESH_SECONDS = 60;
const TRANSIENT_FAILURE_LIMIT = 3;
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

// Beide Provider kommen ueber die CodexBar-CLI. Fuer Claude muss die Quelle
// explizit "oauth" sein: die Auto-Pipeline scheitert unter Linux (Web-Cookies
// sind macOS-only, der PTY-Fallback liefert bei manchen Accounts nur einen
// Subscription-Hinweis ohne Quota-Zahlen). Der OAuth-Pfad liest
// ~/.claude/.credentials.json selbst und fragt api.anthropic.com direkt.

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
        this.providerFailureCounts = {};
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
            // Warnfarbe fuer den Panel-Ring bei hoher Auslastung:
            // Festrot war auf Claudes Orange unsichtbar. Kontrastfarbe
            // (Schwarz auf hellen, Weiss auf dunklen Themes) funktioniert
            // fuer beide Provider. Bei Messfehler Fallback Rot.
            this._warnRGB = chosen === "codexbar-on-light" ? [0, 0, 0] : [1, 1, 1];
            this.panelGauge.queue_repaint();
        } else {
            this._warnRGB = null;
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

            if (record && record.waiting) {
                rings.push({ percent: 0, mode: "loading", tint: tint });
                tooltipParts.push(this._titleCase(name) + ": waiting for data");
                continue;
            }

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
            // Bei hoher Auslastung (>= 85%) der gesamte Fuellbogen in der
            // Warnfarbe statt der Providerfarbe - einheitlicher "Blackout"-
            // Effekt, statt einer kurzen End-Markierung die auf Orange
            // unsichtbar war. Die Warnfarbe kommt aus der Theme-Messung
            // (Schwarz auf hellen, Weiss auf dunklen Themes).
            let color;
            if (ratio >= WARN_THRESHOLD) {
                color = this._warnRGB || [0.96, 0.25, 0.20];
            } else {
                color = ring.tint || this._usageColor(ratio);
            }
            cr.setSourceRGBA(color[0], color[1], color[2], mode === "stale" ? 0.5 : 1);
        }

        if (ratio > 0 || mode !== "normal") {
            cr.arc(cx, cy, radius, start, Math.max(start + 0.04, activeEnd));
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
                    records.push(this._normalizeProviderRecord(providers[i], record));
                }
            }

            this._setRecords(records);

            if (manual) {
                this._scheduleRefresh();
            }
        });

        for (let i = 0; i < providers.length; i++) {
            let name = providers[i];
            this._readCliRecord(name, function(record) {
                collected[name] = record;
                finish();
            });
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
                argv: this._usageArgv(providerName)
            });
        } catch (e) {
            done({ provider: providerName, error: { message: "Could not run CodexBar: " + e.message } });
        }
    }

    // Direkt nach Start oder Resume kann der erste OAuth-Aufruf scheitern,
    // obwohl der vorhandene Refresh-Token den naechsten Aufruf wieder
    // ermoeglicht. Solche Einzelmeldungen sind noch kein belastbarer Login-
    // Bedarf. Erst nach drei aufeinanderfolgenden Fehlern wird die originale
    // CLI-Meldung angezeigt; ein erfolgreicher Abruf setzt den Zaehler zurueck.
    _normalizeProviderRecord(providerName, record) {
        if (!record || !record.error) {
            this.providerFailureCounts[providerName] = 0;
            return record;
        }

        let failures = Number(this.providerFailureCounts[providerName] || 0) + 1;
        this.providerFailureCounts[providerName] = failures;

        if (failures < TRANSIENT_FAILURE_LIMIT) {
            return {
                provider: providerName,
                source: providerName === "claude" ? "oauth" : "auto",
                waiting: true
            };
        }

        return record;
    }

    _usageArgv(providerName) {
        let argv = [
            this.commandPath || DEFAULT_COMMAND,
            "usage",
            "--format",
            "json",
            "--provider",
            providerName
        ];

        // Claude: Auto-Pipeline scheitert unter Linux (Web-Cookies sind
        // macOS-only, PTY-Fallback ohne Quota-Zahlen) - explizit OAuth,
        // liest ~/.claude/.credentials.json und fragt die API direkt.
        if (providerName === "claude") {
            argv.push("--source", "oauth");
        }

        return argv;
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
            } else if (model.waiting) {
                this._addMessage("Please wait — no data available right now.", "codexbar-muted");
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
                waiting: true,
                rows: [],
                extraUsage: null,
                costLines: []
            };
        }

        if (record.waiting) {
            return {
                title: provider,
                subtitle: "Waiting for data",
                headerRight: "",
                gaugePercent: 0,
                tooltip: "CodexBar: waiting for data",
                error: null,
                waiting: true,
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
                waiting: false,
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
            waiting: false,
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
            rows.push(this._withPace(this._limitRow("Session", primary), this._getPath(record, ["pace", "primary"])));
        }

        if (secondary) {
            rows.push(this._withPace(this._limitRow("Weekly", secondary), this._getPath(record, ["pace", "secondary"])));
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

    // Pace-Angabe der CLI als kompakte Einzeiler-Notiz unter der Limit-Zeile.
    // Die rohe Summary ("65% in reserve | Expected 67% used | Lasts until
    // reset") ist fuer das 280px-Popup zu lang und bricht mitten in Phrasen
    // um - deshalb kurz: "Pace: 65% Reserve · reicht bis Reset" bzw.
    // "Pace: 5% Defizit · leer in 2d 20h". Schlaegt das Parsen fehl,
    // bleibt die Langfassung.
    _withPace(row, pace) {
        if (!pace) {
            return row;
        }

        let summary = String(pace.summary || "");
        let amount = /(\d+)% in (reserve|deficit)/i.exec(summary);
        let note = null;

        if (amount) {
            let amountText = amount[1] + "% " + (amount[2].toLowerCase() === "reserve" ? "Reserve" : "Defizit");
            let outlook;

            if (pace.willLastToReset) {
                outlook = "reicht bis Reset";
            } else {
                // Die Restlaufzeit ("Runs out in 2d 18h") steckt nur in der
                // Summary, nicht als eigenes Feld.
                let runsOut = /Runs out in (.+)$/i.exec(summary);
                outlook = runsOut ? "leer in " + runsOut[1].trim() : "reicht nicht bis Reset";
            }

            note = "Pace: " + amountText + " · " + outlook;
        } else if (summary) {
            note = summary;
        } else {
            note = this._paceNote(pace.stage, pace.deltaPercent);
        }

        if (note) {
            row.note = note;
        }
        return row;
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
            right = this._resetLabel(reset);
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
            right: reset ? this._resetLabel(reset) : "",
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

    _resetLabel(reset) {
        // Reset-Zeitpunkt in der Vergangenheit heisst: die gezeigten Prozente
        // gehoeren zu einem bereits geschlossenen Fenster (z. B. Cache von
        // gestern nach dem Booten). "Resets in 0m" waere hier irrefuehrend.
        let date = new Date(reset);
        if (isNaN(date.getTime())) {
            return "Resets " + String(reset);
        }
        if (date.getTime() <= Date.now()) {
            return "Reset abgelaufen";
        }
        return "Resets " + this._relativeTime(reset);
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
