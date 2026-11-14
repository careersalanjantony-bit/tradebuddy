"""TradeBuddy notification tones (app v1.9): original sounds synthesised from scratch with numpy.

Each tone is built from sine partials, filtered noise and a small synthetic room echo, so nothing is
sampled or copied from any existing sound. Output: 44.1 kHz mono 16-bit WAV files in OUT.
"""
import sys
import wave

import numpy as np

SR = 44100
OUT = sys.argv[1]


def buf(dur):
    return np.zeros(int(SR * dur))


def tt(dur):
    return np.arange(int(SR * dur)) / SR


def add(dst, src, at):
    i = int(SR * at)
    n = min(len(src), len(dst) - i)
    if n > 0:
        piece = src[:n].copy()
        k = min(n, int(SR * 0.012))
        piece[n - k:] *= np.linspace(1, 0, k)  # no click where a sound is cut off
        dst[i:i + n] += piece


def attack(x, ms=3.0):
    n = max(1, int(SR * ms / 1000))
    x[:n] *= np.linspace(0, 1, n)
    return x


def partials(f0, ratios, amps, taus, dur, detune=0.0, phase_seed=0):
    rng = np.random.default_rng(phase_seed)
    t = tt(dur)
    y = np.zeros_like(t)
    for r, a, tau in zip(ratios, amps, taus):
        ph = rng.uniform(0, 2 * np.pi)
        y += a * np.sin(2 * np.pi * f0 * r * t + ph) * np.exp(-t / tau)
        if detune:
            y += 0.35 * a * np.sin(2 * np.pi * f0 * r * (1 + detune) * t + ph + 1.1) * np.exp(-t / tau)
    return attack(y, 1.5)


def band_noise(dur, lo, hi, tau, seed):
    rng = np.random.default_rng(seed)
    n = int(SR * dur)
    x = rng.standard_normal(n)
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    spec[(f < lo) | (f > hi)] = 0
    y = np.fft.irfft(spec, n)
    y /= np.max(np.abs(y)) + 1e-9
    return attack(y * np.exp(-tt(dur) / tau), 0.5)


