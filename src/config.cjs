/**
 * config.cjs —— 配置加载（config.json + 环境变量覆盖）
 *
 * 单独成模块，供 src/sync.cjs 与 bin/smoke-test.cjs 共用。
 *
 * 环境变量全部可选；本机不设这些变量时行为与之前完全一致，
 * 在 GitHub Actions 上则从 Secrets 注入，避免把凭证写进仓库。
 *
 *   FEISHU_APP_ID / FEISHU_APP_SECRET  应用凭证（启用 openapi / bot 后端）
 *   FEISHU_BACKEND                     openapi | lark-cli（显式指定后端）
 *   FEISHU_BASE_TOKEN / FEISHU_TABLE_ID / FEISHU_URL   覆盖表格坐标
 *   FEISHU_AS                          仅 lark-cli 后端使用（user）
 *   TIKTOK_PROXY                       抓取用代理，如 http://10.0.0.1:8080
 *   TIKTOK_CHROME_PATH                 Chrome 可执行文件路径
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function applyEnvOverrides(config) {
  const env = process.env;
  config.feishu = config.feishu || {};
  const f = config.feishu;

  if (env.FEISHU_APP_ID) f.appId = env.FEISHU_APP_ID;
  if (env.FEISHU_APP_SECRET) f.appSecret = env.FEISHU_APP_SECRET;
  if (env.FEISHU_BASE_TOKEN) f.baseToken = env.FEISHU_BASE_TOKEN;
  if (env.FEISHU_TABLE_ID) f.tableId = env.FEISHU_TABLE_ID;
  if (env.FEISHU_URL) f.url = env.FEISHU_URL;
  if (env.FEISHU_AS) f.as = env.FEISHU_AS;

  if (env.TIKTOK_PROXY) config.proxy = env.TIKTOK_PROXY;
  if (env.TIKTOK_CHROME_PATH) config.chromePath = env.TIKTOK_CHROME_PATH;

  return config;
}

/** 读取配置；configPath 为空时用项目根的 config.json */
function loadConfig(configPath) {
  const p = configPath ? path.resolve(configPath) : path.join(ROOT, 'config.json');
  return applyEnvOverrides(JSON.parse(fs.readFileSync(p, 'utf8')));
}

module.exports = { loadConfig, applyEnvOverrides, ROOT };
