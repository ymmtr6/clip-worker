package com.riyamamo.movieclip

import android.content.Context
import android.net.Uri
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class ClipSource(val url: String?, val title: String?, val startSeconds: Int?)

data class Clip(
    val id: String,
    val title: String,
    val description: String?,
    val tags: List<String>,
    val source: ClipSource?,
    val width: Int?,
    val height: Int?,
    val videoUrl: String,
    val posterUrl: String?,
) {
    val isLandscape: Boolean get() = width != null && height != null && width > height

    /** YouTube なら開始位置つきで開く */
    val sourceLink: String?
        get() {
            val url = source?.url ?: return null
            val start = source.startSeconds ?: return url
            val uri = Uri.parse(url)
            val host = uri.host ?: return url
            if (start <= 0 || !(host.endsWith("youtube.com") || host == "youtu.be")) return url
            val builder = uri.buildUpon().clearQuery()
            uri.queryParameterNames.filter { it != "t" }.forEach { name ->
                uri.getQueryParameters(name).forEach { builder.appendQueryParameter(name, it) }
            }
            return builder.appendQueryParameter("t", "${start}s").build().toString()
        }
}

data class FeedPage(val clips: List<Clip>, val nextCursor: String?)

class UnauthorizedException : Exception()

object Server {
    val origin: String = BuildConfig.CLIP_ORIGIN
}

/**
 * Access の JWT を保持する。ログインは Custom Tabs で /api/app-auth を開き、
 * Worker が movieclip://auth?token=... で返してきたものを保存する。
 */
class TokenStore(context: Context) {
    private val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)

    var token: String?
        get() = BuildConfig.DEV_TOKEN.ifEmpty { null }
            ?: prefs.getString("token", null)?.takeUnless { isExpired(it) }
        set(value) = prefs.edit().putString("token", value).apply()

    companion object {
        /** JWT の exp を見る。署名の検証は Access と Worker が行う */
        fun isExpired(token: String): Boolean {
            val parts = token.split(".")
            if (parts.size != 3) return false
            return runCatching {
                val payload = JSONObject(String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)))
                payload.getLong("exp") * 1000 < System.currentTimeMillis()
            }.getOrDefault(false)
        }
    }
}

/** 視聴 API。認証は Access の JWT を cf-access-token ヘッダで送る */
class Api(private val token: String) {

    suspend fun feed(cursor: String?, tag: String?): FeedPage {
        val query = buildList {
            cursor?.let { add("cursor=${encode(it)}") }
            tag?.let { add("tag=${encode(it)}") }
        }.joinToString("&")
        val json = JSONObject(request("GET", "api/feed" + if (query.isEmpty()) "" else "?$query"))
        val clips = json.getJSONArray("clips")
        return FeedPage(
            clips = (0 until clips.length()).map { parseClip(clips.getJSONObject(it)) },
            nextCursor = json.optStringOrNull("next_cursor"),
        )
    }

    suspend fun clip(id: String): Clip =
        parseClip(JSONObject(request("GET", "api/clips/${encode(id)}")).getJSONObject("clip"))

    suspend fun recordView(id: String) {
        request("POST", "api/clips/${encode(id)}/view")
    }

    suspend fun delete(id: String) {
        request("DELETE", "api/clips/${encode(id)}")
    }

    private suspend fun request(method: String, path: String): String = withContext(Dispatchers.IO) {
        val connection = URL(Server.origin + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.setRequestProperty("cf-access-token", token)
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            val status = connection.responseCode
            // Access のセッションが切れているとログイン画面へリダイレクトされる
            if (status == 401 || status == 403 || connection.url.host.endsWith("cloudflareaccess.com")) {
                throw UnauthorizedException()
            }
            if (status !in 200..299) throw java.io.IOException("HTTP $status")
            connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun parseClip(json: JSONObject): Clip {
        val tags = json.optJSONArray("tags")
        val source = json.optJSONObject("source")
        return Clip(
            id = json.getString("id"),
            title = json.getString("title"),
            description = json.optStringOrNull("description"),
            tags = if (tags == null) emptyList() else (0 until tags.length()).map { tags.getString(it) },
            source = source?.let {
                ClipSource(
                    url = it.optStringOrNull("url"),
                    title = it.optStringOrNull("title"),
                    startSeconds = if (it.isNull("start_seconds")) null else it.optInt("start_seconds"),
                )
            },
            width = if (json.isNull("width")) null else json.optInt("width"),
            height = if (json.isNull("height")) null else json.optInt("height"),
            videoUrl = json.getString("video_url"),
            posterUrl = json.optStringOrNull("poster_url"),
        )
    }

    private fun JSONObject.optStringOrNull(name: String): String? =
        if (isNull(name)) null else optString(name).ifEmpty { null }
}
