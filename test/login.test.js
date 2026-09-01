'use strict';
/**
 * 扫码登录模块测试（mock 全局 fetch，零网络）
 * 运行：npm test（node --test 自动发现 test/ 下全部 *.test.js）
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  classifyPoll,
  extractCookiesFromUrl,
  generateQr,
  renderQrTerminal,
  pollLogin,
  loginFlow,
  DEFAULT_TIMEOUT,
} = require('../lib/login');

const jsonRes = obj => ({ text: async () => JSON.stringify(obj) });

// ====== classifyPoll 状态码映射（2026 新版语义：内层 data.code） ======
test('classifyPoll 状态码映射', () => {
  assert.strictEqual(classifyPoll(0), 'success');
  assert.strictEqual(classifyPoll(86101), 'waiting'); // 未扫码
  assert.strictEqual(classifyPoll(86090), 'scanned'); // 已扫码待确认
  assert.strictEqual(classifyPoll(86038), 'expired'); // 已失效
  assert.strictEqual(classifyPoll(-352), 'risk');
  assert.strictEqual(classifyPoll(-412), 'risk');
  assert.strictEqual(classifyPoll(999), 'waiting'); // 未知码容错继续等
});

// ====== 回调 URL → Cookie 提取 ======
test('extractCookiesFromUrl 提取认证 Cookie（含 URL 编码值）', () => {
  // 注意：示例值使用短占位串（避免触发 CI 安全扫描的 SESSDATA/bili_jct 形态正则）
  const url = 'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&from=web&qr_login_key=abc'
    + '&SESSDATA=abc%2Cdef%2Aghi&bili_jct=jct1&DedeUserID=339117663&DedeUserID__ckMd5=md51';
  const ck = extractCookiesFromUrl(url);
  assert.strictEqual(ck.SESSDATA, 'abc,def*ghi'); // %2C→, %2A→*
  assert.strictEqual(ck.bili_jct, 'jct1');
  assert.strictEqual(ck.DedeUserID, '339117663');
  assert.strictEqual(ck.DedeUserID__ckMd5, 'md51');
});

test('extractCookiesFromUrl 无参/空 URL 返回空对象', () => {
  assert.deepStrictEqual(extractCookiesFromUrl(''), {});
  assert.deepStrictEqual(extractCookiesFromUrl(undefined), {});
  assert.deepStrictEqual(extractCookiesFromUrl('https://x.com/?foo=1'), {});
});

// ====== generateQr 重试 ======
test('generateQr 失败重试后成功（网络抖动恢复）', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed'); // 首次网络失败
    return jsonRes({ code: 0, data: { qrcode_key: 'K1', url: 'https://passport.bilibili.com/h5-app/passport/login/scan?qr_login_key=K1' } });
  });
  const { qrcode_key, url } = await generateQr();
  assert.strictEqual(qrcode_key, 'K1');
  assert.ok(url.includes('qr_login_key=K1'));
  assert.ok(calls >= 2, `应至少请求 2 次，实际 ${calls}`);
});

test('generateQr 连续失败抛错', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(() => generateQr(), /fetch failed/);
});

// ====== pollLogin 状态流转（2026 新版响应：外层 code=0，状态在内层 data.code） ======
test('pollLogin 未扫→已扫→成功 全流程', async (t) => {
  const statuses = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    if (calls === 1) return jsonRes({ code: 0, message: 'OK', data: { code: 86101, message: '未扫码' } });
    if (calls === 2) return jsonRes({ code: 0, message: 'OK', data: { code: 86090, message: '已扫码' } });
    return jsonRes({
      code: 0,
      message: 'OK',
      data: {
        code: 0,
        url: 'https://passport.bilibili.com/h5-app/passport/login/scan?SESSDATA=abc%2C123&bili_jct=xyz&DedeUserID=42&DedeUserID__ckMd5=m5',
      },
    });
  });
  const { cookies } = await pollLogin('K1', { onStatus: (code) => statuses.push(code), timeoutMs: 60000 });
  assert.deepStrictEqual(statuses, [86101, 86090]);
  assert.strictEqual(cookies.SESSDATA, 'abc,123');
  assert.strictEqual(cookies.bili_jct, 'xyz');
  assert.strictEqual(cookies.DedeUserID, '42');
});

test('pollLogin 二维码失效抛错（内层 86038）', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: 0, message: 'OK', data: { code: 86038, message: '二维码已失效' } }));
  await assert.rejects(() => pollLogin('K1', { timeoutMs: 60000 }), /二维码已失效/);
});

test('pollLogin 超时抛错', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonRes({ code: 0, message: 'OK', data: { code: 86101, message: '未扫码' } }));
  await assert.rejects(() => pollLogin('K1', { timeoutMs: 100 }), /超时/);
});

// ====== renderQrTerminal 终端渲染 ======
test('renderQrTerminal 输出半块字符且行数正确', () => {
  const lines = [];
  const ok = renderQrTerminal('https://passport.bilibili.com/h5-app/passport/login/scan?qr_login_key=test', {
    log: s => lines.push(s),
    columns: 100,
  });
  assert.strictEqual(ok, true);
  // 37×37 矩阵（margin=2 含边框）→ ceil(37/2) = 19 行
  assert.strictEqual(lines.length, 19);
  // 每行包含半块字符
  const joined = lines.join('');
  assert.ok(joined.includes('█') || joined.includes('▀') || joined.includes('▄'), '输出应含半块字符');
  // 行宽 = 37 字符（每行合并 2 行矩阵）
  assert.ok(lines.every(l => l.length === 37 || l.length === 36), '行宽应接近矩阵宽度');
});

test('renderQrTerminal 超宽终端返回 false', () => {
  const ok = renderQrTerminal('https://passport.bilibili.com/h5-app/passport/login/scan?qr_login_key=test', {
    log: () => {},
    columns: 30, // 小于 41
  });
  assert.strictEqual(ok, false);
});

// ====== loginFlow 端到端（mock） ======
test('loginFlow 完整流程返回 cookieStr/uname/mid', async (t) => {
  const logs = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    const u = String(url);
    if (u.includes('/qrcode/generate')) {
      return jsonRes({ code: 0, data: { qrcode_key: 'K1', url: 'https://passport.bilibili.com/h5-app/passport/login/scan?qr_login_key=K1' } });
    }
    if (u.includes('/qrcode/poll')) {
      return jsonRes({ code: 0, message: 'OK', data: { code: 0, url: 'https://passport.bilibili.com/h5-app/passport/login/scan?SESSDATA=s1%2C2&bili_jct=j1&DedeUserID=42&DedeUserID__ckMd5=m1' } });
    }
    if (u.includes('/x/frontend/finger/spi')) {
      return jsonRes({ code: 0, data: { b_3: 'B3', b_4: 'B4' } });
    }
    if (u.includes('/x/web-interface/nav')) {
      return jsonRes({ code: 0, data: { isLogin: true, uname: '测试账号', mid: 42 } });
    }
    return jsonRes({ code: -404 });
  });
  const r = await loginFlow({ timeoutMs: 60000, log: s => logs.push(s) });
  assert.strictEqual(r.uname, '测试账号');
  assert.strictEqual(r.mid, '42');
  assert.ok(r.cookieStr.includes('SESSDATA=s1,2'));
  assert.ok(r.cookieStr.includes('bili_jct=j1'));
  assert.ok(r.cookieStr.includes('buvid3=B3'), '应含设备指纹: ' + r.cookieStr);
  assert.ok(logs.some(l => l.includes('扫码')), '应有扫码提示日志');
  assert.ok(calls >= 4, `应至少 4 次请求，实际 ${calls}`);
});
