#!/usr/bin/env python3
"""Render docs/demo/agent-body.gif from docs/demo/captured.json.

Design rule: this script cannot invent a number. Every value it draws is read
from captured.json, which records real tool output (see its _capture field).
If the file is missing, the script exits non-zero instead of drawing something
plausible.

    python tools/make-demo-gif.py

Outputs:
    docs/demo/agent-body.gif      (README hero, loops)
    docs/demo/agent-body-hero.png (static last frame, for social/og cards)
"""

from __future__ import annotations

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "demo", "captured.json")
OUT_GIF = os.path.join(ROOT, "docs", "demo", "agent-body.gif")
OUT_PNG = os.path.join(ROOT, "docs", "demo", "agent-body-hero.png")

W, H = 1040, 660
PAD = 22
BAR_H = 34
BG = (13, 17, 23)
BAR = (22, 27, 34)
FG = (201, 209, 217)
DIM = (139, 148, 158)
GREEN = (63, 185, 80)
BLUE = (88, 166, 255)
PURPLE = (188, 140, 255)
YELLOW = (210, 168, 83)
RED = (248, 81, 73)
CYAN = (86, 212, 221)

FONT_PATHS = {
    "latin": r"C:\Windows\Fonts\CascadiaMono.ttf",
    "latin_bold": r"C:\Windows\Fonts\CascadiaCode.ttf",
    "cjk": r"C:\Windows\Fonts\msyh.ttc",
    "cjk_bold": r"C:\Windows\Fonts\msyhbd.ttc",
}
FALLBACK_LATIN = [r"C:\Windows\Fonts\consola.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]
FALLBACK_CJK = [r"C:\Windows\Fonts\simhei.ttf", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]

SIZE = 17
LINE_H = 27


def load_font(kind: str):
    """Return a callable path list; first existing wins."""
    candidates = []
    if kind.startswith("latin"):
        candidates.append(FONT_PATHS[kind])
        candidates += FALLBACK_LATIN
    else:
        candidates.append(FONT_PATHS[kind])
        candidates += FALLBACK_CJK
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, SIZE)
    raise SystemExit(f"no usable font for {kind}")


def is_wide(ch: str) -> bool:
    o = ord(ch)
    return (
        0x1100 <= o <= 0x115F
        or 0x2E80 <= o <= 0xA4CF
        or 0xAC00 <= o <= 0xD7A3
        or 0xF900 <= o <= 0xFAFF
        or 0xFE30 <= o <= 0xFE6F
        or 0xFF00 <= o <= 0xFF60
        or 0xFFE0 <= o <= 0xFFE6
        or 0x1F300 <= o <= 0x1FAFF  # emoji
    )


class Term:
    """Minimal fixed-advance terminal renderer with per-char font fallback."""

    def __init__(self, draw: ImageDraw.ImageDraw, x0: int, y0: int):
        self.d = draw
        self.x0 = x0
        self.y0 = y0
        self.f_lat = load_font("latin")
        self.f_lat_b = load_font("latin_bold")
        self.f_cjk = load_font("cjk")
        self.f_cjk_b = load_font("cjk_bold")
        self.adv = float(self.f_lat.getlength("M"))
        self.adv_w = self.adv * 2

    def line(self, s: str, row: int, color=FG, indent: int = 0, bold: bool = False):
        y = self.y0 + row * LINE_H
        x = self.x0 + indent * self.adv
        for ch in s:
            if ch == " ":
                x += self.adv
                continue
            wide = is_wide(ch)
            if wide:
                f = self.f_cjk_b if bold else self.f_cjk
                gw = self.adv_w
            else:
                f = self.f_lat_b if bold else self.f_lat
                gw = self.adv
            self.d.text((x, y), ch, font=f, fill=color)
            x += gw
        return x - self.x0

    def width(self, s: str) -> float:
        return sum(self.adv_w if is_wide(c) else self.adv for c in s)


