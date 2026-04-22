const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;
const Meta = imports.gi.Meta;
const Settings = imports.ui.settings;
const SignalManager = imports.misc.signalManager;
const St = imports.gi.St;

const { DefaultColors } = require('./drawing');
const { GridEditor } = require('./grid-editor');
const { LayoutIO } = require('./io-utils');
const { LayoutNode } = require('./node_tree');
const { WindowSnapper } = require('./window-snapper');

// a hardcoded layout for 2x2 layout as default
const LayoutOf2x2 = new LayoutNode(0, [
    new LayoutNode(0.5, [
        new LayoutNode(-0.5), new LayoutNode(0)
    ]),
    new LayoutNode(0, [
        new LayoutNode(-0.5), new LayoutNode(0)
    ])
]);

const LayoutOf3x2 = new LayoutNode(0, [
    new LayoutNode(1 / 3, [
        new LayoutNode(-0.5), new LayoutNode(0)
    ]),
    new LayoutNode(2 / 3, [
        new LayoutNode(-0.5), new LayoutNode(0)
    ]),
    new LayoutNode(0, [
        new LayoutNode(-0.5), new LayoutNode(0)
    ])
]);

const LayoutOf3x3 = new LayoutNode(0, [
    new LayoutNode(1 / 3, [
        new LayoutNode(-1 / 3), new LayoutNode(-2 / 3), new LayoutNode(0)
    ]),
    new LayoutNode(2 / 3, [
        new LayoutNode(-1 / 3), new LayoutNode(-2 / 3), new LayoutNode(0)
    ]),
    new LayoutNode(0, [
        new LayoutNode(-1 / 3), new LayoutNode(-2 / 3), new LayoutNode(0)
    ])
]);

const LayoutOf2x3 = new LayoutNode(0, [
    new LayoutNode(0.5, [
        new LayoutNode(-1 / 3), new LayoutNode(-2 / 3), new LayoutNode(0)
    ]),
    new LayoutNode(0, [
        new LayoutNode(-1 / 3), new LayoutNode(-2 / 3), new LayoutNode(0)
    ])
]);

function getFocusedDisplay() {
    let focusWindow = global.display.focus_window;
    if (!focusWindow) {
        global.logError('No focused window');
        return;
    }

    // Get the display index instead of monitor
    return focusWindow.get_monitor();
}

function mapModifierSettingToModifierType(modifierSetting) {
    switch(modifierSetting) {
        case 'CTRL':
            return [Clutter.ModifierType.CONTROL_MASK];
        case 'ALT':
            return [Clutter.ModifierType.MOD1_MASK, Clutter.ModifierType.MOD5_MASK];
        case 'SUPER':
            return [Clutter.ModifierType.SUPER_MASK, Clutter.ModifierType.MOD4_MASK];
        case 'SHIFT':
            return [Clutter.ModifierType.SHIFT_MASK];
        default:
            return [];
    }
}

// The application class is only constructed once and is the main entry
// of the extension.
class Application {
    // the active grid editor
    #gridEditor = null;

    // the active window snappers for each monitor
    #windowSnappers = [];

    // ----- sticky-snap / restart-grab state (valid only during an active MOVING grab) -----
    // The MetaWindow currently being dragged; kept across restart-grab cycles.
    #currentDragWindow = null;
    // GLib idle source id for a pending restart (0 = none).
    #pendingRestartId = 0;
    // Number of restarts for the current drag; safety cap against runaway loops.
    #restartCount = 0;
    // Clutter event filter id watching for Escape during the drag (0 = none).
    #dragKeyFilterId = 0;
    // Whether the current drag was cancelled via Escape (skip finalize on end).
    #dragCancelled = false;

    // Hard cap on restart-grab attempts within a single drag — if we ever
    // exceed this, something is wrong and we give up rather than loop.
    static MAX_RESTARTS_PER_DRAG = 100;

    #layoutIO;

    // the layout trees for each display
    #layouts = {};

    // the layout trees for each preset
    #presets = null;

    #signals = new SignalManager.SignalManager(null);

    #settings;

    #colors = DefaultColors;

