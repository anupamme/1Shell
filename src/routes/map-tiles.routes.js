'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const fetch = require('node-fetch');

// 主页地图瓦片代理：前端只请求同源 /api/map/tiles/...，CSP 无需放行外域、浏览器不直连第三方。
// 上游按顺序降级（CARTO Voyager 彩色底图首选 → CARTO Positron 灰底 → OSM 标准）；
// 主上游带重试 + keepAlive 连接复用；仅 Voyager 瓦片做 30 天磁盘缓存，
// 过期后先返回旧彩色、后台刷新；降级瓦片不落盘（避免彩灰混排被缓存固化）；
// 启动时预热 z2–z4 全球瓦片，保证主页默认全球视野始终有彩色底图。
const UPSTREAMS = [
  {
    id: 'carto-voyager',
    build: ({ z, x, y, retina }) => `https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}${retina ? '@2x' : ''}.png`,
  },
  {
    id: 'carto-light',
    build: ({ z, x, y, retina }) => `https://basemaps.cartocdn.com/light_all/${z}/${x}/${y}${retina ? '@2x' : ''}.png`,
  },
  {
    id: 'osm',
    build: ({ z, x, y }) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  },
];

const MAX_ZOOM = 12;
const FETCH_TIMEOUT_MS = 4000;
// 到 CARTO 的连接偶发握手超时：主上游多试一次 + keepAlive 复用连接，避开大部分瞬时失败
const PRIMARY_ATTEMPTS = 2;
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const DISK_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CLIENT_CACHE_SECONDS = 7 * 24 * 60 * 60;
const FALLBACK_CACHE_SECONDS = 5 * 60;
const STALE_CLIENT_CACHE_SECONDS = 60 * 60;
// 低缩放预热：z2–z4 是主页默认的全球视野，常驻磁盘后上游抖动也不会整屏降级成灰底
const WARM_MIN_ZOOM = 2;
const WARM_MAX_ZOOM = 4;
const WARM_CONCURRENCY = 3;
const WARM_RETRY_MS = 10 * 60 * 1000;
const WARM_MAX_RETRIES = 6;
const WARM_INTERVAL_MS = 24 * 60 * 60 * 1000;
const Y_PATTERN = /^(\d+)(@2x)?\.png$/;

