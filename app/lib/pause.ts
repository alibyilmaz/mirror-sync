// Shared sentinel for a merchant-initiated ("Pause" button) pause, so the
// reconcile engine can tell it apart from automatic pauses (write failures,
// drift) and never auto-revive a deliberate pause.
export const MANUAL_PAUSE_REASON = "Paused manually";
