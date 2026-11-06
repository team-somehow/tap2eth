"""What the terminal plays, and when: short 8-bit game-style cues for Team Somehow Café.

A melody is a tuple of (frequency in Hz, milliseconds) notes; frequency 0 is a rest. An active
buzzer ignores the pitch and keeps only the rhythm, so every melody has its own rhythm too.
Original jingles in a retro-console spirit (quick arpeggios, square-wave blips); none copies a game's tune.
Kept short: a café plays these all day.
"""
import re

REST = 0
C4, G4 = 262, 392
C5, D5, E5, F5, Fs5, G5, A5, B5 = 523, 587, 659, 698, 740, 784, 880, 988
C6, D6, E6, G6, A6 = 1047, 1175, 1319, 1568, 1760
C7, E7, G7 = 2093, 2637, 3136

MELODIES = {
    # console boot: a quick climb and a ding
    "ready": ((C5, 60), (E5, 60), (G5, 60), (C6, 60), (REST, 40), (G6, 70), (C7, 260)),
    # "insert card": two bright blips
    "prompt": ((E6, 60), (REST, 50), (A6, 120)),
    # card touched the reader: a pickup blip
    "tap": ((A6, 35), (E7, 55)),
    # couldn't read it: a low double bump, like walking into a wall
    "retry": ((G4, 70), (REST, 40), (C4, 140)),
    # card read, over to the phone: a little power-up run
    "card_ok": ((C6, 45), (E6, 45), (G6, 45), (C7, 45), (E7, 140)),
    # paid: a coin chime, then a short level-clear fanfare
    "paid": ((A5, 50), (E6, 220), (REST, 60),
             (C6, 70), (E6, 70), (G6, 70), (C7, 120), (REST, 40), (G6, 70), (C7, 360)),
    "registered": ((C6, 60), (E6, 60), (G6, 60), (C7, 60), (G7, 280)),
    # declined: a short game-over slide down
    "declined": ((G5, 140), (E5, 140), (C5, 140), (REST, 40), (G4, 160), (C4, 380)),
    "cancel": ((E5, 50), (C5, 120)),
    "volume": ((A5, 60),),  # heard when the volume level changes
}
CUES = tuple(MELODIES)

# Each keypad key has its own note, climbing a pentatonic scale, so typing an amount always sounds nice.
# Short like a menu-select blip.
KEY_NOTE_MS = 40
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
