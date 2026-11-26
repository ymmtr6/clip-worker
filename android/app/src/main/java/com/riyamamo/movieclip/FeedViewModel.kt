package com.riyamamo.movieclip

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

class FeedViewModel(application: Application) : AndroidViewModel(application) {
    private val tokens = TokenStore(application)

    var signedIn by mutableStateOf(tokens.token != null)
        private set
    val clips = mutableStateListOf<Clip>()
    var loading by mutableStateOf(false)
        private set
    var loadedOnce by mutableStateOf(false)
        private set
    var tag by mutableStateOf<String?>(null)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set

    private var cursor: String? = null
    private var done = false
    /** 取り直しが続けて失敗するときに、同じ動画で無限に取り直さないようにする */
    private val refreshedAt = mutableMapOf<String, Long>()

    /** 残りがこの本数になったら次のページを読む */
    private val prefetchRemaining = 3

    private val api: Api? get() = tokens.token?.let { Api(it) }

    fun onSignedIn(token: String) {
        tokens.token = token
        signedIn = true
        reload(null)
    }

    fun reload(tag: String?) {
        this.tag = tag
        cursor = null
        done = false
        clips.clear()
        loadedOnce = false
        loadMore()
    }

    fun loadMoreIfNeeded(currentIndex: Int) {
        if (clips.size - currentIndex <= prefetchRemaining) loadMore()
    }

    fun loadMore() {
        val api = api ?: return
        if (loading || done) return
        loading = true
        viewModelScope.launch {
            try {
                val page = api.feed(cursor, tag)
                val known = clips.map { it.id }.toSet()
                clips.addAll(page.clips.filter { it.id !in known })
                cursor = page.nextCursor
                done = page.nextCursor == null
                errorMessage = null
            } catch (e: Exception) {
                handle(e)
            } finally {
                loading = false
                loadedOnce = true
            }
        }
    }

    /** 署名付き URL が切れたものを取り直す */
    fun refresh(id: String) {
        val now = System.currentTimeMillis()
        if (now - (refreshedAt[id] ?: 0) < 10_000) return
        refreshedAt[id] = now
        val api = api ?: return
        viewModelScope.launch {
            try {
                val fresh = api.clip(id)
                val index = clips.indexOfFirst { it.id == id }
                if (index >= 0) clips[index] = fresh
            } catch (e: Exception) {
                handle(e)
            }
        }
    }

    fun recordView(id: String) {
        val api = api ?: return
        viewModelScope.launch { runCatching { api.recordView(id) } }
    }

    fun delete(id: String) {
        val api = api ?: return
        viewModelScope.launch {
            try {
                api.delete(id)
                clips.removeAll { it.id == id }
            } catch (e: Exception) {
                handle(e)
            }
        }
    }

    private fun handle(e: Exception) {
        when (e) {
            is CancellationException -> throw e
            is UnauthorizedException -> {
                tokens.token = null
                signedIn = false
            }
            else -> errorMessage = "読み込めませんでした"
        }
    }
}
