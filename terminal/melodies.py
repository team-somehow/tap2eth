"""What the terminal plays, and when.

A melody is a tuple of (frequency in Hz, milliseconds) notes; frequency 0 is a rest. An active
buzzer ignores the pitch and keeps only the rhythm, so every melody has its own rhythm too.
"""
import re

REST = 0
G4 = 392
C5, D5, E5, F5, Fs5, G5, A5, B5 = 523, 587, 659, 698, 740, 784, 880, 988
C6, D6, E6, G6, A6 = 1047, 1175, 1319, 1568, 1760
C7, E7, G7 = 2093, 2637, 3136

MELODIES = {
    "ready": ((C5, 80), (E5, 80), (G5, 80), (C6, 80), (E6, 80), (G6, 220)),   # terminal started: a sparkle up
    "prompt": ((G5, 70), (C6, 70), (E6, 170)),                                # waiting for a tap
    "tap": ((E6, 40), (A6, 60)),                                              # card touched the reader
    "retry": ((A5, 100), (REST, 60), (A5, 100), (REST, 60), (E5, 240)),       # couldn't read, tap again
    "card_ok": ((C6, 70), (G6, 70), (C7, 220)),                               # card done, go to the phone
    "paid": ((C6, 70), (E6, 70), (G6, 70), (C7, 150), (REST, 70),             # cash register fanfare
             (G6, 70), (C7, 70), (E7, 70), (G7, 420)),
    "registered": ((G5, 100), (C6, 100), (E6, 100), (G6, 300)),
    "declined": ((G5, 180), (REST, 30), (Fs5, 180), (REST, 30), (F5, 180), (REST, 30), (C5, 520)),  # wah wah wah wahhh
    "cancel": ((G5, 60), (C5, 140)),
    "volume": ((A5, 70),),                                                    # heard when the volume level changes
}
CUES = tuple(MELODIES)

# Each keypad key has its own note, climbing a pentatonic scale, so typing an amount always sounds nice.
KEY_NOTE_MS = 55
KEY_NOTES = {
    "1": C5, "2": D5, "3": E5, "4": G5, "5": A5, "6": C6, "7": D6, "8": E6, "9": G6,
    ".": C7, "0": A6, "⌫": G4,
}

TAP_MODES = ("pay", "register")
_READING = re.compile(r"Reading|Almost")
_TAP_FAILED = re.compile(r"Couldn't|tap again")


def _matches(pattern, state):
    return bool(pattern.search(state["detail"] or ""))


def _tap_cue(before, after):
    """Cue for what happened to the card while the terminal waits for a tap."""
    if _matches(_READING, after) and not _matches(_READING, before):
        return "tap"
    if _matches(_TAP_FAILED, after) and not _matches(_TAP_FAILED, before):
        return "retry"
    return None


def cue_for(before, after):
    """Name of the melody a change of terminal state should play, or None."""
    if after["ok"] is True and before["ok"] is not True:
        return "paid" if after["amount"] else "registered"
    if after["ok"] is False and before["ok"] is not False:
        return "declined"
    if after["mode"] == "waiting" and before["mode"] != "waiting":
        return "card_ok"
    if after["mode"] == "idle":
        cancelled = before["mode"] != "idle" and before["ok"] is None
        return "cancel" if cancelled else None
    if after["mode"] in TAP_MODES:
        return "prompt" if before["mode"] not in TAP_MODES else _tap_cue(before, after)
    return None
