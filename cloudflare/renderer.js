// E-Ink Briefing · 纯 JS 1-bit 位图渲染器（v2 报纸风）
// 输出：800×480 (或其他 width×height) 的 1-bit 位图，行主序、MSB-first、1=墨黑 0=纸白
// 布局：紧凑日期/重点未读数，主待办+截止日期列，次要天气栏；网页复用同一位图。
// 字体：32×32 CJK + 16×32 ASCII（Songti SC 位图）

import { FONT_W, FONT_H, ASCII_W, ASCII_H, getGlyph, getAscii, isAscii } from "./font_data.js";
import {getGlyph as getCompactGlyph, getAscii as getCompactAscii} from "./font_compact_data.js";
import {getGlyph as getSmallGlyph, getAscii as getSmallAscii} from "./font_small_data.js";

/* ============================================================
   Bitmap — 1-bit off-screen canvas
   ============================================================ */
export class Bitmap {
  constructor(w, h) {
    this.w = w | 0;
    this.h = h | 0;
    this.bpr = (this.w + 7) >> 3;        // bytes per row
    this.buf = new Uint8Array(this.bpr * this.h); // 0=白, 1=黑
  }
  inB(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  setPixel(x, y, v = 1) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    if (v) this.buf[y * this.bpr + (x >> 3)] |= 0x80 >> (x & 7);
    else   this.buf[y * this.bpr + (x >> 3)] &= ~(0x80 >> (x & 7));
  }
  fillRect(x, y, w, h, v = 1) {
    x |= 0; y |= 0; w |= 0; h |= 0;
    if (w <= 0 || h <= 0) return;
    const x1 = Math.max(x, 0), y1 = Math.max(y, 0);
    const x2 = Math.min(x + w, this.w), y2 = Math.min(y + h, this.h);
    for (let yy = y1; yy < y2; yy++) {
      const rowOff = yy * this.bpr;
      const bxStart = (x1 + 7) >> 3;
      const bxEnd = x2 >> 3;
      if (bxStart < bxEnd) {
        for (let xx = x1; xx < bxStart << 3; xx++) {
          if (v) this.buf[rowOff + (xx >> 3)] |= 0x80 >> (xx & 7);
          else   this.buf[rowOff + (xx >> 3)] &= ~(0x80 >> (xx & 7));
        }
        const fill = v ? 0xFF : 0x00;
        for (let b = bxStart; b < bxEnd; b++) this.buf[rowOff + b] = fill;
        for (let xx = bxEnd << 3; xx < x2; xx++) {
          if (v) this.buf[rowOff + (xx >> 3)] |= 0x80 >> (xx & 7);
          else   this.buf[rowOff + (xx >> 3)] &= ~(0x80 >> (xx & 7));
        }
      } else {
        for (let xx = x1; xx < x2; xx++) {
          if (v) this.buf[rowOff + (xx >> 3)] |= 0x80 >> (xx & 7);
          else   this.buf[rowOff + (xx >> 3)] &= ~(0x80 >> (xx & 7));
        }
      }
    }
  }
  drawHLine(x, y, w, t = 1) { this.fillRect(x, y, w, t); }
  drawVLine(x, y, h, t = 1) { this.fillRect(x, y, t, h); }
  drawRect(x, y, w, h, t = 1) {
    if (w <= 0 || h <= 0) return;
    this.fillRect(x, y, w, t);
    this.fillRect(x, y + h - t, w, t);
    this.fillRect(x, y, t, h);
    this.fillRect(x + w - t, y, t, h);
  }
  drawLine(x0, y0, x1, y1, thick = 1) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    const t = Math.max(1, thick | 0);
    const half = (t - 1) >> 1;
    while (true) {
      if (t === 1) this.setPixel(x0, y0);
      else this.fillRect(x0 - half, y0 - half, t, t);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx)  { err += dx; y0 += sy; }
    }
  }
  drawDisk(cx, cy, r) {
    cx |= 0; cy |= 0; r |= 0;
    if (r <= 0) { this.setPixel(cx, cy); return; }
    for (let dy = -r; dy <= r; dy++) {
      const dx = Math.floor(Math.sqrt(r * r - dy * dy));
      this.drawHLine(cx - dx, cy + dy, 2 * dx + 1);
    }
  }
  drawCircle(cx, cy, r, t = 2) {
    cx |= 0; cy |= 0; r |= 0;
    if (r <= 0) return;
    let x = r, y = 0, err = -r;
    while (x >= y) {
      const pts = [[cx + x, cy + y], [cx - x, cy + y], [cx + x, cy - y], [cx - x, cy - y],
                   [cx + y, cy + x], [cx - y, cy + x], [cx + y, cy - x], [cx - y, cy - x]];
      for (const [px, py] of pts) this.fillRect(px - ((t - 1) >> 1), py - ((t - 1) >> 1), t, t);
      y++;
      if (err <= 0) err += 2 * y + 1;
      if (err > 0)  { x--; err -= 2 * x + 1; }
    }
  }

  drawGlyph(x, y, glyph, gw, gh, scale = 1) {
    const gbpr = (gw + 7) >> 3;
    const sc = Math.max(1, scale | 0);
    if (sc === 1) {
      for (let yy = 0; yy < gh; yy++) {
        const rowOff = yy * gbpr;
        for (let xx = 0; xx < gw; xx++) {
          if (glyph[rowOff + (xx >> 3)] & (0x80 >> (xx & 7))) this.setPixel(x + xx, y + yy);
        }
      }
    } else {
      for (let yy = 0; yy < gh; yy++) {
        const rowOff = yy * gbpr;
        for (let xx = 0; xx < gw; xx++) {
          if (glyph[rowOff + (xx >> 3)] & (0x80 >> (xx & 7)))
            this.fillRect(x + xx * sc, y + yy * sc, sc, sc);
        }
      }
    }
  }

  drawText(x, y, str, scale = 1) {
    let cx = x | 0;
    const sc = Math.max(1, scale | 0);
    for (const ch of str) {
      if (ch === " " || ch === "\u3000") { cx += ASCII_W * sc; continue; }
      if (ch === "\t")                    { cx += ASCII_W * sc * 4; continue; }
      if (isAscii(ch)) {
        const g = getAscii(ch);
        if (g) { this.drawGlyph(cx, y, g, ASCII_W, FONT_H, sc); cx += ASCII_W * sc; }
        else   { cx += ASCII_W * sc; }
      } else {
        const g = getGlyph(ch);
        if (g) { this.drawGlyph(cx, y, g, FONT_W, FONT_H, sc); cx += FONT_W * sc; }
        else   { cx += FONT_W * sc; }
      }
    }
    return cx;
  }

  measureText(str, scale = 1) {
    const sc = Math.max(1, scale | 0);
    let w = 0;
    for (const ch of str) {
      if (ch === " " || ch === "\u3000") { w += ASCII_W * sc; continue; }
      if (ch === "\t")                    { w += ASCII_W * sc * 4; continue; }
      w += (isAscii(ch) ? ASCII_W : FONT_W) * sc;
    }
    return w;
  }

  // 右对齐文本：返回绘制的起点 x
  drawTextRight(rightX, y, str, scale = 1) {
    const w = this.measureText(str, scale);
    return this.drawText(rightX - w, y, str, scale);
  }

  // 反白文本（用于黑底上显示"白字"）：把字的像素清为白
  drawTextInverse(x, y, str, scale = 1) {
    const w = this.measureText(str, scale);
    const h = FONT_H * Math.max(1, scale | 0);
    const tmp = new Bitmap(w, h);
    tmp.drawText(0, 0, str, scale);
    for (let yy = 0; yy < h; yy++) {
      const rowOff = yy * tmp.bpr;
      for (let xx = 0; xx < w; xx++) {
        if (tmp.buf[rowOff + (xx >> 3)] & (0x80 >> (xx & 7)))
          this.setPixel(x + xx, y + yy, 0);
      }
    }
  }

  // 居中文本
  drawTextCenter(cx, y, str, scale = 1) {
    const w = this.measureText(str, scale);
    return this.drawText(cx - (w / 2 | 0), y, str, scale);
  }
  drawTextCenterInverse(cx, y, str, scale = 1) {
    const w = this.measureText(str, scale);
    this.drawTextInverse(cx - (w / 2 | 0), y, str, scale);
  }

  // Native 24px glyphs preserve strokes instead of discarding every other pixel.
  drawSmall(x, y, str) {
    let cx = x | 0;
    for (const ch of str) {
      const ascii = ch === " " || isAscii(ch);
      const g = ascii ? getSmallAscii(ch) : getSmallGlyph(ch);
      if (g) this.drawGlyph(cx, y, g, ascii ? 12 : 24, 24);
      cx += ascii ? 12 : 24;
    }
    return cx;
  }
  drawCompact(x, y, str) {
    let cx = x | 0;
    for (const ch of str) {
      const ascii = ch === " " || isAscii(ch);
      const g = ascii ? getCompactAscii(ch) : getCompactGlyph(ch);
      if (g) this.drawGlyph(cx, y, g, ascii ? 10 : 20, 20);
      cx += ascii ? 10 : 20;
    }
    return cx;
  }
  drawSmallRight(rightX, y, str) {
    return this.drawSmall(rightX - this.measureText(str) * 0.75, y, str);
  }

}