function createMapTilesRouter({ dataDir }) {
  const router = express.Router();
  // 目录带风格版本号：换底图风格时避免命中旧风格的磁盘缓存
  const cacheDir = path.join(dataDir, 'map-tiles', 'voyager');
  const inflight = new Map();

  function cachePath(z, x, y, retina) {
    return path.join(cacheDir, String(z), String(x), `${y}${retina ? '@2x' : ''}.png`);
  }

  async function readCache(file) {
    try {
      const stat = await fs.promises.stat(file);
      const buffer = await fs.promises.readFile(file);
      return { buffer, stale: Date.now() - stat.mtimeMs > DISK_CACHE_MAX_AGE_MS };
    } catch {
      return null;
    }
  }

  async function writeCache(file, buffer) {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, buffer);
    } catch {
      // 缓存写入失败不影响响应
    }
  }

  async function fetchTile(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        agent: keepAliveAgent,
        headers: { 'User-Agent': '1Shell self-hosted ops console (map tile proxy)' },
      });
      if (resp.ok) {
        const buffer = await resp.buffer();
        if (buffer.length > 0) return buffer;
      }
    } catch {
      // 超时/网络错误按失败处理
    } finally {
      clearTimeout(timer);
    }
    return null;
  }

  async function fetchFromUpstreams(params) {
    for (const upstream of UPSTREAMS) {
      const primary = upstream === UPSTREAMS[0];
      const url = upstream.build(params);
      const attempts = primary ? PRIMARY_ATTEMPTS : 1;
      for (let i = 0; i < attempts; i++) {
        const buffer = await fetchTile(url);
        if (buffer) return { buffer, primary };
      }
    }
    return null;
  }

  // 相同瓦片的并发请求合并为一次上游拉取
  function pullTile(params) {
    const key = `${params.z}/${params.x}/${params.y}${params.retina ? '@2x' : ''}`;
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchFromUpstreams(params).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  }

  async function isCacheFresh(file) {
    try {
      const stat = await fs.promises.stat(file);
      return Date.now() - stat.mtimeMs <= DISK_CACHE_MAX_AGE_MS;
    } catch {
      return false;
    }
  }

  let warming = false;
  let warmRetries = 0;
  async function warmLowZoomTiles() {
    if (warming) return;
    warming = true;
    try {
      const targets = [];
      for (let z = WARM_MIN_ZOOM; z <= WARM_MAX_ZOOM; z++) {
        const scale = 2 ** z;
        for (let x = 0; x < scale; x++) {
          for (let y = 0; y < scale; y++) {
            for (const retina of [false, true]) {
              targets.push({ z, x, y, retina });
            }
          }
        }
      }
      const missing = [];
      for (const target of targets) {
        if (!(await isCacheFresh(cachePath(target.z, target.x, target.y, target.retina)))) missing.push(target);
      }
      let failed = 0;
      let index = 0;
      const worker = async () => {
        while (index < missing.length) {
          const target = missing[index++];
          const result = await pullTile(target);
          if (result && result.primary) {
            await writeCache(cachePath(target.z, target.x, target.y, target.retina), result.buffer);
          } else {
            failed += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: WARM_CONCURRENCY }, () => worker()));
      if (failed > 0 && warmRetries < WARM_MAX_RETRIES) {
        warmRetries += 1;
        setTimeout(() => { void warmLowZoomTiles(); }, WARM_RETRY_MS).unref();
      } else if (failed === 0) {
        warmRetries = 0;
      }
    } finally {
      warming = false;
    }
  }
  void warmLowZoomTiles();
  setInterval(() => { warmRetries = 0; void warmLowZoomTiles(); }, WARM_INTERVAL_MS).unref();

  router.get('/map/tiles/:z/:x/:y', async (req, res) => {
    const z = Number.parseInt(req.params.z, 10);
    const x = Number.parseInt(req.params.x, 10);
    const yMatch = Y_PATTERN.exec(String(req.params.y || ''));
    if (!yMatch) return res.status(400).json({ error: 'invalid tile path' });
    const y = Number.parseInt(yMatch[1], 10);
    const retina = yMatch[2] === '@2x';
    const scale = 2 ** z;
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)
      || z < 0 || z > MAX_ZOOM || x < 0 || x >= scale || y < 0 || y >= scale) {
      return res.status(400).json({ error: 'invalid tile coordinates' });
    }

    const file = cachePath(z, x, y, retina);
    const params = { z, x, y, retina };
    const cached = await readCache(file);
    if (cached) {
      // 过期的 Voyager 瓦片也先返回（宁可旧彩色不要灰色），后台刷新，主上游成功才覆盖
      if (cached.stale) {
        void pullTile(params).then((result) => {
          if (result && result.primary) void writeCache(file, result.buffer);
        });
        res.set('Cache-Control', `public, max-age=${STALE_CLIENT_CACHE_SECONDS}`);
      } else {
        res.set('Cache-Control', `public, max-age=${CLIENT_CACHE_SECONDS}`);
      }
      return res.type('png').send(cached.buffer);
    }

    const result = await pullTile(params);
    if (!result) return res.status(502).json({ error: 'tile upstreams unavailable' });

    // 只有主上游（Voyager 彩色）才落盘/长缓存；降级瓦片（Positron 灰底 / OSM）风格不同，
    // 缓存住会导致地图彩灰混排，只给短缓存让客户端尽快重取彩色瓦片
    if (result.primary) {
      void writeCache(file, result.buffer);
      res.set('Cache-Control', `public, max-age=${CLIENT_CACHE_SECONDS}`);
    } else {
      res.set('Cache-Control', `public, max-age=${FALLBACK_CACHE_SECONDS}`);
    }
    return res.type('png').send(result.buffer);
  });

  return router;
}

module.exports = { createMapTilesRouter };
