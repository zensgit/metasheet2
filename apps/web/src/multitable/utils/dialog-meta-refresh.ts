// #5743: the manager dialogs (fields / access / views / import) keep their sheet meta fresh while
// open. They used to do it with a 1200 ms interval, which — because nothing compared payloads and
// nothing paused on a hidden tab — turned into an indefinite ~1 Hz GET /fields + GET /context pair
// for every admin-capable actor who left a dialog open (900+ pairs in 15 min, all 304).
//
// The cadence is now: one refresh when the dialog opens, one more whenever the tab becomes visible
// again while a dialog is open, and otherwise this slow keep-alive. Anything faster belongs to a
// push channel (realtime), not to polling.
export const DIALOG_META_REFRESH_INTERVAL_MS = 15000