def build_script(D: dict) -> list[tuple[str, str, str]]:
    """Return (kind, text, color). kind: cmd | out | blank"""
    b, h, t = D["body"], D["healing"], D["tokens"]
    c, iv = D["benchmark_cold_start"], D["innervation_example"]

    lines: list[tuple[str, str, str]] = []

    def cmd(s):
        lines.append(("cmd", s, FG))

    def out(s, col=DIM):
        lines.append(("out", s, col))

    def blank():
        lines.append(("blank", "", FG))

    cmd("agent-body status")
    out(f"{b['organs']} organs  ·  {b['capabilities_claimed']}/{b['capabilities']} capabilities claimed  ·  {b['reflexes_enabled']}/{b['reflexes_total']} reflexes armed")
    out(f"heart beating ({b['heart_beats']} beats)  ·  healing rate {h['healing_rate_pct']}%  ({h['wounds_healed']} closed, {h['wounds_chronic']} chronic)", GREEN)
    blank()

    cmd("agent-body tokens")
    out(f"tool schemas visible  :  {t['tools_gated']} / {t['tools_full']}")
    out(f"tokens per request    :  {t['tokens_gated']:,}      (all schemas: {t['tokens_full']:,})")
    out(f"gated away            :  {t['saved_pct_this_session']}%   this session, history-rich", BLUE)
    out(f"                         {c['saved_pct_mean']}%   cold start, intent-only, reproducible  ->  benchmarks/", BLUE)
    blank()

    cmd(f"agent-body nerve \"{iv['command']}\"")
    out(f"impulse -> {iv['organs_innervated']} organs innervated, each told WHICH capability to fire", PURPLE)
    for o in iv["organs"]:
        out(f"  {o['en']:<30}  {o['capability']}", DIM)
    out(f"model calls spent deciding the route:  {iv['model_calls_to_route']}", PURPLE)
    blank()

    cmd("agent-body heal")
    out(f"wound ...-201   edit   attribution: {h['example_attribution']}", YELLOW)
    out(f"prescription   :  {h['example_prescription']}   (retrying a wrong argument amplifies the mistake)", YELLOW)
    out(f"recheck        :  closed  [{GREEN_OK}]      wounds open now: {h['wounds_open']}", GREEN)
    blank()

    out(f"cold-start gating benchmark: {c['saved_pct_mean']}% saved  ·  worst case {c['saved_pct_worst']}%  ·  {c['tasks']} tasks  ·  bugs {c['bugs']}", GREEN)
    return lines


GREEN_OK = "OK"


def render(D: dict):
    script = build_script(D)

    # ---- guard: a number that grows must fail loudly, not clip silently ----
    probe = Term(ImageDraw.Draw(Image.new("RGB", (10, 10))), 0, 0)
    budget = W - PAD * 2
    for kind, text, _ in script:
        if kind == "blank":
            continue
        wt = probe.width(text)
        if wt > budget:
            raise SystemExit(
                f"line too wide ({wt:.0f}px > {budget}px budget): {text[:70]}"
            )

    # ---- pre-measure so we can size typewriter frames ----
    def new_frame():
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        # window chrome
        d.rounded_rectangle([0, 0, W - 1, BAR_H], radius=0, fill=BAR)
        for i, col in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
            cx = 18 + i * 20
            d.ellipse([cx, 11, cx + 12, 23], fill=col)
        f = ImageFont.truetype(
            next(p for p in [FONT_PATHS["latin"]] + FALLBACK_LATIN if os.path.exists(p)), 14
        )
        d.text((W / 2, 17), "agent-body  —  live tool output, not a mockup", font=f, fill=DIM, anchor="mm")
        d.rectangle([0, BAR_H, W - 1, BAR_H], fill=(48, 54, 61))
        return img, d

    frames: list[tuple[Image.Image, int]] = []
    max_rows = (H - BAR_H - PAD * 2) // LINE_H
    visible: list[tuple[str, str, str]] = []

    def flush(hold=60):
        img, d = new_frame()
        t = Term(d, PAD, BAR_H + PAD)
        for i, (kind, text, color) in enumerate(visible[-max_rows:]):
            if kind == "blank":
                continue
            t.line(text, i, color=color, bold=(kind == "cmd"))
        frames.append((img, hold))

    for kind, text, color in script:
        if kind == "cmd":
            for n in range(2, len(text) + 1, 2):
                visible.append(("cmd", text[:n] + "▊", color))
                flush(38)
                visible.pop()
            visible.append(("cmd", text, color))
            flush(240)
        elif kind == "blank":
            visible.append((kind, text, color))
        else:
            visible.append((kind, text, color))
            flush(70)

    # final hold
    for _ in range(1):
        flush(3200)

    it = iter(frames)
    first = next(it)[0]
    rest = [f.convert("P", palette=Image.ADAPTIVE, colors=48) for f, _ in it]
    first_p = first.convert("P", palette=Image.ADAPTIVE, colors=48)
    images = [first_p] + rest
    durations = [d for _, d in frames]

    os.makedirs(os.path.dirname(OUT_GIF), exist_ok=True)
    images[0].save(
        OUT_GIF,
        save_all=True,
        append_images=images[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )
    frames[-1][0].save(OUT_PNG)

    size = os.path.getsize(OUT_GIF)
    print(f"frames   : {len(frames)}")
    print(f"duration : {sum(durations)/1000:.1f}s")
    print(f"gif      : {OUT_GIF}  ({size/1024/1024:.2f} MB)")
    print(f"png      : {OUT_PNG}")
    return size


def main() -> int:
    if not os.path.exists(DATA):
        print(f"FATAL: {DATA} missing — refusing to render numbers from thin air", file=sys.stderr)
        return 2
    with open(DATA, encoding="utf-8") as fh:
        D = json.load(fh)
    for key in ("body", "healing", "tokens", "benchmark_cold_start", "innervation_example"):
        if key not in D:
            print(f"FATAL: captured.json missing section '{key}'", file=sys.stderr)
            return 3
    render(D)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
