// E-Ink Briefing · Cloudflare Worker 后端
// 职责：静态页面 + 配置/Todo API(KV) + 天气代理(Open-Meteo) + 农历 + 接收邮件桥推送
//       + /api/display/v2 纯 JS 1-bit 位图渲染（设备直取）
// 绑定：KV namespace einktodo 配置为 [kv_namespaces] EINK_KV

import { renderDisplay, bitmapToBMP } from "./renderer.js";
import { authService, sessionOK, secretEqual, reply } from "./auth.js";
import { ownerKV } from "./private-kv.js";
import { mailStatus } from "./mail-sync.js";
import { dailyMotto } from "./mottos.js";
export { OwnerAuth } from "./auth.js";

const DEFAULT_CONFIG = {
  city: { name: "佛山", lat: 23.0218, lon: 113.1219 },
  layout: "landscape",
  clock: true,
  mailMax: 7,
  refreshSec: 60,
  motto: "把重要的事放在纸上，其余的交给时间。",
  todos: [],
};

/* ---------- 农历：月锚点表（由 lunardate 生成，覆盖 2026-01-01 ~ 2030-12-31） ---------- */
const LUNAR_BASE = Date.UTC(2026, 0, 1) / 86400000; // Unix 天
// [offsetDays, lunarMonth(负=闰), lunarYear]
const LUNAR_MONTHS = [[18,12,2025],[47,1,2026],[77,2,2026],[106,3,2026],[135,4,2026],[165,5,2026],[194,6,2026],[223,7,2026],[253,8,2026],[282,9,2026],[311,10,2026],[341,11,2026],[370,12,2026],[399,1,2027],[429,2,2027],[458,3,2027],[487,4,2027],[517,5,2027],[547,6,2027],[576,7,2027],[605,8,2027],[635,9,2027],[664,10,2027],[693,11,2027],[723,12,2027],[752,1,2028],[782,2,2028],[811,3,2028],[840,4,2028],[870,5,2028],[900,6,2028],[929,7,2028],[958,8,2028],[988,9,2028],[1017,10,2028],[1046,11,2028],[1076,12,2028],[1105,1,2029],[1135,2,2029],[1164,3,2029],[1193,4,2029],[1223,5,2029],[1252,6,2029],[1282,7,2029],[1311,8,2029],[1340,9,2029],[1370,10,2029],[1399,11,2029],[1429,12,2029],[1458,1,2030],[1488,2,2030],[1517,3,2030],[1546,4,2030],[1576,5,2030],[1605,6,2030],[1635,7,2030],[1664,8,2030],[1693,9,2030],[1723,10,2030],[1752,11,2030],[1782,12,2030]];
const LM = ["正月","二月","三月","四月","五月","六月","七月","八月","九月","十月","冬月","腊月"];
const LD = ["初一","初二","初三","初四","初五","初六","初七","初八","初九","初十","十一","十二","十三","十四","十五","十六","十七","十八","十九","二十","廿一","廿二","廿三","廿四","廿五","廿六","廿七","廿八","廿九","三十"];
const GAN = "甲乙丙丁戊己庚辛壬癸", ZHI = "子丑寅卯辰巳午未申酉戌亥";

function lunarStr(d) {
  const off = Math.floor(d.getTime() / 86400000) - LUNAR_BASE;
  if (off < LUNAR_MONTHS[0][0] || off > 1830) return null; // 超出表范围
  let mi = 0;
  for (let i = 0; i < LUNAR_MONTHS.length; i++) if (LUNAR_MONTHS[i][0] <= off) mi = i;
  const [mOff, m, y] = LUNAR_MONTHS[mi];
  const day = off - mOff; // 0-based
  const gan = GAN[(y - 4) % 10], zhi = ZHI[(y - 4) % 12];
  const mm = m < 0 ? "闰" + LM[-m - 1] : LM[m - 1];
  return `${gan}${zhi}年 ${mm}${LD[day]}`;
}

