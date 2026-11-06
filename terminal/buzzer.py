"""Plays melodies on a buzzer wired to a Raspberry Pi GPIO pin.

Sound never holds up or breaks a payment: playing happens on its own thread, and if the buzzer
or the GPIO library is missing the terminal carries on silently.

Two kinds of buzzer:
  active   has its own oscillator and buzzes at one pitch when powered, so only rhythm plays.
  passive  a bare piezo that sounds whatever square wave it's given, so real notes play.
Some modules are active-low: they sound while the pin is low. Their pin idles high to stay quiet.

Volume is pulse width. An active buzzer is pulsed well above its own pitch so the on-time sets the
loudness; a passive piezo is loudest at a 50% square wave and gets quieter as the pulse narrows.
Loudness isn't linear, so 50 means half the power, not exactly half as loud to the ear.
The terminal shows it as a level from 0 (mute) to 10 (loudest): level times ten is the percent.
"""
import threading

from melodies import KEY_NOTE_MS, KEY_NOTES, MELODIES

KINDS = ("active", "passive")
GAP_MS = 15  # short silence after each note so repeated notes stay separate on an active buzzer
ACTIVE_PWM_HZ = 8000  # far from a typical active buzzer's ~2.3 kHz pitch, so it doesn't beat with it
PASSIVE_MAX_DUTY = 50  # a passive piezo has no more to give past an even square wave
DEFAULT_VOLUME = 50  # percent
GPIO_CHIPS = (0, 4)  # Pi 5 kernels expose the header as gpiochip0 or gpiochip4


def _open_chip(lgpio, pin):
    for chip in GPIO_CHIPS:
        try:
            handle = lgpio.gpiochip_open(chip)
        except Exception:  # noqa: BLE001 - lgpio raises its own error type for a missing chip
            continue
        if lgpio.gpio_get_line_info(handle, pin)[3] == f"GPIO{pin}":
            return handle
        lgpio.gpiochip_close(handle)
    raise OSError(f"no gpiochip has GPIO{pin}")


class GpioDriver:
    def __init__(self, pin, kind="active", active_low=False, volume=DEFAULT_VOLUME):
        if kind not in KINDS:
            raise ValueError(f"unknown buzzer kind: {kind}")
        if not 0 <= volume <= 100:
            raise ValueError(f"buzzer volume must be 0-100, got {volume}")
        import lgpio
        self.lgpio, self.pin, self.kind = lgpio, pin, kind
        self.active_low = active_low
        self.idle_level = 1 if active_low else 0
        self.set_volume(volume)
        self.pulsing = False
        self.handle = _open_chip(lgpio, pin)
        lgpio.gpio_claim_output(self.handle, pin, self.idle_level)

    def set_volume(self, volume):
        """0 is mute. Takes effect from the next note."""
        on_percent = volume if self.kind == "active" else volume * PASSIVE_MAX_DUTY / 100
        self.volume = volume
        self.duty = 100 - on_percent if self.active_low else on_percent  # lgpio's duty is time spent high

    def tone(self, freq):
        if self.volume == 0:
            return
        pwm_hz = ACTIVE_PWM_HZ if self.kind == "active" else freq
        self.lgpio.tx_pwm(self.handle, self.pin, pwm_hz, self.duty)
        self.pulsing = True

    def silence(self):
        if self.pulsing:  # lgpio rejects stopping a PWM that isn't running
            self.lgpio.tx_pwm(self.handle, self.pin, 0, 0)
            self.pulsing = False
        self.lgpio.gpio_write(self.handle, self.pin, self.idle_level)

    def close(self):
        self.lgpio.gpiochip_close(self.handle)


class SilentBuzzer:
    """Stands in when there's no buzzer: on a laptop, or when the GPIO can't be opened."""

    def play(self, name):
        pass

    def key(self, key):
        pass

    def set_volume(self, volume):
        pass

    def close(self):
        pass


class Buzzer:
    def __init__(self, driver, melodies=MELODIES, key_notes=None):
        self.driver, self.melodies = driver, melodies
        self.key_notes = {k: (f, KEY_NOTE_MS) for k, f in KEY_NOTES.items()} if key_notes is None else key_notes
        self._lock = threading.Lock()
        self._wake = threading.Event()  # set when there's a melody to play, or on close
        self._pending, self._playing, self._closed = None, False, False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def play(self, name):
        """Start a melody straight away, cutting off whatever is playing."""
        notes = self.melodies.get(name)
        if notes:
            self._queue(notes)

    def key(self, key):
        """Sound a keypad note, unless a melody is playing: it's never worth cutting one off."""
        note = self.key_notes.get(key)
        if note and not self.busy():
            self._queue((note,))

    def set_volume(self, volume):
        """Loudness 0-100 percent (0 is mute), changed while running."""
        self.driver.set_volume(volume)

    def busy(self):
        with self._lock:
            return self._playing or self._pending is not None

    def close(self):
        with self._lock:
            self._closed, self._pending = True, None
            self._wake.set()
        self._thread.join(timeout=2)
        self.driver.close()

    def _queue(self, notes):
        with self._lock:
            if self._closed:
                return
            self._pending = notes
            self._wake.set()  # under the lock, so _take can't clear it after taking these notes

    def _take(self):
        with self._lock:
            notes, self._pending = self._pending, None
            self._playing = notes is not None
            self._wake.clear()
            return notes, self._closed

    def _finished(self):
        with self._lock:
            self._playing = False

    def _run(self):
        while True:
            self._wake.wait()
            notes, closed = self._take()
            if closed:
                return
            if notes:
                self._perform(notes)
                self._finished()

    def _perform(self, notes):
        try:
            self._sound(notes)
        except Exception as e:  # noqa: BLE001 - a buzzer fault must never reach the payment flow
            print(f"buzzer failed: {e}", flush=True)
        finally:
            self._silence()

    def _silence(self):
        try:
            self.driver.silence()
        except Exception as e:  # noqa: BLE001
            print(f"buzzer failed to go quiet: {e}", flush=True)

    def _sound(self, notes):
        """Play the notes; a new melody or close sets _wake, which ends the wait early."""
        for freq, ms in notes:
            if freq:
                self.driver.tone(freq)
            if self._wake.wait(ms / 1000):
                return
            self.driver.silence()
            if self._wake.wait(GAP_MS / 1000):
                return


def make_buzzer(pin, kind="active", active_low=False, volume=DEFAULT_VOLUME):
    if pin is None:
        return SilentBuzzer()
    try:
        return Buzzer(GpioDriver(pin, kind, active_low, volume))
    except ValueError:
        raise  # a bad kind or volume is a typo to fix, not a hardware problem
    except Exception as e:  # noqa: BLE001 - lgpio.error isn't an OSError, and sound is optional
        print(f"buzzer off, couldn't open GPIO{pin}: {e}", flush=True)
    return SilentBuzzer()