/* ============================================================
   天气图标 — 几何绘制
   ============================================================ */
function drawSun(bm, ox, oy, s) {
  const cx = ox + s * 0.50, cy = oy + s * 0.50, r = s * 0.18;
  bm.drawDisk(cx, cy, r);
  const rIn = r * 1.7, rOut = s * 0.46;
  const t = Math.max(2, Math.round(s / 20));
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    bm.drawLine(cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn,
                cx + Math.cos(a) * rOut, cy + Math.sin(a) * rOut, t);
  }
}
function drawCloudBody(bm, ox, oy, s, baselineFrac = 0.50) {
  const cy = oy + s * baselineFrac;
  bm.drawDisk(ox + s * 0.32, cy,           s * 0.16);
  bm.drawDisk(ox + s * 0.52, cy - s * 0.06, s * 0.21);
  bm.drawDisk(ox + s * 0.72, cy,           s * 0.15);
  bm.fillRect(ox + s * 0.22, cy, s * 0.60, s * 0.10);
}
function drawCloudSun(bm, ox, oy, s) {
  const scx = ox + s * 0.28, scy = oy + s * 0.26, r = s * 0.12;
  bm.drawDisk(scx, scy, r);
  const t = Math.max(2, Math.round(s / 20));
  for (let i = 4; i <= 7; i++) {
    const a = i * Math.PI / 4;
    bm.drawLine(scx + Math.cos(a) * r * 1.6, scy + Math.sin(a) * r * 1.6,
                scx + Math.cos(a) * r * 2.3, scy + Math.sin(a) * r * 2.3, t);
  }
  drawCloudBody(bm, ox + s * 0.18, oy + s * 0.08, s * 0.85, 0.55);
}
function drawCloud(bm, ox, oy, s) { drawCloudBody(bm, ox, oy, s, 0.50); }
function drawFog(bm, ox, oy, s) {
  drawCloudBody(bm, ox, oy, s * 0.95, 0.40);
  const t = Math.max(2, Math.round(s / 20));
  bm.fillRect(ox + s * 0.10, oy + s * 0.66, s * 0.80, t);
  bm.fillRect(ox + s * 0.18, oy + s * 0.78, s * 0.64, t);
}
function drawRain(bm, ox, oy, s) {
  drawCloudBody(bm, ox, oy, s * 0.90, 0.36);
  const t = Math.max(2, Math.round(s / 20));
  for (let i = 0; i < 3; i++) {
    const dx = ox + s * (0.30 + i * 0.16), dy = oy + s * 0.55;
    bm.drawLine(dx, dy, dx - 6, dy + Math.floor(s * 0.22), t);
  }
}
function drawSnow(bm, ox, oy, s) {
  drawCloudBody(bm, ox, oy, s * 0.90, 0.36);
  const t = Math.max(2, Math.round(s / 20));
  for (let i = 0; i < 3; i++) {
    const cx = ox + s * (0.30 + i * 0.16), cy = oy + s * 0.66;
    const rr = Math.max(3, s * 0.06);
    bm.drawLine(cx - rr, cy, cx + rr, cy, t);
    bm.drawLine(cx - rr * 0.7, cy - rr * 0.7, cx + rr * 0.7, cy + rr * 0.7, t);
    bm.drawLine(cx - rr * 0.7, cy + rr * 0.7, cx + rr * 0.7, cy - rr * 0.7, t);
  }
}
function drawStorm(bm, ox, oy, s) {
  drawCloudBody(bm, ox, oy, s * 0.85, 0.34);
  const t = Math.max(2, Math.round(s / 20));
  const lx = ox + s * 0.45, ly = oy + s * 0.50;
  bm.drawLine(lx, ly, lx - s * 0.06, ly + s * 0.12, t);
  bm.drawLine(lx - s * 0.06, ly + s * 0.12, lx + s * 0.04, ly + s * 0.18, t);
  bm.drawLine(lx + s * 0.04, ly + s * 0.18, lx - s * 0.04, ly + s * 0.32, t);
}

