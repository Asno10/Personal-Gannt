// The TV view's background: the sky outside, as it is now. Its colour follows
// the sun's height over the place set in the sheet (Settings, tv_location),
// worked out here every minute; the weather comes from Open-Meteo (free, no
// key) every 15 minutes and adds clouds, rain, snow, fog or lightning. At
// night the stars and the moon, in its real phase, come out when the sky is
// clear. Nothing here writes anywhere.

const WX_MS = 15 * 60 * 1000;
const PLACE_KEY = 'pg.tvPlace';
const DEFAULT_PLACE = { name: 'İzmir', lat: 38.42, lon: 27.14 };
const RAD = Math.PI / 180;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let el = null;
let place = store.get(PLACE_KEY) || DEFAULT_PLACE;
let placeQuery = null;
let wx = null; // { code, cloud, temp, wind, at }
let onChange = () => {};
let wxTimer = 0;
const state = { clearNight: false, clearDay: false };

// ---------- Weather ----------

const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'heavy showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};

// What falls, and how much: kind is rain or snow, amount from 0 to 1.
function precipOf(code) {
  if ([51, 56].includes(code)) return { kind: 'rain', amount: 0.25 };
  if ([53, 57, 61, 80].includes(code)) return { kind: 'rain', amount: 0.45 };
  if ([55, 63, 66, 81].includes(code)) return { kind: 'rain', amount: 0.7 };
  if ([65, 67, 82, 95, 96, 99].includes(code)) return { kind: 'rain', amount: 1 };
  if ([71, 77, 85].includes(code)) return { kind: 'snow', amount: 0.4 };
  if ([73].includes(code)) return { kind: 'snow', amount: 0.7 };
  if ([75, 86].includes(code)) return { kind: 'snow', amount: 1 };
  return { kind: '', amount: 0 };
}

// "14°, partly cloudy", or an empty string before the first reading.
export function weatherLine() {
  if (!wx) return '';
  return `${Math.round(wx.temp)}°, ${WMO[wx.code] || 'cloudy'}`;
}

export const placeName = () => place?.name || '';

// A weather glyph for the current conditions, as inline SVG on a 24-unit
// grid: sun or moon (after dark), cloud, rain, snow, fog or lightning. Its
// colours come from CSS (--wx-sun, --wx-cloud, --wx-rain), so night mode can
// turn them red.
export function weatherIcon() {
  if (!wx) return '';
  const night = sun(new Date(), place.lat, place.lon).elev < -2;
  const c = wx.code;
  const SUN = '<g class="i-sun"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g>';
  const SUN_SMALL = '<g class="i-sun"><circle cx="8.5" cy="8.5" r="3.2"/><path d="M8.5 1.8v1.6M1.8 8.5h1.6M3.8 3.8l1.1 1.1M13.2 3.8l-1.1 1.1M3.8 13.2l1.1-1.1"/></g>';
  const MOON = '<path class="i-moon" d="M15.5 3.2a8.6 8.6 0 1 0 5.3 13.6A7 7 0 0 1 15.5 3.2z"/>';
  const MOON_SMALL = '<path class="i-moon" d="M10.4 1.8a6.2 6.2 0 1 0 3.8 9.9 5 5 0 0 1-3.8-9.9z"/>';
  const CLOUD = (y = 0) => `<path class="i-cloud" transform="translate(0 ${y})" d="M7 19h10.2a4.3 4.3 0 0 0 .4-8.6A6 6 0 0 0 6.1 12 3.6 3.6 0 0 0 7 19z"/>`;
  const RAIN = (heavy) => `<path class="i-rain" d="M8.5 19.8l-1 2.4M12.5 19.8l-1 2.4M16.5 19.8l-1 2.4${heavy ? 'M10.5 19.8l-1 2.4M14.5 19.8l-1 2.4' : ''}"/>`;
  const SNOW = '<g class="i-snow"><circle cx="8.5" cy="21" r="1"/><circle cx="12.5" cy="22.3" r="1"/><circle cx="16.5" cy="21" r="1"/></g>';
  const BOLT = '<path class="i-bolt" d="M12.8 15.5l-2.6 4.2h3l-1.8 3.8 4.6-5.4h-3l1.8-2.6z"/>';
  const FOG = '<path class="i-fog" d="M4 9.5h16M6 13.5h12M4 17.5h16"/>';
  let body;
  if (c === 0 || c === 1) body = night ? MOON : SUN;
  else if (c === 2) body = (night ? MOON_SMALL : SUN_SMALL) + CLOUD(1);
  else if (c === 3) body = CLOUD(-1);
  else if (c === 45 || c === 48) body = FOG;
  else if ([95, 96, 99].includes(c)) body = CLOUD(-3) + BOLT;
  else if ([71, 73, 75, 77, 85, 86].includes(c)) body = CLOUD(-3) + SNOW;
  else if (precipOf(c).kind === 'rain') body = CLOUD(-3) + RAIN(precipOf(c).amount >= 0.7);
  else body = CLOUD(-1);
  return `<svg class="wx-icon" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

export const weatherTemp = () => (wx ? `${Math.round(wx.temp)}°` : '');
export const weatherText = () => (wx ? WMO[wx.code] || 'cloudy' : '');

// tv_location: a place name ("Balıkesir") or "latitude, longitude".
export async function setPlace(query) {
  query = String(query || '').trim();
  if (!query || query === placeQuery) return;
  placeQuery = query;
  const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(query);
  let found = null;
  if (m) found = { name: '', lat: +m[1], lon: +m[2] };
  else {
    const cached = store.get(PLACE_KEY);
    if (cached?.query === query) found = cached;
    else {
      try {
        const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`);
        const r = (await res.json())?.results?.[0];
        if (r) found = { name: r.name, lat: r.latitude, lon: r.longitude };
      } catch {}
    }
  }
  if (!found) return;
  place = { ...found, query };
  store.set(PLACE_KEY, place);
  loadWeather();
}