/* ---------- 天气 ---------- */
const WMO = {
  0:["晴","sun"],1:["晴","sun"],2:["多云","cloudsun"],3:["阴","cloud"],
  45:["雾","fog"],48:["雾凇","fog"],
  51:["毛毛雨","rain"],53:["毛毛雨","rain"],55:["毛毛雨","rain"],
  61:["小雨","rain"],63:["中雨","rain"],65:["大雨","rain"],66:["冻雨","rain"],67:["冻雨","rain"],
  71:["小雪","snow"],73:["中雪","snow"],75:["大雪","snow"],77:["雪粒","snow"],
  80:["阵雨","rain"],81:["阵雨","rain"],82:["暴雨","rain"],
  85:["阵雪","snow"],86:["阵雪","snow"],
  95:["雷雨","storm"],96:["雷雨","storm"],99:["雷雨","storm"],
};
const WIND = ["北","东北偏北","东北","东北偏东","东","东南偏东","东南","东南偏南","南","西南偏南","西南","西南偏西","西","西北偏西","西北","西北偏北"];

async function fetchWeather(city, env) {
  const key = `wx:${city.lat.toFixed(3)},${city.lon.toFixed(3)}`;
  const cached = await env.EINK_KV.get(key);
  if (cached) { try { return JSON.parse(cached); } catch {} }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_probability_max,sunrise,sunset` +
    `&timezone=auto&forecast_days=4`;
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error("weather unavailable");
  const data = await response.json();
  const c = data.current, d = data.daily;
  const [desc, icon] = WMO[c.weather_code] || ["未知", "cloud"];
  const wd = WIND[Math.round(c.wind_direction_10m) % 16];
  const hm = s => (s || "").slice(11, 16); // "2026-10-27T06:12" → "06:12"
  const out = {
    temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature),
    humidity: Math.round(c.relative_humidity_2m),
    wind: `${wd}风 ${Math.round(c.wind_speed_10m)}km/h`,
    desc, icon, uv: Math.round(d.uv_index_max[0]),
    rain: d.precipitation_probability_max?.[0] || 0,
    sunrise: hm(d.sunrise?.[0]), sunset: hm(d.sunset?.[0]),
    days: d.time.slice(0, 4).map((t, i) => ({
      date: t, desc: (WMO[d.weather_code[i]] || ["", "cloud"])[0],
      hi: Math.round(d.temperature_2m_max[i]), lo: Math.round(d.temperature_2m_min[i]),
    })),
  };
  await env.EINK_KV.put(key, JSON.stringify(out), { expirationTtl: 900 });
  return out;
}

/* ---------- 邮件桥写入 ---------- */
function bearerOk(req, env) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return secretEqual(token, env.BRIDGE_TOKEN);
}

/* ---------- 飞书事件回调（接收邮件事件，把未读写入 KV） ---------- */
const ENC = new TextEncoder(), DEC = new TextDecoder();
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

async function feishuDecrypt(encryptKey, b64) {
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const key = new Uint8Array(await crypto.subtle.digest("SHA-256", ENC.encode(encryptKey)));
  const ck = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: raw.slice(0, 16) }, ck, raw.slice(16));
  return JSON.parse(DEC.decode(pt));
}

async function handleFeishuEvent(request, env) {
  // Only authenticated encrypted Feishu events are accepted; plaintext callbacks fail closed.
  if (!env.FEISHU_ENCRYPT_KEY) return json({ error: "event authentication not configured" }, 503);
  const rawBody = await request.text();
  const timestamp = request.headers.get("X-Lark-Request-Timestamp");
  const nonce = request.headers.get("X-Lark-Request-Nonce");
  const signature = request.headers.get("X-Lark-Signature");
  if (!timestamp || !nonce || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !Number.isFinite(Number(timestamp))) return json({ error: "unauthorized" }, 401);
  const digest = await crypto.subtle.digest("SHA-256", ENC.encode(timestamp + nonce + env.FEISHU_ENCRYPT_KEY + rawBody));
  const expected = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  if (!await secretEqual(signature, expected)) return json({ error: "unauthorized" }, 401);
  const body = JSON.parse(rawBody);
  if (!body.encrypt) return json({ error: "encrypted event required" }, 400);
  // 加密模式：解密
  let payload = body;
  if (body.encrypt && env.FEISHU_ENCRYPT_KEY) {
    try { payload = await feishuDecrypt(env.FEISHU_ENCRYPT_KEY, body.encrypt); } catch (e) { return json({ error: "decrypt" }, 400); }
  }
  // URL 校验
  if (payload.type === "url_verification") return json({ challenge: payload.challenge });

  const et = payload.header?.event_type || "";
  // 邮件接收事件：mail.message.received_v1 / mail.user_mailbox.event.message_received_v1 等
  if (/mail.*received|message_received/i.test(et)) {
    const result = await authService(env).fetch(new Request("https://internal/internal/mail-sync", { method: "POST" }));
    if (!result.ok) return result;
  }
  // Only retain callback status, never email content.
  await env.EINK_KV.put("feishu:last", JSON.stringify({ ts: Date.now(), event_type: et, accepted: true }).slice(0, 10000));
  return json({ code: 0 });
}

/* ---------- 状态聚合（/api/state 与 /api/display/v2 共用） ---------- */
async function gatherState(env) {
  let cfg = await env.EINK_KV.get("config", { type: "json" });
  if (!cfg) { cfg = DEFAULT_CONFIG; await env.EINK_KV.put("config", JSON.stringify(cfg)); }
  const mail = mailStatus(await env.EINK_KV.get("mail", { type: "json" }));
  const tasks = await env.EINK_KV.get("tasks", {type:"json"});
  if (tasks?.connected) cfg = {...cfg, todos:tasks.todos || []};
  const weather = await fetchWeather(cfg.city, env).catch(e => ({ error: String(e) }));
  const nowCN = new Date(Date.now() + 8 * 3600e3);
  const today = new Date(Date.UTC(nowCN.getUTCFullYear(), nowCN.getUTCMonth(), nowCN.getUTCDate()));
  return {
    config: cfg,
    lunar: lunarStr(today),
    issue: Math.floor((today - new Date(today.getUTCFullYear(), 0, 0)) / 86400000),
    weekday: "日一二三四五六"[today.getUTCDay()],
    date: today.toISOString().slice(0, 10),
    motto: dailyMotto(today.toISOString().slice(0, 10)),
    mail, weather,
    tasks: {connected:!!tasks?.connected, syncedAt:tasks?.syncedAt || null, error:tasks?.error || (tasks?.connected && (!tasks.syncedAt || Date.now()-tasks.syncedAt>600000) ? "飞书待办同步待更新" : null)},
    unread: Number.isSafeInteger(mail.unreadCount) ? mail.unreadCount : null,
    updated: new Date().toLocaleTimeString("zh-CN", {
      timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit",
    }),
    nowCN,
    now: new Date().toISOString(),
  };
}

/* ---------- 设备位图端点 /api/display/v2 ----------
   协议（esonwong/e-ink-todo-list 固件）：
   - GET ?width=&height=，Header Authorization: Bearer {设备密钥}
   - 响应体 = 原始 1-bit 位图（8 px/byte, MSB-first, row-major）
   - 响应头 Content-Picture-Width / Content-Picture-Height / Last-Modified
   - HTTP 200（有新图）/ 304（未变化）/ 401（鉴权失败）/ 204（无内容）
*/
function httpDate(d) {
  // RFC 7231 IMF-fixdate，e.g. "Mon, 27 Oct 2026 08:35:00 GMT"
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const mons = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const g = new Date(d);
  const p2 = n => String(n).padStart(2, "0");
  return `${days[g.getUTCDay()]}, ${p2(g.getUTCDate())} ${mons[g.getUTCMonth()]} ${g.getUTCFullYear()} ${p2(g.getUTCHours())}:${p2(g.getUTCMinutes())}:${p2(g.getUTCSeconds())} GMT`;
}

async function handleDisplay(request, env, url, preview = false) {
  // Device credentials remain separate from browser authentication.
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const expect = env.DEVICE_TOKEN;
  if (!preview && !expect) return new Response("Device authentication not configured", { status: 503 });
  if (!preview && !await secretEqual(token, expect)) return new Response("Unauthorized", { status: 401 });

  if (preview) {
    if (!await sessionOK(request, env)) return reply({ error: "unauthorized" }, 401);
    const dimensions = await (await authService(env).fetch(new Request("https://internal/internal/display-size"))).json();
    url = new URL(url);
    url.searchParams.set("width", dimensions.width);
    url.searchParams.set("height", dimensions.height);
  }
  const width = Math.min(1024, Math.max(128, parseInt(url.searchParams.get("width") || "800", 10) || 800));
  const height = Math.min(1024, Math.max(128, parseInt(url.searchParams.get("height") || "480", 10) || 480));

  const state = await gatherState(env);
  const buf = renderDisplay(state, width, height);
  if (preview) return new Response(bitmapToBMP(buf, width, height), { headers: {
    "Content-Type": "image/bmp", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Picture-Width": String(width), "Content-Picture-Height": String(height),
  } });
  const forceRev = (await env.EINK_KV.get("forceRev")) || "0";
  // Hash the actual pixels: renderer/font changes and dimensions must invalidate old images.
  const pixels = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  const hash = `${width}x${height}:${forceRev}:` + Array.from(pixels, b => b.toString(16).padStart(2, "0")).join("");
  const service = authService(env);
  if (!service) return new Response("Display version service unavailable", { status: 503 });
  const version = await service.fetch(new Request("https://internal/internal/display-version", {
    method: "POST", body: JSON.stringify({ hash, size: `${width}x${height}` }),
  }));
  if (!version.ok) return new Response("Display version unavailable", { status: 503 });
  const { time: lmTime } = await version.json();
  const lmStr = httpDate(lmTime);
  const etag = `"${hash}"`;
  const ims = request.headers.get("If-Modified-Since");
  if (request.headers.has("If-None-Match") ? request.headers.get("If-None-Match") === etag : ims && new Date(ims).getTime() === lmTime) {
    return new Response(null, {
      status: 304,
      headers: {
        "Last-Modified": lmStr,
        "ETag": etag,
        "Cache-Control": "private, no-cache",
        "Content-Picture-Width": String(width),
        "Content-Picture-Height": String(height),
      },
    });
  }

  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Picture-Width": String(width),
      "Content-Picture-Height": String(height),
      "Content-Length": String(buf.byteLength),
      "Last-Modified": lmStr,
        "ETag": etag,
      "Cache-Control": "private, no-cache",
    },
  });
}

/* ---------- 入口 ---------- */
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all(['mail','task'].map(kind => authService(env).fetch(new Request(`https://internal/internal/${kind}-sync`, {method:'POST'})).then(response => {
      if (!response.ok) throw new Error(`Scheduled ${kind} synchronization failed`);
    }))));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // API data is never publicly cached, and browser writes require a same-origin request.
    const cors = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    const corsJson = reply;
    if (path.startsWith("/internal/")) return reply({ error: "not found" }, 404);
    if (path === "/api/login" || path.startsWith("/api/auth/") || path.startsWith("/api/feishu/")) {
      const service = authService(env);
      return service ? service.fetch(request) : reply({ error: "authentication unavailable" }, 503);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 405, headers: cors });
    if (path.startsWith("/api/") && request.method !== "GET" && path !== "/api/mail" &&
        request.headers.get("Origin") !== url.origin) return reply({ error: "origin" }, 403);
    const adminGuard = async req => await sessionOK(req, env) ? null : reply({ error: "unauthorized" }, 401);

    if (request.method === "GET") {
      const displayPage = ["/", "/eink", "/eink.html", "/index.html"].includes(path);
      if (displayPage && !await sessionOK(request, env)) return Response.redirect(new URL("/admin", url).href, 302);
      if (displayPage || ["/admin", "/admin.html", "/webauthn.js"].includes(path)) {
        const asset = path === "/webauthn.js" ? path : displayPage ? "/eink.html" : "/admin.html";
        const result = await env.ASSETS.fetch(new Request(new URL(asset, url)));
        const response = new Response(result.body, result);
        response.headers.set("Cache-Control", "no-store");
        response.headers.set("X-Content-Type-Options", "nosniff");
        response.headers.set("Referrer-Policy", "no-referrer");
        response.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; frame-ancestors 'self'; form-action 'self'; base-uri 'none'");
        return response;
      }
    }
    if (!env.DATA_ENCRYPTION_KEY) return reply({ error: "data encryption not configured" }, 503);
    env = { ...env, EINK_KV: ownerKV(env) };
    if (path === "/feishu/events" && request.method === "POST") return handleFeishuEvent(request, env);

    /* ---- 设备位图（墨水屏直取） ---- */
    if (path === "/api/display/v2" && request.method === "GET")
      return handleDisplay(request, env, url);

    if (path === "/api/display/preview" && request.method === "GET")
      return handleDisplay(request, env, url, true);

    /* ---- 状态 ---- */
    if (path === "/api/state" && request.method === "GET") {
      const g = await adminGuard(request); if (g) return g;
      const s = await gatherState(env);
      return corsJson(s);
    }

    /* ---- 邮件桥推送（飞书，DEVICE_TOKEN 鉴权） ---- */
    if (path === "/api/mail" && request.method === "POST") {
      if (!await bearerOk(request, env)) return corsJson({ error: "unauthorized" }, 401);
      const body = await request.json();
      if (!Number.isSafeInteger(body.unreadCount) || body.unreadCount < 0) return corsJson({ error: "unreadCount required" }, 400);
      await env.EINK_KV.put("mail", JSON.stringify({ unreadCount: body.unreadCount, source: "bridge", syncedAt: Date.now(), error: null }));
      return corsJson({ ok: true });
    }
    if (path === "/api/mail/sync" && request.method === "POST") {
      const g = await adminGuard(request); if (g) return g;
      return authService(env).fetch(new Request("https://internal/internal/mail-sync", { method: "POST" }));
    }
    if (path === "/api/mail/clear" && request.method === "POST") {
      const g = await adminGuard(request); if (g) return g;
      return corsJson({ error: "请在飞书邮箱中标记已读，墨屏会自动同步实际数量" }, 409);
    }

    /* ---- 强制刷新：清天气缓存 + rev+1 → 位图 Last-Modified 变化，设备下轮必刷屏 ---- */
    if (path === "/api/force-refresh" && request.method === "POST") {
      const g = await adminGuard(request); if (g) return g;
      const cfg = await env.EINK_KV.get("config", { type: "json" }) || DEFAULT_CONFIG;
      // 删掉天气缓存（key 与 fetchWeather 一致）
      await env.EINK_KV.delete(`wx:${cfg.city.lat.toFixed(3)},${cfg.city.lon.toFixed(3)}`);
      const rev = crypto.randomUUID();
      await env.EINK_KV.put("forceRev", String(rev));
      return corsJson({ ok: true, rev });
    }

    /* ---- 配置 ---- */
    if (path === "/api/config" && request.method === "POST") {
      const g = await adminGuard(request); if (g) return g;
      let cfg = await env.EINK_KV.get("config", { type: "json" }) || DEFAULT_CONFIG;
      const p = await request.json();
      for (const k of ["city", "layout", "clock", "mailMax", "motto", "refreshSec"])
        if (k in p) cfg[k] = p[k];
      await env.EINK_KV.put("config", JSON.stringify(cfg));
      return corsJson({ ok: true });
    }

    /* ---- Todo ---- */
    if (path === "/api/todos" && request.method === "POST") {
      const g = await adminGuard(request); if (g) return g;
      let cfg = await env.EINK_KV.get("config", { type: "json" }) || DEFAULT_CONFIG;
      if ((await env.EINK_KV.get("tasks",{type:"json"}))?.connected) return corsJson({error:"请在飞书中编辑待办，墨屏会自动同步"},409);
      const p = await request.json();
      const todos = cfg.todos || [];
      switch (p.action) {
        case "add": todos.push({ id: Math.max(0, ...todos.map(t => t.id)) + 1, text: (p.text || "").trim(), done: false }); break;
        case "toggle": for (const t of todos) if (t.id === p.id) t.done = !t.done; break;
        case "remove": cfg.todos = todos.filter(t => t.id !== p.id); await env.EINK_KV.put("config", JSON.stringify(cfg)); return corsJson({ ok: true, todos: cfg.todos });
        case "move": {
          const idx = todos.findIndex(t => t.id === p.id), to = idx + p.delta;
          if (idx >= 0 && to >= 0 && to < todos.length) todos.splice(to, 0, todos.splice(idx, 1)[0]);
          break;
        }
        case "clearDone": todos.splice(0, todos.length, ...todos.filter(t => !t.done)); break;
      }
      cfg.todos = todos;
      await env.EINK_KV.put("config", JSON.stringify(cfg));
      return corsJson({ ok: true, todos });
    }

    return new Response("Not Found", { status: 404, headers: cors });
  },
};
