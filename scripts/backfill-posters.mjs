#!/usr/bin/env node
// ポスターの無い公開済みクリップに、動画から切り出した1コマをポスターとして付ける（ffmpeg が必要）。
//
//   CLIP_TOKEN=mc_... node scripts/backfill-posters.mjs [--limit N] [--dry-run]
//   CLIP_API=http://localhost:8787/api/v1 で接続先を変えられる
//
// 何度実行しても、ポスターが付いたものは飛ばすので途中で止めても続きからやり直せる。
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const api = process.env.CLIP_API ?? "https://clip.riyamamo.com/api/v1";
const token = process.env.CLIP_TOKEN;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
/** 同時に処理する本数 */
const CONCURRENCY = 4;

if (!token) {
  console.error("usage: CLIP_TOKEN=mc_... node scripts/backfill-posters.mjs [--limit N] [--dry-run]");
  process.exit(1);
}

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

async function listWithoutPoster() {
  const found = [];
  let cursor = "";
  do {
    const page = await call("GET", `/clips?limit=30${cursor ? `&cursor=${cursor}` : ""}`);
    found.push(...page.clips.filter((clip) => !clip.has_poster));
    cursor = page.next_cursor ?? "";
  } while (cursor);
  return found;
}

/**
 * 1秒目から30コマのうち代表的な1コマ（thumbnail フィルタ）を幅480の JPEG にする。
 * -ss を -i の前に置くと、ffmpeg は Range リクエストで必要な部分だけ読む
 */
async function extractFrame(videoUrl, out) {
  for (const seek of ["1", "0"]) {
    try {
      await run("ffmpeg", ["-loglevel", "error", "-y", "-ss", seek, "-i", videoUrl, "-vf", "thumbnail=30,scale=480:-2", "-frames:v", "1", "-q:v", "4", out]);
      return;
    } catch (error) {
      // 1秒より短い動画は先頭から取り直す
      if (seek === "0") throw error;
    }
  }
}

async function backfill(clip, dir) {
  const { clip: detail } = await call("GET", `/clips/${clip.id}`);
  const out = join(dir, `${clip.id}.jpg`);
  await extractFrame(detail.video_url, out);
  const { upload } = await call("POST", `/clips/${clip.id}/poster`, { content_type: "image/jpeg" });
  const response = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: await readFile(out) });
  if (!response.ok) throw new Error(`PUT poster: ${response.status}`);
  await call("POST", `/clips/${clip.id}/poster/complete`);
}

const targets = (await listWithoutPoster()).slice(0, limit);
console.log(`ポスターの無いクリップ: ${targets.length} 本`);
if (dryRun || targets.length === 0) process.exit(0);

const dir = await mkdtemp(join(tmpdir(), "clip-posters-"));
let done = 0;
let failed = 0;
const queue = [...targets];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let clip = queue.shift(); clip; clip = queue.shift()) {
    try {
      await backfill(clip, dir);
      done += 1;
      console.log(`[${done + failed}/${targets.length}] ${clip.id} ${clip.title}`);
    } catch (error) {
      failed += 1;
      console.error(`[${done + failed}/${targets.length}] 失敗 ${clip.id}: ${error.message}`);
    }
  }
}));
await rm(dir, { recursive: true, force: true });
console.log(`完了: ${done} 本、失敗: ${failed} 本`);
if (failed > 0) process.exit(1);
