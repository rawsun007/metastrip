"""The trailer's score and sound design, synthesized in one pass.

A minor at 128 bpm, dark and mechanical, because the film is about being
watched: a sub drone and data chirps under the hook, a four-on-the-floor
groove from the moment the crosshair locks, and every effect hung off a hit
in beats.json and pitched into the key. At the end the machine hunts, finds
nothing, is refused, and the whole thing drops to silence and resolves to
A major for "Untracked.", the one bright chord in the piece.

Pure numpy. No samples, nothing downloaded, nothing to license.
"""
import json, wave
import numpy as np

SR = 48000
B = json.load(open("beats.json"))
DUR = B["duration"]
BEAT = 60 / B["bpm"]; BAR = 4 * BEAT
N = int(SR * (DUR + 2))
rng = np.random.default_rng(128)
dry = np.zeros((N, 2)); wet = np.zeros((N, 2)); duck = np.zeros((N, 2))
# the final chord has its own bus (and room), added after the gate that makes the silence
late = np.zeros((N, 2)); late_wet = np.zeros((N, 2))
ACT = {a["id"]: a for a in B["acts"]}
HITS = B["hits"]
def at(beat): return beat * BEAT

def midi(m): return 440.0 * 2 ** ((m - 69) / 12)
def tt(d): return np.arange(int(d * SR)) / SR
def put(sig, t0, g=1.0, pan=0.0, send=0.1, bus=None):
    i = int(t0 * SR)
    if i >= N or i + len(sig) <= 0: return
    if i < 0: sig = sig[-i:]; i = 0
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    tgt = {"duck": duck, "late": late}.get(bus, dry); tw = late_wet if bus == "late" else wet
    tgt[i:i + len(sig), 0] += sig * g * l; tgt[i:i + len(sig), 1] += sig * g * r
    if send:
        tw[i:i + len(sig), 0] += sig * g * send * l; tw[i:i + len(sig), 1] += sig * g * send * r

def onepole(x, fc):
    a = np.exp(-2 * np.pi * fc / SR); y = np.empty_like(x); acc = 0.0
    for k in range(len(x)):
        acc = (1 - a) * x[k] + a * acc; y[k] = acc
    return y
def lp(x, fc): return onepole(onepole(x, fc), fc)
def hp(x, fc): return x - lp(x, fc)
noise = lambda d: rng.standard_normal(int(d * SR))
def saw(f, t): return sum(np.sin(2 * np.pi * f * k * t) / k for k in range(1, 12)) * 0.6
def square(f, t): return np.sign(np.sin(2 * np.pi * f * t))
def crush(x, bits=5, hold=6):
    q = 2 ** bits; y = np.round(x * q) / q
    return np.repeat(y[::hold], hold)[: len(x)]

# ---------- drums ----------
def kick(d=0.4, punch=1.0):
    t = tt(d); f = 45 + 140 * np.exp(-t * 40) * punch
    return np.tanh(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7) * 1.8 + hp(noise(d), 3000) * np.exp(-t * 400) * 0.4)
def hat(open_=False):
    d = 0.2 if open_ else 0.04; t = tt(d); return hp(noise(d), 8000) * np.exp(-t * (18 if open_ else 110))
def clap():
    x = np.zeros(int(0.25 * SR))
    for k, off in enumerate((0, 0.009, 0.019, 0.03)):
        bb = lp(hp(noise(0.22), 1000), 5000) * np.exp(-tt(0.22) * (70 if k < 3 else 14))
        i = int(off * SR); x[i:i + len(bb)] += bb[: len(x) - i]
    return x
K, HC, HO, CL = kick(), hat(), hat(True), clap()

# ---------- tonal ----------
CH = [[45, 52, 57, 60, 64], [41, 48, 53, 57, 60], [48, 55, 60, 64, 67], [43, 50, 55, 59, 62]]   # Am F C G
AMAJ = [45, 52, 57, 61, 64, 69]
def pad(ms, d, cutoff=1200, bright=False):
    t = tt(d); x = sum(saw(midi(m), t) + saw(midi(m) * 1.004, t) for m in ms) / (2 * len(ms))
    return lp(x, cutoff) * np.minimum(1, t / 0.4) * np.minimum(1, np.maximum(0, (d - t) / 0.5))
def pluck(m, d=0.25, g=1.0):
    t = tt(d); return (square(midi(m), t) * 0.4 + np.sin(2 * np.pi * midi(m) * t)) * np.exp(-t * 16) * g
def chirp(m, d=0.06):
    t = tt(d); return np.sin(2 * np.pi * midi(m) * t) * np.exp(-t * 60)
