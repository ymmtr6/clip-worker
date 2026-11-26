#!/usr/bin/env node
// ボット用トークンを発行し、D1 に SHA-256 だけを書き込む。平文はここで一度だけ表示する。
// Access を設定する前の最初の1本や、ブラウザを使わずに発行したいとき用。
//
//   node scripts/issue-token.mjs grok                      # 本番 D1（全スコープ）
//   node scripts/issue-token.mjs grok read,clips:write     # スコープを絞る
//   node scripts/issue-token.mjs grok --local              # wrangler dev のローカル D1
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const SCOPES = ["read", "clips:write", "clips:delete"];
const args = process.argv.slice(2);
const local = args.includes("--local");
const [name, scopeArg] = args.filter((arg) => !arg.startsWith("--"));

if (!name || !/^[\w.-]{1,64}$/.test(name)) {
  console.error("usage: node scripts/issue-token.mjs <name> [scopes] [--local]");
  process.exit(1);
}
const scopes = scopeArg ? scopeArg.split(",") : SCOPES;
if (scopes.some((scope) => !SCOPES.includes(scope))) {
  console.error(`scopes must be a subset of ${SCOPES.join(",")}`);
  process.exit(1);
}

const id = randomBytes(6).toString("hex");
const secret = randomBytes(24).toString("hex");
const hash = createHash("sha256").update(secret).digest("hex");
const now = Math.floor(Date.now() / 1000);
const sql = `INSERT INTO agent_tokens (id, name, token_hash, scopes, created_at) VALUES ('${id}', '${name}', '${hash}', '${scopes.join(",")}', ${now})`;

execFileSync("npx", ["wrangler", "d1", "execute", "movie-clip", local ? "--local" : "--remote", "--command", sql], { stdio: "inherit" });
console.log(`\n${name} (${scopes.join(",")}):\nmc_${id}_${secret}`);