async function loadWeather() {
  clearTimeout(wxTimer);
  wxTimer = setTimeout(loadWeather, WX_MS);
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}`
      + '&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m&timezone=auto&forecast_days=1';
    const c = (await (await fetch(url, { cache: 'no-store' })).json())?.current;
    if (!c) return;
    wx = { code: c.weather_code, cloud: c.cloud_cover, temp: c.temperature_2m, wind: c.wind_speed_10m, at: Date.now() };
    paint();
    onChange();
  } catch {}
}

// ---------- Sun and moon ----------

// The sun's height above the horizon (degrees) and its hour angle (radians,
// 0 at noon, negative in the morning), from a standard low-precision formula.
function sun(date, lat, lon) {
  const d = date.getTime() / 86400000 - 10957.5; // days since 2000-01-01 12:00 UTC
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  let ha = (gmst * 15 + lon) * RAD - ra;
  ha = Math.atan2(Math.sin(ha), Math.cos(ha));
  const elev = Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha));
  return { elev: elev / RAD, ha, dec };
}

// 0 at new moon, 0.5 at full.
const moonPhase = (date) => ((((date.getTime() / 86400000 + 2440587.5 - 2451550.26) / 29.530588853) % 1) + 1) % 1;

// The lit part of the moon as an SVG path, for a disc of radius r at 0,0.
function moonPath(p, r) {
  const k = Math.cos(2 * Math.PI * p);
  const rx = Math.abs(k) * r;
  const waxing = p < 0.5;
  const outer = `M0,${-r} A${r},${r} 0 0 ${waxing ? 1 : 0} 0,${r}`;
  const sweep = waxing ? (k > 0 ? 0 : 1) : (k > 0 ? 1 : 0);
  return `${outer} A${rx.toFixed(2)},${r} 0 0 ${sweep} 0,${-r} Z`;
}

// ---------- Colour ----------

// Sky colours by the sun's height: zenith, horizon.
const STOPS = [
  [-18, '#04070f', '#0a1222'],
  [-12, '#070d1e', '#131c38'],
  [-7, '#0d1838', '#2a2f5c'],
  [-3, '#1a2b5c', '#8a5a78'],
  [0, '#2a4380', '#e08a6a'],
  [4, '#2f5a9c', '#f0b07a'],
  [10, '#2a64ad', '#9cbfe0'],
  [25, '#1f5aa8', '#6ea3d8'],
  [60, '#1a4f9c', '#5d95d0'],
];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c, a = 1) => `rgb(${c[0]} ${c[1]} ${c[2]} / ${a})`;

function skyColours(elev) {
  const e = Math.max(-18, Math.min(60, elev));
  let i = 0;
  while (i < STOPS.length - 2 && e > STOPS[i + 1][0]) i++;
  const [e0, z0, h0] = STOPS[i];
  const [e1, z1, h1] = STOPS[i + 1];
  const t = (e - e0) / (e1 - e0);
  return { zenith: mix(hex(z0), hex(z1), t), horizon: mix(hex(h0), hex(h1), t) };
}

// ---------- Painting ----------

function seeded(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

export function initSky(host, change) {
  onChange = change || onChange;
  const rnd = seeded(7);
  const stars = Array.from({ length: 160 }, () => {
    const r = rnd() < 0.85 ? 0.6 + rnd() * 0.6 : 1.2 + rnd() * 0.9;
    const tw = rnd() < 0.45 ? ` class="tw" style="animation-duration:${(2.5 + rnd() * 4).toFixed(1)}s;animation-delay:${(-rnd() * 6).toFixed(1)}s"` : '';
    return `<circle cx="${(rnd() * 1600).toFixed(1)}" cy="${(rnd() * 760).toFixed(1)}" r="${r.toFixed(2)}" opacity="${(0.2 + rnd() * 0.6).toFixed(2)}"${tw}/>`;
  }).join('');
  const crnd = seeded(31);
  const clouds = Array.from({ length: 9 }, (_, i) => {
    const puffs = Array.from({ length: 6 }, () => {
      const w = 8 + crnd() * 12;
      return `<i style="left:${(crnd() * 22).toFixed(1)}rem;top:${(crnd() * 5).toFixed(1)}rem;width:${w.toFixed(1)}rem;height:${(w * 0.62).toFixed(1)}rem"></i>`;
    }).join('');
    const top = 2 + crnd() * 46;
    const dur = 110 + crnd() * 120;
    return `<div class="cloud" data-i="${i}" style="top:${top.toFixed(1)}%;--dur:${dur.toFixed(0)}s;animation-delay:${(-crnd() * dur).toFixed(0)}s;--scale:${(0.7 + crnd() * 0.8).toFixed(2)}">${puffs}</div>`;
  }).join('');
  host.innerHTML = `
    <div class="sky-grad"></div>
    <div class="sky-glow"></div>
    <svg class="sky-stars" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">${stars}</svg>
    <svg class="sky-moon" viewBox="-60 -60 120 120"><circle class="moon-dark" r="22"/><path class="moon-lit"/></svg>
    <div class="sky-rays"></div>
    <div class="sky-meteor"></div>
    <div class="sky-birds"></div>
    <div class="sky-overcast"></div>
    <div class="sky-clouds">${clouds}</div>
    <canvas class="sky-precip"></canvas>
    <div class="sky-fog"></div>
    <div class="sky-flash"></div>
    <div class="sky-scrim"></div>`;
  el = Object.fromEntries(['grad', 'glow', 'rays', 'meteor', 'birds', 'stars', 'moon', 'overcast', 'clouds', 'precip', 'fog', 'flash', 'scrim'].map((k) => [k, host.querySelector(`.sky-${k}`)]));
  el.lit = host.querySelector('.moon-lit');
  el.cloudEls = [...host.querySelectorAll('.cloud')];
  paint();
  setInterval(paint, 60 * 1000);
  startPrecip();
  scheduleFlash();
  scheduleMeteor();
  scheduleBirds();
  loadWeather();
}

// Where the sun or moon sits on screen, from its hour angle and height.
const xOf = (ha) => 50 + (ha / Math.PI) * 70;
const yOf = (elev) => 78 - (Math.max(-10, elev) / 55) * 66;

function paint() {
  if (!el) return;
  const now = new Date();
  const s = sun(now, place.lat, place.lon);
  const cloud = wx ? wx.cloud / 100 : 0.2;
  const pr = precipOf(wx?.code);
  const fog = [45, 48].includes(wx?.code);
  const grey = Math.min(1, cloud * 0.55 + pr.amount * 0.35 + (fog ? 0.3 : 0));
  const day = Math.max(0, Math.min(1, (s.elev + 6) / 16)); // 0 at night, 1 in daylight

  // The sky: its colour for the sun's height, greyed by cloud and rain.
  const { zenith, horizon } = skyColours(s.elev);
  const greyZ = mix([60, 68, 82], [16, 19, 26], 1 - day);
  const greyH = mix([118, 126, 138], [26, 30, 40], 1 - day);
  const z = mix(zenith, greyZ, grey);
  const h = mix(horizon, greyH, grey);
  el.grad.style.background = `linear-gradient(180deg, ${rgb(z)} 0%, ${rgb(mix(z, h, 0.45))} 55%, ${rgb(h)} 100%)`;

  // The sun's glow, warm near the horizon, hidden by cloud.
  const sx = xOf(s.ha);
  const sy = yOf(s.elev);
  const warm = Math.max(0, 1 - Math.abs(s.elev - 2) / 14);
  const glowCol = mix([255, 244, 214], [255, 160, 92], warm);
  const glowA = Math.max(0, Math.min(1, (s.elev + 5) / 8)) * (1 - cloud * 0.75) * (0.55 + warm * 0.35);
  el.glow.style.background = `radial-gradient(48rem 34rem at ${sx.toFixed(1)}% ${sy.toFixed(1)}%, ${rgb(glowCol, glowA)}, ${rgb(glowCol, 0)} 70%)`;
  el.glow.style.transformOrigin = `${sx.toFixed(1)}% ${sy.toFixed(1)}%`;
  // Slow light rays from the sun on a clear day.
  el.rays.style.left = `${sx.toFixed(1)}%`;
  el.rays.style.top = `${sy.toFixed(1)}%`;
  el.rays.style.setProperty('--ray', rgb(glowCol, 1));
  el.rays.style.opacity = (Math.max(0, Math.min(1, (s.elev + 2) / 6)) * Math.max(0, 1 - cloud * 1.6) * (1 - pr.amount) * 0.5).toFixed(2);


  // Stars and the moon at night, behind any cloud.
  const dark = Math.max(0, Math.min(1, (-s.elev - 4) / 8));
  state.clearNight = dark > 0.6 && cloud < 0.45 && !pr.kind;
  state.clearDay = day > 0.8 && cloud < 0.75 && !pr.kind && !fog;
  el.stars.style.opacity = (dark * (1 - Math.min(1, cloud * 1.2))).toFixed(2);
  const p = moonPhase(now);
  const moonHa = Math.atan2(Math.sin(s.ha - p * 2 * Math.PI), Math.cos(s.ha - p * 2 * Math.PI));
  const moonElev = Math.asin(Math.sin(place.lat * RAD) * Math.sin(-s.dec * 0.4) + Math.cos(place.lat * RAD) * Math.cos(s.dec * 0.4) * Math.cos(moonHa)) / RAD;
  const moonA = moonElev > 3 && Math.abs(p - 0) > 0.03 && Math.abs(p - 1) > 0.03 ? Math.min(1, dark * 1.2 + 0.15) * (1 - Math.min(1, cloud * 1.1)) : 0;
  el.moon.style.opacity = moonA.toFixed(2);
  el.moon.style.left = `${xOf(moonHa).toFixed(1)}%`;
  el.moon.style.top = `${yOf(moonElev).toFixed(1)}%`;
  el.lit.setAttribute('d', moonPath(p, 22));

  // Clouds: how many show, and their colour for the light.
  const shown = Math.round(cloud * el.cloudEls.length + (pr.amount ? 2 : 0));
  const cloudCol = mix(mix([238, 242, 250], [255, 214, 188], warm * (1 - grey)), [74, 82, 104], 1 - day);
  const cloudA = (0.35 + day * 0.4) * (1 - grey * 0.35);
  el.clouds.style.setProperty('--cloud', rgb(cloudCol, cloudA));
  el.clouds.style.setProperty('--wind', `${Math.max(0.4, Math.min(3, (wx?.wind || 8) / 10))}`);
  el.cloudEls.forEach((c, i) => c.classList.toggle('is-on', i < shown));
  el.overcast.style.opacity = Math.max(0, (cloud - 0.6) / 0.4 + pr.amount * 0.3).toFixed(2);
  el.overcast.style.setProperty('--oc', rgb(mix([150, 158, 172], [30, 34, 46], 1 - day)));

  el.fog.style.opacity = fog ? '0.75' : '0';
  // Text stays readable on a bright sky.
  el.scrim.style.opacity = (day * (1 - grey * 0.5) * 0.32).toFixed(2);

  precip.kind = pr.kind;
  precip.amount = pr.amount;
  precip.wind = wx?.wind || 0;
  precip.storm = [95, 96, 99].includes(wx?.code);
}

// ---------- Rain and snow ----------

const precip = { kind: '', amount: 0, wind: 0, storm: false, parts: [] };

function startPrecip() {
  const c = el.precip;
  const ctx = c.getContext('2d');
  let last = 0;
  const size = () => { c.width = Math.round(window.innerWidth); c.height = Math.round(window.innerHeight); };
  size();
  window.addEventListener('resize', size);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const frame = (t) => {
    requestAnimationFrame(frame);
    if (t - last < 33) return; // about 30 frames a second is plenty
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    const off = !precip.kind || document.documentElement.classList.contains('is-night');
    ctx.clearRect(0, 0, c.width, c.height);
    if (off) { precip.parts.length = 0; return; }
    const W = c.width;
    const H = c.height;
    const want = Math.round((precip.kind === 'rain' ? 220 : 160) * precip.amount * (W / 1920));
    while (precip.parts.length < want) precip.parts.push(spawn(W, H, true));
    if (precip.parts.length > want) precip.parts.length = want;
    const lean = Math.max(-0.35, Math.min(0.35, precip.wind / 80));
    if (precip.kind === 'rain') {
      ctx.strokeStyle = 'rgb(220 232 255 / 0.32)';
      ctx.lineWidth = Math.max(1, W / 1600);
      ctx.beginPath();
      for (const p of precip.parts) {
        if (!reduced) { p.y += p.v * dt; p.x += p.v * lean * dt; }
        if (p.y > H || p.x > W + 40) Object.assign(p, spawn(W, H, false));
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.len * lean, p.y - p.len);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgb(255 255 255 / 0.75)';
      for (const p of precip.parts) {
        if (!reduced) { p.y += p.v * 0.12 * dt; p.ph += dt; p.x += (Math.sin(p.ph) * 18 + precip.wind) * dt; }
        if (p.y > H) Object.assign(p, spawn(W, H, false));
        ctx.globalAlpha = p.a;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  };
  requestAnimationFrame(frame);
}

function spawn(W, H, anywhere) {
  const z = Math.random();
  return {
    x: Math.random() * (W + 200) - 200,
    y: anywhere ? Math.random() * H : -40 - Math.random() * 60,
    v: (0.7 + z * 0.6) * H * 1.1,
    len: (0.6 + z) * H * 0.022,
    r: 1 + z * 2.4 * (W / 1920),
    a: 0.35 + z * 0.55,
    ph: Math.random() * 6,
  };
}

// A soft, rare flash in a thunderstorm.
function scheduleFlash() {
  setTimeout(() => {
    if (precip.storm && !document.documentElement.classList.contains('is-night') && el) {
      el.flash.classList.remove('is-on');
      void el.flash.offsetWidth;
      el.flash.classList.add('is-on');
    }
    scheduleFlash();
  }, 25000 + Math.random() * 35000);
}

// ---------- Little events, so the screen never looks frozen ----------

const nightMode = () => document.documentElement.classList.contains('is-night');

// A shooting star now and then on a clear night.
function scheduleMeteor() {
  setTimeout(() => {
    if (state.clearNight && !nightMode() && el) {
      const m = el.meteor;
      m.style.left = `${(15 + Math.random() * 60).toFixed(1)}%`;
      m.style.top = `${(4 + Math.random() * 28).toFixed(1)}%`;
      m.style.setProperty('--angle', `${(18 + Math.random() * 22).toFixed(0)}deg`);
      m.classList.remove('is-on');
      void m.offsetWidth;
      m.classList.add('is-on');
    }
    scheduleMeteor();
  }, 18000 + Math.random() * 40000);
}

// A small flock crossing the sky every few minutes on a fair day.
function scheduleBirds() {
  setTimeout(() => {
    if (state.clearDay && !nightMode() && el && !el.birds.childElementCount) {
      const n = 3 + Math.floor(Math.random() * 4);
      const rtl = Math.random() < 0.5;
      const top = 10 + Math.random() * 30;
      const flock = Array.from({ length: n }, (_, i) => {
        const dx = i * (2 + Math.random() * 1.6);
        const dy = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (1 + Math.random());
        return `<svg class="bird" viewBox="0 0 24 10" style="left:${dx.toFixed(1)}rem;top:${dy.toFixed(1)}rem;animation-delay:${(-Math.random()).toFixed(2)}s"><path d="M1 6 Q6 0 12 6 Q18 0 23 6"/></svg>`;
      }).join('');
      el.birds.innerHTML = `<div class="flock ${rtl ? 'is-rtl' : ''}" style="top:${top.toFixed(1)}%">${flock}</div>`;
      setTimeout(() => { if (el) el.birds.innerHTML = ''; }, 46000);
    }
    scheduleBirds();
  }, 60000 + Math.random() * 120000);
}
