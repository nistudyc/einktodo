#!/usr/bin/env python3
"""把 logo_font.h 里的点阵渲染成 ASCII 预览，肉眼确认字形正确。"""
import re, os

SRC = os.path.join(os.path.dirname(__file__), "..", "firmware-src", "src", "logo_font.h")
txt = open(SRC, encoding="utf-8").read()

blocks = re.findall(r"// U\+([0-9A-F]{4}) .\nstatic const uint8_t GM_[0-9A-F]{4}\[LOGO_FONT_BYTES\] PROGMEM = \{([^}]+)\};", txt)
assert blocks, "no glyph blocks found"

for code, body in blocks:
    data = bytes(int(x, 16) for x in re.findall(r"0x([0-9A-F]{2})", body))
    print(f"U+{code}")
    for row in range(32):
        line = ""
        for colb in range(4):
            b = data[row * 4 + colb]
            for bit in range(8):
                line += "#" if (b >> (7 - bit)) & 1 else "."
        print(line)
    print()