const ICON_DRAW = {
  sun: drawSun, cloudsun: drawCloudSun, cloud: drawCloud,
  fog: drawFog, rain: drawRain, snow: drawSnow, storm: drawStorm,
};

// 紫外线等级 → 中文
function uvLevel(uv) {
  const v = Number(uv) || 0;
  if (v < 3) return "弱";
  if (v < 6) return "中等";
  if (v < 8) return "强";
  if (v < 11) return "很强";
  return "极强";
}

/* ============================================================
   渲染入口：renderDisplay(state, width, height) → Uint8Array
   ============================================================ */
export function renderDisplay(state, width, height) {
  const bm = new Bitmap(width, height);
  const PAD = width < 400 ? 12 : 16;
  const innerW = width - PAD * 2;
  const { config: cfg, weekday, date, mail, weather, motto } = state;
  const measure = (text, size = 32) => bm.measureText(String(text)) * size / 32;
  const fit = (text, maxW, size = 32) => {
    let chars = Array.from(String(text || ""));
    if (measure(chars.join(''), size) <= maxW) return chars.join('');
    while (chars.length && measure(chars.join('') + '...', size) > maxW) chars.pop();
    return chars.length ? chars.join('') + '...' : '';
  };
  const compact = (x,y,text,w) => bm.drawCompact(x,y,fit(text,w,20));
  const narrow = width < 600;
  const mailW = narrow ? 160 : 224;
  const mx = width - PAD - mailW;
  compact(PAD, PAD + 10, `${date.replaceAll('-','.')} 周${weekday}`, innerW-mailW-16);
  const count = mail?.unreadCount;
  const known = Number.isSafeInteger(count) && count >= 0;
  const stale = mail?.stale || mail?.error;
  const label = known ? `${narrow ? '未读' : '未读邮件'} ${count}` : '邮件未连接';
  if (known && !stale && count > 0) {
    bm.fillRect(mx, PAD, mailW, 40);
    bm.drawTextInverse(mx + 8, PAD + 4, fit(label,mailW-16));
  } else {
    compact(mx+8,PAD+4,known && stale ? `上次未读 ${count}` : label,mailW-16);
    if (stale) compact(mx+8,PAD+24,'同步待更新',mailW-16);
  }

  const top = PAD + 52, gap = 18;
  const footerTop = height - PAD - 30;
  const weatherW = Math.max(100, Math.min(140,Math.floor(innerW*0.15)));
  const todoW = innerW-weatherW-gap, wx = PAD+todoW+gap;
  const todos=(cfg.todos||[]).filter(todo=>!todo.done);
  const dateLabels=todos.map(todo=>{
    const timestamp=todo.dueAt||todo.createdAt;
    if(!timestamp)return '';
    const day=new Date(timestamp+8*3600000).toISOString().slice(0,10);
    return (day.slice(0,4)===date.slice(0,4)?day.slice(5):day.slice(2)).replaceAll('-','/')+(todo.dueAt?'':'*');
  });
  const dateW = Math.max(60,...dateLabels.map(label=>measure(label,20))), inlineDate = todoW >= 480;
  bm.drawHLine(PAD,top-6,innerW,2);
  bm.fillRect(PAD,top+6,4,24);
  bm.drawText(PAD+12,top,'待办');
  if (inlineDate) compact(PAD+todoW-dateW,top+8,'截止',dateW);
  bm.drawHLine(PAD,top+38,todoW,1);
  bm.drawVLine(wx-gap/2,top,footerTop-top-10);

  const textX=PAD+36, textW=todoW-36-(inlineDate?dateW+14:0);
  let y=top+46, shown=0, hasCreation=false;
  const bottom=footerTop-26;
  for (const [index,todo] of todos.entries()) {
    const dateLabel=dateLabels[index];
    const chars=Array.from(String(todo.text||'')),lines=[];
    while(chars.length && lines.length<2){
      let line='';
      while(chars.length && measure(line+chars[0])<=textW)line+=chars.shift();
      if(!line){chars.shift();break;}
      lines.push(line);
    }
    if(!lines.length)lines.push('');
    if(chars.length)lines[lines.length-1]=fit(lines.at(-1)+'...',textW);
    const rowH=lines.length*34+8+(!inlineDate && dateLabel?22:0);
    if(y+rowH>bottom)break;
    compact(PAD,y+7,`${index+1}.`,32);
    lines.forEach((line,i)=>bm.drawText(textX,y+i*34,line));
    if(dateLabel){
      if(inlineDate)compact(PAD+todoW-dateW,y+7,dateLabel,dateW);
      else compact(textX,y+lines.length*34,dateLabel,todoW-36);
      if(!todo.dueAt)hasCreation=true;
    }
    y+=rowH;shown++;
  }
  if(!todos.length)compact(PAD,top+64,'暂无待办',todoW);
  if(shown<todos.length)compact(PAD,footerTop-24,`+${todos.length-shown}`,70);
  if(state.tasks?.error)compact(PAD+72,footerTop-24,'同步待更新',todoW-72);
  if(hasCreation && !state.tasks?.error)compact(PAD+todoW-110,footerTop-24,'* 创建日期',110);

  compact(wx,top+8,cfg.city.name,weatherW);
  bm.drawHLine(wx,top+38,weatherW,1);
  let wy=top+48;
  if(!weather || weather.error) {
    compact(wx,wy,'天气暂不可用',weatherW);
  } else {
    bm.drawText(wx,wy,fit(`${weather.temp}°`,weatherW));
    bm.drawSmall(wx,wy+36,fit(weather.desc,weatherW,24));
    wy+=76;
    for(const [i,day] of (weather.days||[]).slice(1,3).entries()){
      if(wy+66>footerTop-10)break;
      bm.drawHLine(wx,wy-6,weatherW,1);
      compact(wx,wy,i?'后天':'明天',weatherW);
      compact(wx,wy+22,day.desc,weatherW);
      compact(wx,wy+44,`${day.lo}°/${day.hi}°`,weatherW);
      wy+=78;
    }
  }
  bm.drawHLine(PAD,footerTop,innerW,1);
  compact(PAD,footerTop+8,motto||cfg.motto||'',innerW);
  return bm.buf;
}

