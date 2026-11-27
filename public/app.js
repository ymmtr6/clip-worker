// 縦スワイプのショートフィード。画面に入った1本だけ再生し、前後1本ずつだけ src を持たせる。
const feed = document.getElementById("feed");
const template = document.getElementById("slide-template");
const muteButton = document.getElementById("mute");
const tagChip = document.getElementById("tag-chip");
const empty = document.getElementById("empty");
const grid = document.getElementById("grid");
const gridToggle = document.getElementById("grid-toggle");
const orderButton = document.getElementById("order");

const params = new URLSearchParams(location.search);
const tag = params.get("tag");

const state = {
  slides: [],
  cursor: null,
  done: false,
  loading: false,
  active: -1,
  muted: localStorage.getItem("clip:muted") !== "0",
  viewed: new Set(),
  // 公開モードでは /api/me が通らないので削除ボタンを出さない
  canDelete: false,
  generation: 0,
  // 並び順（新着／シャッフル）はミュートと同じく端末に保存する
  shuffled: localStorage.getItem("clip:order") === "shuffle",
};

/** 再生として数えるまでの秒数 */
const VIEW_AFTER_SECONDS = 2;
/** 残りがこの本数になったら次のページを読む */
const PREFETCH_REMAINING = 3;

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** YouTube なら開始位置つきのリンクにする */
function sourceHref(source) {
  if (!source?.url) return null;
  if (!source.start_seconds) return source.url;
  try {
    const url = new URL(source.url);
    if (/(^|\.)youtube\.com$|^youtu\.be$/.test(url.hostname)) url.searchParams.set("t", `${source.start_seconds}s`);
    return url.toString();
  } catch {
    return source.url;
  }
}

async function api(path, init) {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json();
}

function renderMute() {
  muteButton.textContent = state.muted ? "🔇" : "🔊";
  for (const slide of state.slides) slide.video.muted = state.muted;
}