def zap(f0, f1, d):
    t = tt(d); f = f0 * (f1 / f0) ** (t / d)
    return (saw(1, np.cumsum(f) / SR) * 0.6 + hp(noise(d), 2000) * 0.3) * np.exp(-t * 2.5)
def ping(m=81, d=1.4):
    t = tt(d); return np.sin(2 * np.pi * midi(m) * t) * np.exp(-t * 3.5) + 0.3 * np.sin(2 * np.pi * midi(m + 12) * t) * np.exp(-t * 6)
def stab(ms, d=0.28):
    t = tt(d); x = sum(saw(midi(m), t) for m in ms) / len(ms)
    return crush(lp(x, 3500)) * np.exp(-t * 9)

grove0, grove1 = at(8), at(44)            # the groove runs from the lock to the hunt
search0, silence0 = at(44), at(48)

# hook: a sub drone and data chirps
t = tt(at(8) + 0.5); drone = np.sin(2 * np.pi * midi(33) * t) * 0.8 + 0.3 * np.sin(2 * np.pi * midi(45) * t)
put(drone * np.minimum(1, t / 0.6) * np.minimum(1, np.maximum(0, (len(t) / SR - t) / 0.5)), 0, 0.22, send=0.05)
PENT = [69, 72, 74, 76, 79, 81, 84, 88]
for k in range(40):
    put(chirp(PENT[int(rng.integers(0, 8))] + 12), k * BEAT / 5 + rng.random() * 0.05, 0.035, pan=rng.uniform(-0.8, 0.8), send=0.2)

# the groove
b = grove0; step = 0
while b < grove1 - 0.01:
    bi = round((b - grove0) / BEAT); ci = int((b - grove0) // BAR) % 4
    put(K, b, 0.5, send=0.02)
    if bi % 2 == 1: put(CL, b, 0.14, send=0.25, pan=0.05)
    put(HO, b + BEAT / 2, 0.05, pan=0.3, send=0.1)
    for s in range(4): put(HC, b + s * BEAT / 4, [0.035, 0.018, 0.028, 0.018][s], pan=-0.35)
    for s in range(4):   # rolling 16th bass, root and octave
        bt = b + s * BEAT / 4; m = CH[ci][0] - 12 + (12 if s == 3 else 0)
        tb = tt(BEAT / 4); x = lp(saw(midi(m), tb), 700) * np.exp(-tb * 12)
        put(x, bt, 0.22, bus="duck", send=0.0)
    b += BEAT
for bar in range(int((grove1 - grove0) / BAR) + 1):
    t0 = grove0 + bar * BAR
    if t0 >= grove1: break
    put(pad([m + 12 for m in CH[bar % 4][1:]], min(BAR, grove1 - t0) + 0.3, 1400), t0, 0.05, bus="duck", send=0.4)
# a thin arpeggio over the strip and the local acts
for k in range(int((at(44) - at(28)) / (BEAT / 2))):
    t0 = at(28) + k * BEAT / 2; ci = int((t0 - grove0) // BAR) % 4
    put(pluck(CH[ci][1 + k % 4] + 24, 0.2), t0, 0.035, pan=0.4 if k % 2 else -0.4, send=0.3)

# the hunt: the groove falls away, filtered pings with no lock
for k in range(6): put(ping(81 if k % 2 else 76, 0.6), search0 + k * BEAT * 0.5, 0.05, pan=-0.5 + k * 0.2, send=0.5)
t = tt(silence0 - search0); put(lp(noise(silence0 - search0), 300) * (t / t[-1]) ** 2, search0, 0.15, send=0.2)

# ---------- effects on the hits ----------
for h in HITS:
    ty, t0 = h["type"], h["t"]
    if ty == "scan":
        t = tt(0.4); f = midi(57) * 2 ** (2 * t / 0.4); put(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 3), t0, 0.06, send=0.3)
    elif ty == "slam":
        put(kick(0.6, 1.3), t0, 0.6, send=0.05); put(CL, t0, 0.12, send=0.3)
        put(stab([57, 60, 64, 69]), t0, 0.09, send=0.3)
    elif ty == "glitch":
        for k in range(6):        # a stutter: the same shard repeated, falling in pitch
            put(crush(zap(2400 - k * 300, 300, 0.05), 3, 12), t0 + k * 0.028, 0.12, pan=(-1) ** k * 0.5)
        put(hp(noise(0.2), 1500) * np.exp(-tt(0.2) * 20), t0, 0.1, send=0.1)
    elif ty == "lock":
        for k, m in enumerate([81, 88]): put(square(midi(m), tt(0.07)) * np.exp(-tt(0.07) * 20), t0 + k * 0.09, 0.05, send=0.2)
    elif ty == "ping": put(ping(), t0, 0.12, send=0.6)
    elif ty == "tick":
        for k in range(24): put(hp(noise(0.012), 3000) * np.exp(-tt(0.012) * 300), t0 + k * 0.03, 0.08, pan=0.3)
    elif ty == "flip":
        for k in range(20): put(hp(noise(0.02), 2500) * np.exp(-tt(0.02) * 200) + chirp(84 - k % 5, 0.02) * 0.3, t0 + k * 0.022, 0.12, pan=-0.3 + (k % 7) * 0.1)
    elif ty == "strobe":
        arp = [57, 60, 64, 69, 72, 76, 81, 84, 81, 76, 72, 69]
        for k in range(12): put(stab([arp[k], arp[k] + 7], 0.1), t0 + k * BEAT / 4, 0.08, pan=(-1) ** k * 0.3, send=0.15)
    elif ty == "zap":
        put(zap(1800, 45, 0.9), t0, 0.16, send=0.3); put(kick(0.8, 0.6), t0, 0.4)
        for k in range(14): put(chirp(84 - k * 2, 0.05), t0 + 0.1 + k * 0.05, 0.04, pan=(k % 5 - 2) / 3)   # the cut bytes falling
    elif ty == "clean":
        for k, m in enumerate([81, 88]): put(ping(m, 0.9), t0 + k * 0.22, 0.07, send=0.4)
    elif ty == "bounce":
        for k in range(7):
            t = tt(0.16); f = midi(76) * 2 ** (np.sin(np.pi * t / 0.16) * 0.6)
            put(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 14), t0 + k * 0.18 * BEAT, 0.06, pan=-0.6 + k * 0.2)
    elif ty == "search": pass     # the hunt above
    elif ty == "nodata":
        t = tt(0.4); put((square(midi(33), t) * 0.5 + square(midi(34), t) * 0.5 + hp(noise(0.4), 1000) * 0.2) * np.minimum(1, t / 0.005) * np.minimum(1, (0.4 - t) / 0.02), t0, 0.09, send=0.1)
    elif ty == "tone":
        # the one bright chord: A major, after the silence
        put(pad(AMAJ, DUR - t0 + 1.0, 2600), t0 + 0.12, 0.07, send=0.6, bus="late")
        put(np.sin(2 * np.pi * midi(69) * tt(DUR - t0)) * np.exp(-tt(DUR - t0) * 0.6), t0 + 0.12, 0.08, send=0.5, bus="late")
        put(ping(93, 2.2), t0 + 0.12, 0.05, send=0.7, bus="late")

