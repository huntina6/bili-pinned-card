'use strict';
/** 登录诊断：渲染二维码 + 打印 poll 原始响应，定位扫码确认后的真实状态码（用完可删） */
const { generateQr, renderQrTerminal } = require('./lib/login');
const { httpJson } = require('./lib/api/client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const { qrcode_key, url } = await generateQr();
  console.log('qrcode_key:', qrcode_key);
  console.log('');
  console.log('  请用 B站 App 扫描下方二维码并在手机上点「确认登录」');
  console.log('');
  renderQrTerminal(url);
  console.log('');
  console.log('[URL] ' + url);
  console.log('');
  for (let i = 0; i < 60; i++) { // 最长 ~3 分钟
    try {
      const d = await httpJson('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(qrcode_key) + '&source=main-fe-header', {
        referer: 'https://www.bilibili.com/',
      });
      const inner = d.data || {};
      console.log('[' + new Date().toTimeString().slice(0, 8) + '] data.code=' + inner.code, '| msg=' + (inner.message || ''), '| url=' + (inner.url || '').slice(0, 60));
      if (inner.code === 0) {
        console.log('✅ 登录成功 URL 完整值:', inner.url);
        // 立即尝试 ticket 兑换
        const { exchangeCrossDomain } = require('./lib/login');
        const { anonCookie } = require('./lib/api/client');
        const device = await anonCookie().catch(() => '');
        const ck = await exchangeCrossDomain(inner.url, device);
        console.log('兑换结果:', JSON.stringify(ck));
        if (ck.SESSDATA) {
          const { mergeCookie } = require('./lib/api/client');
          const full = mergeCookie(device, Object.entries(ck).map(([k, v]) => k + '=' + v).join('; '));
          const v = await httpJson('https://api.bilibili.com/x/web-interface/nav', { cookie: full, referer: 'https://www.bilibili.com/' });
          console.log('nav 验证:', v.code === 0 && v.data && v.data.isLogin ? '✅ 登录成功: ' + v.data.uname + ' (UID ' + v.data.mid + ')' : '⚠ nav code=' + v.code);
        }
        break;
      }
    } catch (e) {
      console.log('轮询异常(继续):', e.message.slice(0, 80));
    }
    await sleep(3000);
  }
  console.log('诊断结束');
})();