def room(x, mix, decay=0.35, seed=7):
    """A small synthetic echo: convolution with exponentially fading, softened noise."""
    rng = np.random.default_rng(seed)
    n = int(SR * decay * 2.2)
    ir = rng.standard_normal(n) * np.exp(-tt(n / SR) / (decay / 3))
    spec = np.fft.rfft(ir)
    f = np.fft.rfftfreq(n, 1 / SR)
    spec *= 1 / (1 + (f / 5000) ** 2)  # darker tail
    ir = np.fft.irfft(spec, n)
    ir[: int(SR * 0.012)] = 0  # pre-delay
    ir /= np.sum(np.abs(ir)) / 6 + 1e-9
    m = len(x) + n
    wet = np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(ir, m), m)[: len(x) + n // 2]
    dry = np.concatenate([x, np.zeros(len(wet) - len(x))])
    return dry + mix * wet / (np.max(np.abs(wet)) + 1e-9) * np.max(np.abs(x))


def finish(x, drive=1.6):
    x = x / (np.max(np.abs(x)) + 1e-9)
    x = np.tanh(drive * x) / np.tanh(drive)  # gentle limiter: louder without clipping
    # cut the silent tail (below -46 dB), keep 60 ms after it
    loud = np.nonzero(np.abs(x) > 0.005)[0]
    if len(loud):
        x = x[: min(len(x), loud[-1] + int(SR * 0.06))]
    n = int(SR * 0.03)
    x[-n:] *= np.linspace(1, 0, n)
    return 0.9 * x / (np.max(np.abs(x)) + 1e-9)


def write(name, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with wave.open(f'{OUT}/{name}.wav', 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def coin(seed, amp=1.0, ring=1.0):
    rng = np.random.default_rng(seed)
    f = rng.uniform(3600, 5200)
    taus = [0.09 * ring * rng.uniform(0.8, 1.25), 0.06 * ring, 0.035 * ring]
    y = partials(f, [1, 1.47, 2.09], [1, 0.6, 0.35], taus, 0.45, detune=0.002, phase_seed=seed)
    y += 0.35 * band_noise(0.45, 2500, 12000, 0.002, seed + 100)
    return amp * y


# 1. Cash register: the drawer's "ka" and a bright double "ching"
def cash():
    x = buf(1.35)
    add(x, 0.55 * band_noise(0.06, 1500, 7000, 0.008, 1), 0.0)
    add(x, 0.35 * band_noise(0.01, 2000, 9000, 0.0015, 2), 0.012)
    add(x, 0.4 * band_noise(0.01, 2000, 9000, 0.0015, 3), 0.046)
    thunk = np.sin(2 * np.pi * 140 * tt(0.25)) * np.exp(-tt(0.25) / 0.04)
    add(x, 0.3 * attack(thunk, 2), 0.075)
    bell = dict(ratios=[1, 2.0, 2.76, 3.9, 5.4], amps=[1, 0.35, 0.5, 0.2, 0.15], taus=[0.45, 0.25, 0.2, 0.12, 0.08])
    add(x, 0.8 * partials(2349.3, dur=1.2, detune=0.003, phase_seed=4, **bell), 0.065)
    add(x, 0.7 * partials(3136.0, dur=1.1, detune=0.003, phase_seed=5, **bell), 0.16)
    return finish(room(x, 0.16))


# 2. Falling coins: a handful of coins landing on a pile, the last one spinning
def coins():
    x = buf(1.25)
    times = [0, 0.07, 0.13, 0.22, 0.30, 0.41, 0.53, 0.67, 0.82]
    amps = [1, 0.8, 0.9, 0.7, 0.6, 0.5, 0.42, 0.32, 0.26]
    for i, (at, a) in enumerate(zip(times, amps)):
        add(x, coin(20 + i, a, ring=3.2 if i == len(times) - 1 else 1.0), at)
    return finish(room(x, 0.13))


# 3. Market bell: two strikes of a bright brass bell
def bell():
    x = buf(2.1)
    spec = dict(ratios=[1, 2.0, 2.92, 4.16, 5.43, 6.8], amps=[1, 0.6, 0.4, 0.25, 0.18, 0.1], taus=[1.2, 0.8, 0.5, 0.35, 0.25, 0.18])
    for at, a, seed in [(0.0, 1.0, 30), (0.42, 0.85, 31)]:
        add(x, a * partials(880.0, dur=1.65, detune=0.0025, phase_seed=seed, **spec), at)
        add(x, 0.25 * a * band_noise(0.02, 1500, 10000, 0.003, seed + 5), at)
    return finish(room(x, 0.22, decay=0.5))


def note(f, dur, tau, harm=(1, 0.25, 0.08), seed=0):
    return partials(f, [1, 2, 3], list(harm), [tau, tau * 0.6, tau * 0.4], dur, phase_seed=seed)


# 4. Profit chime: three rising notes and a sparkle on top
def chime():
    x = buf(1.3)
    for i, (f, at, a, tau) in enumerate([(1046.5, 0, 0.7, 0.35), (1318.5, 0.11, 0.75, 0.35), (1568.0, 0.22, 0.8, 0.4), (2093.0, 0.36, 0.9, 0.6)]):
        add(x, a * note(f, 1.0, tau, seed=40 + i), at)
    add(x, 0.15 * note(4186.0, 0.6, 0.2, harm=(1, 0.1, 0), seed=45), 0.37)
    return finish(room(x, 0.18))


# 5. Jackpot: a quick rising run, a bright chord and a few coins
def jackpot():
    x = buf(1.6)
    run = [783.99, 880.0, 1046.5, 1174.7, 1318.5, 1568.0, 1760.0, 2093.0]
    for i, f in enumerate(run):
        tone = partials(f, [1, 3, 5], [1, 0.22, 0.08], [0.12, 0.07, 0.05], 0.4, phase_seed=50 + i)
        add(x, 0.55 * tone, i * 0.055)
    for j, f in enumerate([1046.5, 1318.5, 1568.0, 2093.0]):
        add(x, 0.42 * note(f, 1.1, 0.6, seed=60 + j), 0.47)
    for k, at in enumerate([0.52, 0.66, 0.8, 0.97]):
        add(x, coin(70 + k, 0.35 - 0.05 * k), at)
    return finish(room(x, 0.15))


# 6. Soft pop: two small bubbles
def pop():
    x = buf(0.4)
    for at, a, f0, f1, seed in [(0, 0.9, 500, 1400, 80), (0.09, 0.5, 700, 1900, 81)]:
        t = tt(0.2)
        f = f0 * (f1 / f0) ** np.minimum(1, t / 0.06)
        ph = 2 * np.pi * np.cumsum(f) / SR
        add(x, a * attack(np.sin(ph) * np.exp(-t / 0.045), 2), at)
    return finish(room(x, 0.1), drive=1.2)


for name, fn in [('tone_cash', cash), ('tone_coins', coins), ('tone_bell', bell), ('tone_chime', chime), ('tone_jackpot', jackpot), ('tone_pop', pop)]:
    y = fn()
    write(name, y)
    print(name, f'{len(y) / SR:.2f}s')