// BMP is a lossless container around the exact device pixels, not a second layout.
export function bitmapToBMP(pixels, width, height) {
  const sourceStride = Math.ceil(width / 8), stride = Math.ceil(width / 32) * 4;
  const out = new Uint8Array(62 + stride * height), view = new DataView(out.buffer);
  out[0] = 66; out[1] = 77;
  view.setUint32(2, out.length, true); view.setUint32(10, 62, true);
  view.setUint32(14, 40, true); view.setInt32(18, width, true); view.setInt32(22, height, true);
  view.setUint16(26, 1, true); view.setUint16(28, 1, true);
  view.setUint32(34, stride * height, true); view.setUint32(46, 2, true);
  out.set([255,255,255,0, 0,0,0,0], 54);
  for (let row = 0; row < height; row++) out.set(pixels.subarray(row * sourceStride, (row + 1) * sourceStride), 62 + (height - 1 - row) * stride);
  return out;
}

/* 日出小图标：半圆 + 3 条上射线 */
function drawSunrise(bm, x, y, s) {
  const cx = x + s / 2, cy = y + s - 4;
  const r = s * 0.32;
  for (let dy = 0; dy <= r; dy++) {
    const dx = Math.floor(Math.sqrt(r * r - dy * dy));
    bm.drawHLine(cx - dx, cy - dy, 2 * dx + 1);
  }
  const t = 2;
  bm.drawHLine(x, cy + 3, s, t);
  for (let i = -1; i <= 1; i++) {
    const a = -Math.PI / 2 + i * 0.6;
    bm.drawLine(cx + Math.cos(a) * r * 1.5, cy + Math.sin(a) * r * 1.5,
                cx + Math.cos(a) * r * 2.1, cy + Math.sin(a) * r * 2.1, t);
  }
}
/* 日落小图标：半圆 + 向下箭头 */
function drawSunset(bm, x, y, s) {
  const cx = x + s / 2, cy = y + s - 4;
  const r = s * 0.32;
  for (let dy = 0; dy <= r; dy++) {
    const dx = Math.floor(Math.sqrt(r * r - dy * dy));
    bm.drawHLine(cx - dx, cy - dy, 2 * dx + 1);
  }
  bm.drawHLine(x, cy + 3, s, 2);
  // 向下箭头
  bm.drawLine(cx, cy - r - 2, cx, cy - r - 8, 2);
  bm.drawLine(cx - 3, cy - r - 5, cx, cy - r - 2, 2);
  bm.drawLine(cx, cy - r - 2, cx + 3, cy - r - 5, 2);
}

/* ============================================================
   调试：PBM 输出
   ============================================================ */
export function toPBM(buf, w, h) {
  const bpr = (w + 7) >> 3;
  const head = `P1\n${w} ${h}\n`;
  let body = "";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const byte = buf[y * bpr + (x >> 3)];
      body += (byte & (0x80 >> (x & 7))) ? "1" : "0";
    }
    body += "\n";
  }
  return head + body;
}
