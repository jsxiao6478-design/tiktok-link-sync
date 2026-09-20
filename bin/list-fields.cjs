// 列出表格字段（含顺序）
const https = require('https');

function req(method, path, body, tok) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'open.feishu.cn', port: 443, method, path,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, text }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const TYPE = { 1: 'Text', 2: 'Number', 3: 'SingleSelect', 4: 'MultiSelect', 5: 'Date', 7: 'Checkbox',
  11: 'User', 13: 'Phone', 15: 'URL', 17: 'Attachment', 18: 'SingleLink', 20: 'Formula',
  21: 'DuplexLink', 22: 'Location', 23: 'GroupChat', 1001: 'CreatedTime', 1002: 'ModifiedTime',
  1003: 'CreatedUser', 1004: 'ModifiedUser', 1005: 'AutoNumber', 1006: 'Rating', 1007: 'Barcode' };

(async () => {
  const cfg = require('../config.json');
  const { baseToken, tableId } = cfg.feishu;
  const appId = process.env.FEISHU_APP_ID || cfg.feishu.cloud.appId;
  const appSecret = process.env.FEISHU_APP_SECRET || cfg.feishu.cloud.appSecret;

  const tk = await req('POST', '/open-apis/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: appSecret });
  const tok = tk.json.tenant_access_token;

  const r = await req('GET', `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/fields?page_size=200`, null, tok);
  if (r.json.code !== 0) { console.log('FAIL', r.json); return; }
  const items = r.json.data.items;
  console.log('total fields:', items.length);
  console.log('has_more:', r.json.data.has_more);
  console.log('---');
  items.forEach((f, i) => {
    let extra = '';
    if (f.property && f.property.options) {
      extra = ' options=[' + f.property.options.map(o => o.name).join(',') + ']';
    }
    console.log(String(i + 1).padStart(2), f.field_id, '|', f.field_name, '| type=' + f.type + '(' + (TYPE[f.type] || '?') + ') | ui=' + f.ui_type + extra);
  });
})().catch(e => console.error('ERR', e.message));