function buildSlide(clip) {
  const node = template.content.firstElementChild.cloneNode(true);
  const video = node.querySelector("video");
  const bar = node.querySelector(".progress > div");
  video.muted = state.muted;
  if (clip.poster_url) video.poster = clip.poster_url;

  node.querySelector(".title").textContent = clip.title;
  node.querySelector(".desc").textContent = clip.description ?? "";

  const tags = node.querySelector(".tags");
  for (const name of clip.tags) {
    const link = document.createElement("a");
    link.href = `/?tag=${encodeURIComponent(name)}`;
    link.textContent = `#${name}`;
    tags.append(link);
  }

  const source = node.querySelector(".source");
  const href = sourceHref(clip.source);
  if (href) {
    source.href = href;
    const at = clip.source.start_seconds ? ` ${formatTime(clip.source.start_seconds)}〜` : "";
    source.textContent = `元動画${at} ▸ ${clip.source.title ?? new URL(href).hostname}`;
  }

  const slide = { clip, node, video, index: state.slides.length, retried: false };

  node.addEventListener("click", (event) => {
    if (event.target.closest("a, button")) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  video.addEventListener("play", () => node.classList.remove("is-paused"));
  video.addEventListener("pause", () => node.classList.add("is-paused"));
  video.addEventListener("timeupdate", () => {
    if (video.duration) bar.style.width = `${(video.currentTime / video.duration) * 100}%`;
    if (video.currentTime >= VIEW_AFTER_SECONDS && !state.viewed.has(clip.id)) {
      state.viewed.add(clip.id);
      api(`/api/clips/${encodeURIComponent(clip.id)}/view`, { method: "POST" }).catch(() => {});
    }
  });
  // 署名付き URL が切れていたら取り直す。取り直しても駄目なら諦める
  video.addEventListener("error", async () => {
    if (slide.retried) return;
    slide.retried = true;
    try {
      const { clip: fresh } = await api(`/api/clips/${encodeURIComponent(clip.id)}`);
      slide.clip = fresh;
      const position = video.currentTime;
      video.src = fresh.video_url;
      video.currentTime = position;
      if (slide.index === state.active) video.play().catch(() => {});
    } catch {}
  });

  const deleteButton = node.querySelector(".delete");
  deleteButton.hidden = !state.canDelete;
  deleteButton.addEventListener("click", async () => {
    if (!confirm(`「${clip.title}」を削除しますか？`)) return;
    await api(`/api/clips/${encodeURIComponent(clip.id)}`, { method: "DELETE" });
    video.removeAttribute("src");
    video.load();
    node.remove();
    slide.tile?.remove();
  });

  slide.tile = buildTile(slide);
  return slide;
}

/** 一覧のサムネイル。ポスターが無ければ動画の先頭付近を見せる */
function buildTile(slide) {
  const { clip } = slide;
  const tile = document.createElement("button");
  tile.className = "tile";
  if (clip.poster_url) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = clip.poster_url;
    tile.append(img);
  } else {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = `${clip.video_url}#t=0.5`;
    tile.append(video);
  }
  const caption = document.createElement("div");
  caption.className = "caption";
  caption.textContent = clip.title;
  const views = document.createElement("span");
  views.textContent = `▶ ${clip.view_count}`;
  caption.append(views);
  tile.append(caption);
  tile.addEventListener("click", () => {
    showGrid(false);
    slide.node.scrollIntoView({ behavior: "instant" });
    if (slide.index === state.active) slide.video.play().catch(() => {});
  });
  return tile;
}

function showGrid(visible) {
  grid.hidden = !visible;
  gridToggle.textContent = visible ? "✕" : "▦";
  gridToggle.setAttribute("aria-label", visible ? "フィードに戻る" : "一覧");
  if (visible) state.slides[state.active]?.video.pause();
}

function renderOrder() {
  orderButton.textContent = state.shuffled ? "🔀" : "🕒";
  orderButton.title = state.shuffled ? "シャッフル（クリックで新着順）" : "新着順（クリックでシャッフル）";
}

/** 並び順を変えたら最初から読み直す */
function resetFeed() {
  for (const slide of state.slides) {
    observer.unobserve(slide.node);
    slide.video.pause();
    slide.video.removeAttribute("src");
    slide.video.load();
  }
  feed.replaceChildren();
  grid.replaceChildren();
  Object.assign(state, { slides: [], cursor: null, done: false, loading: false, active: -1, generation: state.generation + 1 });
  feed.scrollTop = 0;
  loadMore();
}

/** 前後1本まで src を持たせ、それより遠いものは外してメモリと帯域を返す */
function updateSources() {
  for (const slide of state.slides) {
    const near = Math.abs(slide.index - state.active) <= 1;
    const hasSrc = slide.video.hasAttribute("src");
    if (near && !hasSrc) {
      slide.video.preload = slide.index === state.active ? "auto" : "metadata";
      slide.video.src = slide.clip.video_url;
    } else if (!near && hasSrc) {
      slide.video.pause();
      slide.video.removeAttribute("src");
      slide.video.load();
    }
  }
}

function activate(index) {
  if (index === state.active) return;
  state.active = index;
  updateSources();
  for (const slide of state.slides) {
    if (slide.index === index) {
      slide.video.currentTime = 0;
      slide.video.play().catch(() => {
        // 音ありの自動再生が拒否されたら、ミュートにして再生し直す
        if (!slide.video.muted) {
          state.muted = true;
          renderMute();
          slide.video.play().catch(() => {});
        }
      });
    } else {
      slide.video.pause();
    }
  }
  if (state.slides.length - index <= PREFETCH_REMAINING) loadMore();
}

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) activate(Number(entry.target.dataset.index));
  }
}, { root: feed, threshold: 0.6 });

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  const generation = state.generation;
  try {
    const query = new URLSearchParams();
    if (state.cursor) query.set("cursor", state.cursor);
    if (tag) query.set("tag", tag);
    if (state.shuffled) query.set("order", "shuffle");
    const page = await api(`/api/feed?${query}`);
    // 読み込み中に並び順を変えたら、古い並びの結果は捨てる
    if (generation !== state.generation) return;
    for (const clip of page.clips) {
      const slide = buildSlide(clip);
      slide.node.dataset.index = String(slide.index);
      state.slides.push(slide);
      feed.append(slide.node);
      grid.append(slide.tile);
      observer.observe(slide.node);
    }
    state.cursor = page.next_cursor;
    state.done = !page.next_cursor;
    empty.hidden = state.slides.length > 0;
  } catch (error) {
    console.error(error);
  } finally {
    if (generation === state.generation) state.loading = false;
  }
}

function scrollBy(delta) {
  const next = state.slides[state.active + delta];
  next?.node.scrollIntoView({ behavior: "smooth" });
}

gridToggle.addEventListener("click", () => showGrid(grid.hidden));

orderButton.addEventListener("click", () => {
  state.shuffled = !state.shuffled;
  localStorage.setItem("clip:order", state.shuffled ? "shuffle" : "latest");
  renderOrder();
  resetFeed();
});

// 一覧の末尾近くまで来たら次のページを読む
grid.addEventListener("scroll", () => {
  if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 400) loadMore();
});

muteButton.addEventListener("click", () => {
  state.muted = !state.muted;
  localStorage.setItem("clip:muted", state.muted ? "1" : "0");
  renderMute();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "j") scrollBy(1);
  else if (event.key === "ArrowUp" || event.key === "k") scrollBy(-1);
  else if (event.key === "m") muteButton.click();
  else if (event.key === " ") {
    event.preventDefault();
    const video = state.slides[state.active]?.video;
    if (video) video.paused ? video.play() : video.pause();
  } else return;
});

// タブを離れたら止める
document.addEventListener("visibilitychange", () => {
  if (document.hidden) state.slides[state.active]?.video.pause();
});

if (tag) {
  tagChip.hidden = false;
  tagChip.textContent = `#${tag} ✕`;
  tagChip.addEventListener("click", () => { location.href = "/"; });
}

renderMute();
renderOrder();
showGrid(false);
fetch("/api/me", { credentials: "same-origin" }).then((response) => {
  state.canDelete = response.ok;
  for (const slide of state.slides) slide.node.querySelector(".delete").hidden = !state.canDelete;
}).catch(() => {});
loadMore();