# ---------- sidechain: pad and bass duck under every kick ----------
env = np.ones(N)
b = grove0
while b < grove1:
    i = int(b * SR); n = int(0.3 * SR); j = min(N, i + n)
    env[i:j] = np.minimum(env[i:j], (1 - 0.7 * np.exp(-np.arange(n) / (0.07 * SR)))[: j - i]); b += BEAT
dry += duck * env[:, None]; wet += duck * env[:, None] * 0.3

# ---------- one dark room ----------
def ir(seed, d=1.3):
    r = np.random.default_rng(seed); t = tt(d); x = r.standard_normal(len(t)) * np.exp(-t * 4.2)
    x = lp(x, 4500); x[: int(0.01 * SR)] = 0; return x / np.sqrt((x ** 2).sum())
def conv(x, h):
    n = 1 << int(np.ceil(np.log2(len(x) + len(h))))
    return np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(h, n), n)[: len(x)]
mix = dry + np.stack([conv(wet[:, 0], ir(1)), conv(wet[:, 1], ir(2))], 1) * 0.8

# The silence before the resolve is a real one: everything before it, tails
# and reverb included, is gated to nothing at the drop, and only then does
# the final chord come in on its own bus.
# it opens as the refusal buzzer ends (0.4 s after its hit), not at the drop itself
hole = next(h['t'] for h in HITS if h['type'] == 'nodata') + 0.4
s0, s1 = int(hole * SR), int((hole + 0.04) * SR)
gate = np.ones(N); gate[s0:s1] = np.linspace(1, 0, s1 - s0) ** 3; gate[s1:] = 0
mix *= gate[:, None]
mix += late + np.stack([conv(late_wet[:, 0], ir(3)), conv(late_wet[:, 1], ir(4))], 1) * 0.8

# ---------- master ----------
mix = mix[: int(DUR * SR)]
f = int(0.9 * SR); mix[-f:] *= (np.linspace(1, 0, f) ** 2)[:, None]
mix -= mix.mean(0)
mix = np.tanh(mix * 1.7) / np.tanh(1.7)
mix /= np.abs(mix).max() / 0.9
with wave.open("synth.wav", "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
print("synth.wav", DUR, "s")