    constructor(uuid) {
        this.#layoutIO = new LayoutIO(uuid);
        this.#connectWindowGrabs();

        this.#settings = new Settings.ExtensionSettings(this, uuid);
        this.#settings.bindProperty(Settings.BindingDirection.IN, 'hotkey', 'hotkey', this.#enableHotkey);

        this.#loadThemeColors();
        this.#enableHotkey();
    }

    destroy() {
        this.#disableHotkey();
        this.#signals.disconnectAllSignals();
        this.#signals = null;

        if (this.#gridEditor) {
            this.#gridEditor.destroy();
            this.#gridEditor = null;
        }

        // Destroy all window snappers
        for (let snapper of this.#windowSnappers) {
            snapper.destroy();
        }
        this.#windowSnappers = [];

        // Tear down any drag-lifetime resources that may still be live
        // (e.g. if Cinnamon disables the extension mid-drag).
        if (this.#pendingRestartId) {
            GLib.source_remove(this.#pendingRestartId);
            this.#pendingRestartId = 0;
        }
        this.#removeEscapeFilter();
        this.#currentDragWindow = null;
        this.#dragCancelled = false;
    }

    #loadThemeColors() {
        // hidden element to fetch the styling
        let stylingActor = new St.DrawingArea({
            style_class: 'tile-preview tile-hud',
            visible: false
        });
        global.stage.add_actor(stylingActor);

        let bgColor = stylingActor.get_theme_node().get_background_color();
        if (bgColor) {
            this.#colors.background = {
                r: bgColor.red / 255,
                g: bgColor.green / 255,
                b: bgColor.blue / 255,
                a: bgColor.alpha / 255
            };
        }

