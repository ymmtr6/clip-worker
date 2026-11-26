#!/usr/bin/env node
// ボット側の投稿手順の見本。ローカルの動画を「アップロード方式」で投稿する。
//
//   CLIP_TOKEN=mc_... node scripts/post-clip.mjs clip.mp4 "タイトル" [poster.jpg]
//   CLIP_API=http://localhost:8787/api/v1 で接続先を変えられる
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const api = process.env.CLIP_API ?? "https://clip.riyamamo.com/api/v1";
const token = process.env.CLIP_TOKEN;
const [videoPath, title, posterPath] = process.argv.slice(2);
if (!token || !videoPath || !title) {
  console.error('usage: CLIP_TOKEN=mc_... node scripts/post-clip.mjs <video> "<title>" [poster]');
  process.exit(1);
}

const types = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const typeOf = (path) => types[extname(path).toLowerCase()];

async function call(method, path, body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

// 1. 枠を作る（external_id を付けておけば、途中で落ちても再実行で続きからやり直せる）
const created = await call("POST", "/clips", {
  title,
  external_id: `local:${videoPath}`,
  video: { content_type: typeOf(videoPath) },
  ...(posterPath ? { poster: { content_type: typeOf(posterPath) } } : {}),
});
console.log("clip:", created.clip.id, created.clip.status);
if (created.clip.status === "ready") process.exit(0);

// 2. 署名付き URL へ PUT する（headers の Content-Type をそのまま付ける）
for (const [part, path] of [["video", videoPath], ["poster", posterPath]]) {
  const upload = created.uploads?.[part];
  if (!upload || !path) continue;
  const response = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: await readFile(path) });
  if (!response.ok) throw new Error(`PUT ${part}: ${response.status}`);
  console.log(`uploaded ${part}`);
}

// 3. 公開する
const done = await call("POST", `/clips/${created.clip.id}/complete`);
console.log("published:", done.clip.id, done.clip.status);
