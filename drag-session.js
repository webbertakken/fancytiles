const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;

const { WindowSnapper } = require('./window-snapper');

// Safety cap against runaway restart loops.
const MAX_RESTARTS = 100;

/**
 * Owns all per-drag state and lifecycle for one MOVING grab on one window.
 *
 * Muffin terminates a MOVING grab on any secondary mouse button event
 * while LMB is held, and a Cinnamon extension cannot veto that from JS.
 * Workaround: on every grab-op-end we re-issue the MOVING grab on the
 * same window whenever LMB is still physically down, preserving the
 * grip point via explicit anchor coordinates. The effect is an
 * uninterrupted drag.
 *
 * Sticky mode layers on: once activated during the drag, the snap
 * overlay stays visible until LMB release commits or Escape cancels.
 */
class DragSession {
    #window;
    #options;
    #layoutFor;           // (monitorIdx) -> LayoutNode
    #snappers = [];

    #cancelled = false;
    #restarts = 0;
    #pendingRestartId = 0;
    #escapeFilterId = 0;
    #activationPollerId = 0;

    /**
     * @param {Meta.Window} params.window     window being dragged
     * @param {Function}    params.layoutFor  (monitorIdx) => LayoutNode
     * @param {object}      params.options    resolved settings snapshot
     *
     * Settings are snapshot once here so a mid-drag setting change can't
     * corrupt in-flight state.
     */
    constructor({ window, layoutFor, options }) {
        this.#window = window;
        this.#layoutFor = layoutFor;
        this.#options = options;

        const nMonitors = global.display.get_n_monitors();
        for (let i = 0; i < nMonitors; i++) {
            this.#snappers.push(this.#buildSnapper(i));
        }

        if (options.stickySnap) {
            this.#installEscapeFilter();
            this.#startActivationPoller();
        }
    }

    // A grab-begin fired while we're alive — that's our own restart landing.
    onGrabRestart(window) {
        this.#window = window;
    }

    // Called on grab-op-end. Returns true if we've scheduled a restart
    // (caller keeps the session alive); false if the drag is really over.
    tryRestart() {
        if (!this.#options.stickySnap || this.#cancelled) return false;
        if (this.#restarts >= MAX_RESTARTS) {
            global.logWarning(`fancytiles: hit MAX_RESTARTS (${MAX_RESTARTS}), giving up`);
            return false;
        }
        const [anchorX, anchorY, state] = global.get_pointer();
        if (!(state & Clutter.ModifierType.BUTTON1_MASK)) return false;

        this.#scheduleRestart(anchorX, anchorY);
        return true;
    }

    // Commit the snap (or skip if cancelled) and release all resources.
    finish() {
        if (this.#pendingRestartId) {
            GLib.source_remove(this.#pendingRestartId);
            this.#pendingRestartId = 0;
        }
        this.#stopActivationPoller();
        this.#removeEscapeFilter();

        for (const snapper of this.#snappers) {
            if (!this.#cancelled) snapper.finalize();
            snapper.destroy();
        }
        this.#snappers = [];
        this.#window = null;
    }

    // ---------------- private ----------------

    #buildSnapper(monitorIdx) {
        const o = this.#options;
        return new WindowSnapper(
            monitorIdx,
            this.#layoutFor(monitorIdx),
            this.#window,
            o.enableSnappingModifiers,
            o.enableMultiSnappingModifiers,
            o.mergeAdjacentOnHover,
            o.mergingRadius,
            o.activateWithNonPrimaryButton,
            o.stickySnap,
        );
    }

    #scheduleRestart(anchorX, anchorY) {
        this.#restarts += 1;
        this.#pendingRestartId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this.#pendingRestartId = 0;
            this.#reissueGrab(anchorX, anchorY);
            return GLib.SOURCE_REMOVE;
        });
    }

    #reissueGrab(anchorX, anchorY) {
        // LMB may have been released during the idle race.
        const [, , state] = global.get_pointer();
        if (!(state & Clutter.ModifierType.BUTTON1_MASK) || !this.#window) {
            this.finish();
            return;
        }

        try {
            // Display-level begin_grab_op with explicit anchor coords
            // preserves the grip point (the window-level API re-anchors
            // at the window centre).
            global.display.begin_grab_op(
                this.#window,
                Meta.GrabOp.MOVING,
                /* pointer_already_grabbed */ false,
                /* frame_action            */ true,
                /* button                  */ 1,
                /* modmask                 */ 0,
                global.get_current_time(),
                anchorX,
                anchorY,
            );
        } catch (e) {
            global.logError(`fancytiles: restart grab failed: ${e}`);
            this.#cancelled = true;
            this.finish();
            return;
        }

        // The secondary-button tap that caused Muffin's tear-down is our
        // cue to latch sticky, but only when the user has opted in to
        // RMB-activation. Modifier-key activation self-latches on the
        // next onMotion.
        if (this.#options.activateWithNonPrimaryButton) {
            for (const snapper of this.#snappers) snapper.activateSticky();
        }
    }

    #installEscapeFilter() {
        // Muffin does not consume key events during a MOVING grab, so a
        // Clutter filter sees them.
        this.#escapeFilterId = Clutter.event_add_filter(null, (event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS) return Clutter.EVENT_PROPAGATE;
            if (event.get_key_symbol() !== Clutter.KEY_Escape) return Clutter.EVENT_PROPAGATE;
            this.#onEscape();
            return Clutter.EVENT_STOP;
        });
    }

    #removeEscapeFilter() {
        if (!this.#escapeFilterId) return;
        try { Clutter.event_remove_filter(this.#escapeFilterId); }
        catch (_) { /* ignore */ }
        this.#escapeFilterId = 0;
    }

    #onEscape() {
        this.#cancelled = true;
        for (const snapper of this.#snappers) snapper.deactivateSticky();
    }

    // Until the first activation happens, poll the pointer at 60 Hz so we
    // pick up RMB-press-without-motion (Muffin doesn't tear down the grab
    // on press in that case, and button events don't reach JS during a
    // MOVING grab, so there's no event-driven trigger). Self-terminates
    // as soon as any snapper reports sticky = true.
    #startActivationPoller() {
        this.#activationPollerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (this.#snappers.some(s => s.isSticky)) {
                this.#activationPollerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            for (const snapper of this.#snappers) snapper.refreshFromPointer();
            return GLib.SOURCE_CONTINUE;
        });
    }

    #stopActivationPoller() {
        if (!this.#activationPollerId) return;
        GLib.source_remove(this.#activationPollerId);
        this.#activationPollerId = 0;
    }
}

module.exports = { DragSession };