        let borderColor = stylingActor.get_theme_node().get_border_color(St.Side.TOP);
        if (borderColor) {
            this.#colors.border = {
                r: borderColor.red / 128,
                g: borderColor.green / 128,
                b: borderColor.blue / 128,
                a: borderColor.alpha / 128
            };
        }

        // add the snap style class to get the highlighted colors
        stylingActor.add_style_class_name('snap');

        let highlightColor = stylingActor.get_theme_node().get_background_color();
        if (highlightColor) {
            this.#colors.highlight = {
                r: highlightColor.red / 255,
                g: highlightColor.green / 255,
                b: highlightColor.blue / 255,
                a: highlightColor.alpha / 255
            };
        }

        stylingActor.remove_style_class_name('snap');

        global.stage.remove_actor(stylingActor);
    }

    #disableHotkey() {
        Main.keybindingManager.removeHotKey('fancytiles');
    }

    #enableHotkey() {
        this.#disableHotkey();
        Main.keybindingManager.addHotKey('fancytiles', this.#settings.settingsData.hotkey.value, this.#toggleEditor.bind(this));
    }

    #saveLayouts() {
        for (let key in this.#layouts) {
            this.#layoutIO.saveLayoutForDisplay(key, this.#layouts[key]);
        }
        // save user presets
        for (let i = 0; i < 4; i++) {
            this.#layoutIO.saveLayoutForPreset(i, this.#presets[i]);
        }
    }

    #toggleEditor() {
        if (this.#gridEditor) {
            this.#closeEditor();
        } else {
            this.#openEditor();
        }
    }

    #loadPresets() {
        // load all user presets
        let userPresets = [];
        for (let i = 0; i < 4; i++) {
            const preset = this.#layoutIO.loadLayoutForPreset(i) || new LayoutNode(0);
            userPresets.push(preset);
        }

        // load the system preset
        this.#presets = [
            ...userPresets,
            LayoutOf2x2.clone(),
            LayoutOf3x2.clone(),
            LayoutOf2x3.clone(),
            LayoutOf3x3.clone()
        ];
    }

    #openEditor() {
        const displayIdx = getFocusedDisplay();
        if (typeof displayIdx !== 'number') {
            global.logError('No focused display');
            return;
        }

        let layout = this.#readOrCreateLayoutForDisplay(displayIdx);

        if (!this.#presets || this.#presets.length === 0) {
            this.#loadPresets();
        }

        const showGuideLines = this.#settings.settingsData.showGuideLines.value;

        this.#gridEditor = new GridEditor(
            displayIdx,
            layout,
            this.#colors,
            this.#closeEditor.bind(this),
            this.#presets,
            showGuideLines
        );
    }

    #closeEditor() {
        if (this.#gridEditor) {
            this.#gridEditor.destroy();
            this.#gridEditor = null;
            this.#saveLayouts();
        }
    }

    // read the layout from the configuration file, or set the default
    #readOrCreateLayoutForDisplay(displayIdx, defaultLayout = LayoutOf2x2.clone()) {
        if (this.#layouts[displayIdx]) {
            return this.#layouts[displayIdx];
        }

        let tree = this.#layoutIO.loadLayoutForDisplay(displayIdx);
        if (!tree) {
            tree = defaultLayout;
        }
        this.#layouts[displayIdx] = tree;
        return tree;
    }

    #connectWindowGrabs() {
        // start snapping when the user starts moving a window
        this.#signals.connect(global.display, 'grab-op-begin', (display, screen, window, op) => {
            if (op !== Meta.GrabOp.MOVING || window.window_type !== Meta.WindowType.NORMAL) {
                return Clutter.EVENT_PROPAGATE;
            }

            // If snappers already exist for this drag, this grab-begin is a
            // restart we scheduled ourselves from grab-op-end. Don't rebuild
            // state — just remember the (possibly refreshed) window reference.
            if (this.#windowSnappers.length > 0) {
                this.#currentDragWindow = window;
                return Clutter.EVENT_PROPAGATE;
            }

            // --- fresh drag ---
            this.#loadThemeColors();
            const enableSnappingModifiers = mapModifierSettingToModifierType(this.#settings.settingsData.enableSnappingModifiers.value);
            const enableMultiSnappingModifiers = mapModifierSettingToModifierType(this.#settings.settingsData.enableMultiSnappingModifiers.value);
            const enableMergeAdjacentOnHover = this.#settings.settingsData.mergeAdjacentOnHover.value;
            const mergingRadius = this.#settings.settingsData.mergingRadius.value;
            const activateWithNonPrimaryButton = this.#settings.settingsData.activateWithNonPrimaryButton.value;
            const stickySnap = this.#settings.settingsData.stickySnap && this.#settings.settingsData.stickySnap.value;

            this.#currentDragWindow = window;
            this.#dragCancelled = false;
            this.#restartCount = 0;

            // Create WindowSnapper for each monitor
            const nMonitors = global.display.get_n_monitors();
            for (let i = 0; i < nMonitors; i++) {
                const layout = this.#readOrCreateLayoutForDisplay(i, LayoutOf2x2);
                const snapper = new WindowSnapper(i, layout, window, enableSnappingModifiers, enableMultiSnappingModifiers, enableMergeAdjacentOnHover, mergingRadius, activateWithNonPrimaryButton, stickySnap);
                this.#windowSnappers.push(snapper);
            }

            // In sticky mode, listen for Escape to cancel the snap (overlay
            // goes away, LMB release commits nothing). Key events are not
            // consumed by Muffin's grab-op handler, so a Clutter event filter
            // installed here will see them.
            if (stickySnap) {
                this.#installEscapeFilter();
            }

            return Clutter.EVENT_PROPAGATE;
        });

        // stop snapping when the user stops moving a window
        this.#signals.connect(global.display, 'grab-op-end', (display, screen, window, op) => {
            if (op !== Meta.GrabOp.MOVING || window.window_type !== Meta.WindowType.NORMAL) {
                return Clutter.EVENT_PROPAGATE;
            }
            if (this.#windowSnappers.length === 0) {
                return Clutter.EVENT_PROPAGATE;
            }

            const stickySnap = this.#settings.settingsData.stickySnap && this.#settings.settingsData.stickySnap.value;
            const activateWithNonPrimaryButton = this.#settings.settingsData.activateWithNonPrimaryButton.value;

            // Decide whether this grab-end is Muffin tearing down the drag
            // on us (e.g. after an RMB press or release) while the user is
            // still holding the primary mouse button. If so, restart the
            // MOVING grab on the same window and keep our snapper state.
            //
            // There is deliberately NO time-based cooldown here: Muffin
            // tears the drag down once for the RMB press AND once for the
            // release, both arriving within a few tens of ms. Gating on
            // time would cause one of them to fall through to finalize(),
            // which would fire the snap prematurely. Instead we cap total
            // restarts per drag as a safety net against runaway loops.
            const [px, py, state] = global.get_pointer();
            const b1Held = !!(state & Clutter.ModifierType.BUTTON1_MASK);

            if (stickySnap && !this.#dragCancelled && b1Held && this.#currentDragWindow &&
                this.#restartCount < Application.MAX_RESTARTS_PER_DRAG) {
                this.#restartCount += 1;
                const win = this.#currentDragWindow;
                this.#pendingRestartId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
                    this.#pendingRestartId = 0;
                    this.#runRestart(win, activateWithNonPrimaryButton);
                    return GLib.SOURCE_REMOVE;
                });
                // Keep snappers alive — the restart will be a new grab-begin.
                return Clutter.EVENT_PROPAGATE;
            }
            if (this.#restartCount >= Application.MAX_RESTARTS_PER_DRAG) {
                global.logWarning(`fancytiles: hit MAX_RESTARTS_PER_DRAG (${Application.MAX_RESTARTS_PER_DRAG}), giving up`);
            }

            // Real end of drag: finalize (unless cancelled) and tear down.
            for (let snapper of this.#windowSnappers) {
                if (!this.#dragCancelled) {
                    snapper.finalize();
                }
                snapper.destroy();
            }
            this.#windowSnappers = [];
            this.#currentDragWindow = null;
            this.#dragCancelled = false;
            this.#removeEscapeFilter();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    #runRestart(win, activateWithNonPrimaryButton) {
        // User may have released LMB in the microseconds since schedule.
        const [px, py, st] = global.get_pointer();
        if (!(st & Clutter.ModifierType.BUTTON1_MASK) || !win) {
            // Let the pending grab-end finalization happen naturally next tick.
            for (let snapper of this.#windowSnappers) {
                if (!this.#dragCancelled) snapper.finalize();
                snapper.destroy();
            }
            this.#windowSnappers = [];
            this.#currentDragWindow = null;
            this.#dragCancelled = false;
            this.#removeEscapeFilter();
            return;
        }
        try {
            const time = global.get_current_time();
            // Use the display-level API with explicit anchor coordinates so
            // the grip point on the window's frame is preserved (the
            // window-level API warps the cursor to the window center).
            //
            //   meta_display_begin_grab_op(display, window, op,
            //       pointer_already_grabbed, frame_action, button, modmask,
            //       timestamp, root_x, root_y)
            global.display.begin_grab_op(
                win,
                Meta.GrabOp.MOVING,
                false, // pointer_already_grabbed
                true,  // frame_action
                1,     // button (LMB)
                0,     // modmask
                time,
                px,
                py
            );
            // The RMB tap that caused Muffin to tear down the drag is our
            // cue to latch sticky — but only when the user has opted in to
            // RMB-activation. Modifier-key activation latches itself on the
            // next onMotion once sticky mode is on.
            if (activateWithNonPrimaryButton) {
                for (let snapper of this.#windowSnappers) {
                    snapper.activateSticky();
                }
            }
        } catch (e) {
            global.logError(`fancytiles: restart grab failed: ${e}`);
            for (let snapper of this.#windowSnappers) {
                snapper.destroy();
            }
            this.#windowSnappers = [];
            this.#currentDragWindow = null;
            this.#dragCancelled = false;
            this.#removeEscapeFilter();
        }
    }

    #installEscapeFilter() {
        if (this.#dragKeyFilterId) return;
        this.#dragKeyFilterId = Clutter.event_add_filter(null, (event) => {
            if (event.type() === Clutter.EventType.KEY_PRESS &&
                event.get_key_symbol() === Clutter.KEY_Escape) {
                this.#dragCancelled = true;
                for (let snapper of this.#windowSnappers) {
                    snapper.deactivateSticky();
                }
                // Swallow the Escape so it doesn't leak to focused windows.
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    #removeEscapeFilter() {
        if (!this.#dragKeyFilterId) return;
        try { Clutter.event_remove_filter(this.#dragKeyFilterId); }
        catch (e) { /* ignore */ }
        this.#dragKeyFilterId = 0;
    }
}

module.exports = { Application, LayoutOf2x2 };
