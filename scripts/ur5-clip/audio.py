# Factory-floor sound for the UR5e clip, as a phone microphone would catch it: hall room tone, a 100 Hz
# lighting hum, the conveyor, servo whine that follows the arm's joint speed, the vacuum ejector hissing
# while it holds a carton, the blow-off puff on release, and the hall's reverb. numpy only.
# Usage: python3 audio.py events.json out.wav
import json, sys, wave
import numpy as np

ev = json.load(open(sys.argv[1]))
SR = 48000
fps = ev['fps']
dur = ev['frames'] / fps
n = int(dur * SR)
t = np.arange(n) / SR
rng = np.random.default_rng(11)


def lowpass(x, fc):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X / np.sqrt(1 + (f / fc) ** 4), len(x))


def band(x, lo, hi):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    g = 1 / np.sqrt(1 + (lo / np.maximum(f, 1)) ** 4) / np.sqrt(1 + (f / hi) ** 4)
    return np.fft.irfft(X * g, len(x))


def norm(x):
    return x / (np.abs(x).max() + 1e-12)


def env_from_frames(vals):
    """Per-frame values -> smooth per-sample envelope."""
    fr = np.arange(len(vals)) / fps
    return np.interp(t, fr, vals)


def db(v):
    return 10 ** (v / 20)


out = np.zeros(n)

# hall room tone: brown-ish noise plus ventilation band, slowly breathing
brown = np.cumsum(rng.normal(size=n)); brown -= lowpass(brown, 8)
out += norm(lowpass(brown, 400)) * db(-30)
vent = band(rng.normal(size=n), 180, 900) * (1 + 0.25 * np.sin(2 * np.pi * 0.21 * t))
out += norm(vent) * db(-36)
# lighting/mains hum (50 Hz mains -> 100 Hz with harmonics)
hum = sum(a * np.sin(2 * np.pi * f * t + p) for f, a, p in ((100, 1.0, 0.2), (200, 0.45, 1.1), (300, 0.2, 2.0), (50, 0.3, 0.4)))
out += norm(hum) * db(-46)

# conveyor: drive motor tone with its gearbox, belt rumble
motor = np.sin(2 * np.pi * 1462 * t + 0.4 * np.sin(2 * np.pi * 3.1 * t)) * 0.4 + np.sin(2 * np.pi * 731 * t) * 0.6
out += norm(motor) * db(-50)
out += norm(band(rng.normal(size=n), 60, 320)) * db(-39)

# servo whine and gear noise following the arm's joint speed
spd = np.array(ev['speed'])
spd_env = env_from_frames(spd / max(spd.max(), 1e-6))
pitch = 620 + 520 * spd_env
phase = 2 * np.pi * np.cumsum(pitch) / SR
whine = np.sin(phase) + 0.35 * np.sin(2 * phase) + 0.15 * np.sin(3.02 * phase)
out += whine * spd_env ** 1.3 * db(-40)
out += norm(band(rng.normal(size=n), 1800, 5200)) * spd_env ** 1.5 * db(-44)

# vacuum: valve click + ejector hiss while holding, blow-off puff at release
for p, r in zip(ev['picks'], ev['releases']):
    t0, t1 = (p - 1) / fps, (r - 1) / fps
    i0, i1 = int(t0 * SR), int(t1 * SR)
    click = np.zeros(n); k = np.arange(int(0.012 * SR))
    click[i0:i0 + len(k)] = np.sin(2 * np.pi * 2400 * k / SR) * np.exp(-k / (0.002 * SR))
    out += click * db(-20)
    hold = np.zeros(n)
    ramp = int(0.04 * SR)
    hold[i0:i1] = 1.0
    hold[i0:i0 + ramp] = np.linspace(0, 1, ramp)
    hold[i1 - ramp:i1] = np.linspace(1, 0, ramp)
    out += norm(band(rng.normal(size=n), 2500, 9000)) * hold * db(-37)
    puff = np.zeros(n); L = int(0.28 * SR)
    puff[i1:i1 + L] = np.exp(-np.arange(L) / (0.06 * SR))
    out += norm(band(rng.normal(size=n), 900, 11000)) * puff * db(-22)
    # carton set down on the stack, a few frames before release
    j = int((t1 - 0.12) * SR); L = int(0.09 * SR); k = np.arange(L)
    thud = np.zeros(n)
    thud[j:j + L] = (np.sin(2 * np.pi * 95 * k / SR) + 0.5 * rng.normal(size=L) * np.exp(-k / (0.004 * SR))) * np.exp(-k / (0.02 * SR))
    out += thud * db(-24)

# far-off factory: a couple of metallic clanks and a reversing truck's beeper
for tc, f0 in ((2.7, 1730), (6.4, 1180), (8.9, 2210)):
    i = int(tc * SR); L = int(0.6 * SR); k = np.arange(L)
    if i + L < n:
        s = sum(np.sin(2 * np.pi * f0 * m * k / SR) / m for m in (1, 2.76, 5.4)) * np.exp(-k / (0.09 * SR))
        out[i:i + L] += s * db(-44)
beep_on = ((t % 1.0) < 0.42) & (t > 3.2) & (t < 7.6)
out += np.sin(2 * np.pi * 1040 * t) * beep_on * db(-55)

# the hall: synthetic impulse response, RT60 about 1.6 s, mixed in
L = int(1.8 * SR)
ir = rng.normal(size=L) * np.exp(-np.arange(L) / (1.6 / 6.9 * SR))
ir = lowpass(ir, 5000)
ir[0] = 0
wet = np.fft.irfft(np.fft.rfft(out, n + L) * np.fft.rfft(ir, n + L), n + L)[:n]
mix = out + norm(wet) * np.abs(out).max() * 0.55

# phone microphone: high-pass, gentle presence peak, AGC-style compression, a little self-noise
mix = band(mix, 110, 11000)
mix = mix + 0.3 * band(mix, 2000, 5000)
envl = np.sqrt(lowpass(mix ** 2, 4) .clip(1e-12))
gain = (envl / envl.mean()) ** -0.35
mix = mix * gain
mix += rng.normal(size=n) * np.abs(mix).max() * 0.004
# fade the ends so the loop does not click
f = int(0.08 * SR)
mix[:f] *= np.linspace(0, 1, f); mix[-f:] *= np.linspace(1, 0, f)
mix = mix / np.abs(mix).max() * db(-3)

with wave.open(sys.argv[2], 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('wrote', sys.argv[2], round(dur, 2), 's')
