"""Erzeugt assets/icon.ico (+ icon.png) fuer das Claude-Usage-Widget.
Claude-Orange gerundetes Quadrat mit weissem Donut-Gauge (passt zu "Usage").
Mehrere Groessen in der .ico (16..256)."""
from PIL import Image, ImageDraw
import os, math

ORANGE = (204, 120, 92, 255)      # Claude-Coral
ORANGE_HI = (217, 119, 87, 255)
WHITE = (255, 255, 255, 255)
TRACK = (255, 255, 255, 70)

def render(sz):
    S = sz * 8  # supersample
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # gerundetes Quadrat (vertikaler Verlauf simuliert per zwei Rechtecken)
    r = int(S * 0.22)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=ORANGE)
    d.rounded_rectangle([0, 0, S - 1, int(S * 0.55)], radius=r, fill=ORANGE_HI)
    d.rounded_rectangle([0, int(S * 0.30), S - 1, S - 1], radius=r, fill=ORANGE)
    # Donut-Gauge
    cx = cy = S / 2
    R = S * 0.30
    w = int(S * 0.11)
    box = [cx - R, cy - R, cx + R, cy + R]
    d.arc(box, start=0, end=360, fill=TRACK, width=w)
    # gefuellter Bogen (~72% Auslastung), abgerundete Enden per Punkte
    start, end = -90, -90 + int(360 * 0.72)
    d.arc(box, start=start, end=end, fill=WHITE, width=w)
    for ang in (start, end):
        px = cx + R * math.cos(math.radians(ang))
        py = cy + R * math.sin(math.radians(ang))
        d.ellipse([px - w/2, py - w/2, px + w/2, py + w/2], fill=WHITE)
    # Mittelpunkt
    d.ellipse([cx - S*0.055, cy - S*0.055, cx + S*0.055, cy + S*0.055], fill=WHITE)
    return img.resize((sz, sz), Image.LANCZOS)

here = os.path.dirname(os.path.abspath(__file__))
sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [render(s) for s in sizes]
ico_path = os.path.join(here, "icon.ico")
imgs[-1].save(ico_path, format="ICO", sizes=[(s, s) for s in sizes])
imgs[-1].save(os.path.join(here, "icon.png"), format="PNG")
print("geschrieben:", ico_path, "und icon.png")
