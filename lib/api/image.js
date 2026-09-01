'use strict';
/** 图片工具：URL 归一化、webp 转码、下载、MIME 嗅探、尺寸解析 */
const { UA } = require('./client');

function normUrl(url) {
  if (!url) return '';
  return String(url).replace(/^\/\//, 'https://').replace(/^http:\/\//, 'https://');
}

/**
 * B站 CDN 图片转码：resvg-js 不支持 WebP 解码（渲染为背景色），
 * 对 .webp 结尾的 URL 追加 B站 图片处理参数 @1e_1c.jpg 强制服务端转 jpeg。
 * 注意：URL 已带 @ 处理参数时会叠加（当前 API 图片均为裸后缀，不触发）。
 */
function fixWebpUrl(url) {
  if (!url) return '';
  const s = String(url);
  const q = s.indexOf('?');
  const path = q >= 0 ? s.slice(0, q) : s;
  if (!/\.webp$/i.test(path)) return s;
  return q >= 0 ? `${path}@1e_1c.jpg${s.slice(q)}` : `${path}@1e_1c.jpg`;
}

/** 下载图片（带 UA/Referer，webp 自动转 jpeg；失败返回 null） */
async function downloadImage(url) {
  try {
    const res = await fetch(fixWebpUrl(normUrl(url)), {
      headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    return buf;
  } catch {
    return null;
  }
}

/** 从文件头嗅探 MIME */
function mimeFromBuffer(buf) {
  if (!buf || buf.length < 12) return 'image/png';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp';
  return 'image/png';
}

/** 解析图片实际尺寸（JPEG/PNG/WebP），失败返回 null */
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  try {
    // PNG: IHDR 宽高（大端）
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // WebP: VP8/VP8L/VP8X
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') {
        const w = 1 + buf.readUIntLE(24, 3), h = 1 + buf.readUIntLE(27, 3);
        return { width: w, height: h };
      }
      if (fourcc === 'VP8 ') {
        const w = buf.readUInt16LE(26) & 0x3fff, h = buf.readUInt16LE(28) & 0x3fff;
        return { width: w, height: h };
      }
      if (fourcc === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    // JPEG: 扫描 SOF 段
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off < buf.length - 9) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        const len = buf.readUInt16BE(off + 2);
        if (len < 2) return null;
        off += 2 + len;
      }
      return null;
    }
    return null;
  } catch { return null; }
}

module.exports = {
  normUrl,
  fixWebpUrl,
  downloadImage,
  mimeFromBuffer,
  imageSize,
};
