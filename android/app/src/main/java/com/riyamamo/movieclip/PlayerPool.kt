package com.riyamamo.movieclip

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer

/**
 * 表示中の1本と前後1本ぶんだけ ExoPlayer を持つ。スワイプした先がすでに読み込み済みなので、すぐ再生が始まる。
 * それより遠いものは release してメモリと帯域を返す。
 */
class PlayerPool(private val context: Context) {
    var activeId by mutableStateOf<String?>(null)
        private set
    var isPaused by mutableStateOf(false)
        private set
    var muted by mutableStateOf(context.getSharedPreferences("player", Context.MODE_PRIVATE).getBoolean("muted", false))
        private set

    /** 2 秒見たら呼ぶ（再生回数） */
    var onViewed: (String) -> Unit = {}
    /** 署名付き URL の失効などで読めなかったとき */
    var onFailed: (String) -> Unit = {}

    private class Entry(val url: String, val player: ExoPlayer)

    private val entries = mutableMapOf<String, Entry>()
    private val viewed = mutableSetOf<String>()
    /** entries が変わるたびに進める。player() で読ませて、先読みしたプレイヤーを画面に付け直させる */
    private var version by mutableIntStateOf(0)

    fun player(id: String): ExoPlayer? {
        version
        return entries[id]?.player
    }

    /** index の前後1本を用意し、それ以外を捨てる */
    fun prepare(clips: List<Clip>, index: Int) {
        if (index !in clips.indices) return
        val wanted = clips.subList(maxOf(0, index - 1), minOf(clips.size, index + 2))
        val wantedIds = wanted.map { it.id }.toSet()
        entries.keys.filter { it !in wantedIds }.forEach { id -> entries.remove(id)?.player?.release() }
        for (clip in wanted) {
            // URL が変わった（取り直した）ものは作り直す
            if (entries[clip.id]?.url == clip.videoUrl) continue
            entries.remove(clip.id)?.player?.release()
            entries[clip.id] = Entry(clip.videoUrl, makePlayer(clip))
        }
        version++
    }

    fun activate(id: String) {
        activeId = id
        isPaused = false
        entries.forEach { (entryId, entry) ->
            if (entryId == id) {
                entry.player.seekTo(0)
                entry.player.play()
            } else {
                entry.player.pause()
            }
        }
    }

    /** 進捗バー用。0〜1。あわせて再生回数の判定もする */
    fun progress(): Float {
        val id = activeId ?: return 0f
        val player = entries[id]?.player ?: return 0f
        if (player.currentPosition >= 2_000 && viewed.add(id)) onViewed(id)
        val duration = player.duration
        return if (duration > 0) (player.currentPosition.toFloat() / duration).coerceIn(0f, 1f) else 0f
    }

    fun togglePause() {
        val player = activeId?.let { entries[it]?.player } ?: return
        if (player.isPlaying) player.pause() else player.play()
        isPaused = !player.playWhenReady
    }

    fun toggleMute() {
        muted = !muted
        context.getSharedPreferences("player", Context.MODE_PRIVATE).edit().putBoolean("muted", muted).apply()
        entries.values.forEach { it.player.volume = if (muted) 0f else 1f }
    }

    fun pauseAll() {
        entries.values.forEach { it.player.pause() }
        isPaused = true
    }

    fun resume() {
        if (!isPaused) return
        activeId?.let { entries[it]?.player?.play() }
        isPaused = false
    }

    fun releaseAll() {
        entries.values.forEach { it.player.release() }
        entries.clear()
        activeId = null
        version++
    }

    private fun makePlayer(clip: Clip): ExoPlayer {
        // ショートは短いので、先読みは控えめでも途切れない
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(2_500, 10_000, 500, 1_000)
            .build()
        return ExoPlayer.Builder(context).setLoadControl(loadControl).build().apply {
            repeatMode = Player.REPEAT_MODE_ONE
            volume = if (muted) 0f else 1f
            setMediaItem(MediaItem.fromUri(clip.videoUrl))
            addListener(object : Player.Listener {
                override fun onPlayerError(error: PlaybackException) {
                    onFailed(clip.id)
                }
            })
            prepare()
        }
    }
}
