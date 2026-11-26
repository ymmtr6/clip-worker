#!/usr/bin/env node
// Cloudflare Access のアプリを2つ作り、視聴側の AUD を wrangler.jsonc に書き込む。
//   node scripts/setup-access.mjs <許可するメールアドレス>
// トークンは環境変数 CF_API_TOKEN か ~/.cf_access_token（Access: Apps and Policies の編集権限が必要）。
// 同じ domain のアプリがすでにあれば作らずにそれを使う。
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const ACCOUNT_ID = "6c287adaf8d7a8b27d948313c9c96a86";
const HOST = "clip.riyamamo.com";

const email = process.argv[2];
if (!email) {
  console.error("usage: node scripts/setup-access.mjs <email>");
  process.exit(1);
}
const token = (process.env.CF_API_TOKEN ?? readFileSync(`${homedir()}/.cf_access_token`, "utf8")).trim();
const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/apps`;

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`${method} ${url}: ${JSON.stringify(json.errors)}`);
  return json.result;
}

const existing = await call("GET", `${base}?per_page=100`);

async function ensure(app) {
  const found = existing.find((a) => a.domain === app.domain);
  if (found) {
    console.log(`既存: ${found.name} (${found.domain})`);
    return found;
  }
  const created = await call("POST", base, app);
  console.log(`作成: ${created.name} (${created.domain})`);
  return created;
}

const viewer = await ensure({
  name: "Clip",
  domain: HOST,
  type: "self_hosted",
  session_duration: "720h",
  app_launcher_visible: true,
  policies: [{ name: "owner", decision: "allow", include: [{ email: { email } }] }],
});

await ensure({
  name: "Clip bot API",
  domain: `${HOST}/api/v1`,
  type: "self_hosted",
  session_duration: "24h",
  app_launcher_visible: false,
  policies: [{ name: "bots", decision: "bypass", include: [{ everyone: {} }] }],
});

const path = new URL("../wrangler.jsonc", import.meta.url);
const config = readFileSync(path, "utf8");
writeFileSync(path, config.replace(/"ACCESS_AUD": "[^"]*"/, `"ACCESS_AUD": "${viewer.aud}"`));
console.log(`wrangler.jsonc の ACCESS_AUD を ${viewer.aud} にした。続けて npm run deploy`);
