#!/usr/bin/env python3
"""生成开机画面预览 PNG（模拟固件 showLaunchScreen 的排版）。"""
import os
import struct
import zlib

SRC = os.path.join(os.path.dirname(__file__), "..", "firmware-src", "src", "logo_font.h")
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "launch-screen.png")

W, H = 480, 800  # 固件 rotation 0：480 宽 800 高
import re

txt = open(SRC, encoding="utf-8").read()
glyphs = {}
for code, body in re.findall(
    r"// U\+([0-9A-F]{4}) .\nstatic const uint8_t GM_[0-9A-F]{4}\[LOGO_FONT_BYTES\] PROGMEM = \{([^}]+)\};",
    txt,
):
    glyphs[code] = bytes(int(x, 16) for x in re.findall(r"0x([0-9A-F]{2})", body))

# 5x7 点阵字体（size 2 = 10x14）用于 "ink.nickming.top"，逐字符造字
FONT57 = {
    '.': ["01110", "10001", "10001", "10001", "01110", "00000", "00000"],
    'i': ["00100", "00100", "00100", "00100", "00100", "00000", "00000"],
    'n': ["00000", "01110", "10001", "10001", "10001", "10001", "00000"],
    'k': ["10000", "10001", "10010", "10100", "11001", "10001", "00000"],
    'c': ["00000", "01110", "10001", "10000", "10000", "01110", "00000"],
    '.': ["00000", "00000", "00110", "00110", "00000", "00000", "00000"],
    'm': ["00000", "11101", "10101", "10101", "10101", "10101", "00000"],
    'g': ["00000", "01110", "10001", "10001", "10011", "01101", "00001"],
    't': ["00100", "00100", "01110", "00100", "00100", "00110", "00000"],
    'o': ["00000", "01110", "10001", "10001", "10001", "01110", "00000"],
    'p': ["00000", "11110", "10001", "10001", "11110", "10000", "10000"],
}

def draw5x7(px, ch, x0, y0, scale=2):
    rows = FONT57.get(ch)
    if not rows:
        return 6 * scale
    for r, line in enumerate(rows):
        for c, bit in enumerate(line):
            if bit == '1':
                for dy in range(scale):
                    for dx in range(scale):
                        px(x0 + c * scale + dx, y0 + r * scale + dy)
    return 6 * scale

# 位图：0 = 白, 1 = 黑
buf = [[0] * W for _ in range(H)]

def px(x, y):
    if 0 <= x < W and 0 <= y < H:
        buf[y][x] = 1

cy = H // 2
logo = "墨屏日报"
order = ["58A8", "5C4F", "65E5", "62A5"]  # 墨 屏 日 报
GW = 32
logoW = len(order) * GW
lx = (W - logoW) // 2
ly = cy - GW - 8
for i, code in enumerate(order):
    data = glyphs[code]
    gx = lx + i * GW
    for row in range(32):
        for colb in range(4):
            b = data[row * 4 + colb]
            for bit in range(8):
                if (b >> (7 - bit)) & 1:
                    px(gx + colb * 8 + bit, ly + row)

site = "ink.nickming.top"
char_w = 6 * 2
site_w = len(site) * char_w
sx = (W - site_w) // 2
for ch in site:
    sx += draw5x7(px, ch, sx, cy + 12)

# 写 PNG（1-bit 灰度）
raw = b""
for y in range(H):
    row = bytearray([0])  # filter type 0
    for xb in range((W + 7) // 8):
        byte = 0
        for k in range(8):
            x = xb * 8 + k
            if x < W and buf[y][x]:
                byte |= 0x80 >> k
        row.append(byte ^ 0xFF if False else byte)
    raw += bytes([0]) + row[1:]

def chunk(tag, data):
    c = tag + data
    return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

ihdr = struct.pack(">IIBBBBB", W, H, 8, 0, 0, 0, 0)
# 用 8-bit 灰度更简单：0=黑 255=白
gray = bytearray()
for y in range(H):
    gray.append(0)
    for x in range(W):
        gray.append(0 if buf[y][x] else 255)

png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", ihdr)
png += chunk(b"IDAT", zlib.compress(bytes(gray), 9))
png += chunk(b"IEND", b"")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "wb").write(png)
print(f"OK -> {OUT} ({W}x{H})")
