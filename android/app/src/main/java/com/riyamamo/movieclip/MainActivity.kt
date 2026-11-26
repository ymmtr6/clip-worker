package com.riyamamo.movieclip

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import kotlinx.coroutines.delay

private val Accent = Color(0xFFFF3B5C)

class MainActivity : ComponentActivity() {
    private val model: FeedViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleAuthCallback(intent)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Accent)) {
                if (model.needsLogin) {
                    LoginScreen(onLogin = ::startLogin)
                } else {
                    FeedScreen(model)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleAuthCallback(intent)
    }

    // Google は WebView 内の OAuth を拒否するので、Custom Tabs で Access を通す
    private fun startLogin() {
        CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(Server.origin + "api/app-auth"))
    }

    private fun handleAuthCallback(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "movieclip" || uri.host != "auth") return
        uri.getQueryParameter("token")?.takeIf { it.isNotEmpty() }?.let(model::onSignedIn)
        intent.data = null
    }
}

@Composable
private fun LoginScreen(onLogin: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().background(Color.Black),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Clip", color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black)
        Spacer(Modifier.height(24.dp))
        Button(onClick = onLogin, colors = ButtonDefaults.buttonColors(containerColor = Accent)) {
            Text("ログイン", modifier = Modifier.padding(horizontal = 48.dp, vertical = 4.dp))
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FeedScreen(model: FeedViewModel) {
    val context = LocalContext.current
    val pool = remember { PlayerPool(context.applicationContext) }
    val pagerState = rememberPagerState { model.clips.size }

    DisposableEffect(Unit) {
        pool.onViewed = model::recordView
        pool.onFailed = model::refresh
        if (model.clips.isEmpty()) model.loadMore()
        onDispose { pool.releaseAll() }
    }

    // 画面に止まったページだけを再生する。クリップの差し替え（URL の取り直し）でも用意し直す
    LaunchedEffect(pagerState) {
        snapshotFlow { pagerState.settledPage to model.clips.toList() }.collect { (page, clips) ->
            if (page !in clips.indices) return@collect
            pool.prepare(clips, page)
            if (pool.activeId != clips[page].id) pool.activate(clips[page].id)
            model.loadMoreIfNeeded(page)
        }
    }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> pool.pauseAll()
                Lifecycle.Event.ON_START -> pool.resume()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        VerticalPager(
            state = pagerState,
            beyondViewportPageCount = 1,
            key = { model.clips[it].id },
            modifier = Modifier.fillMaxSize(),
        ) { page ->
            val clip = model.clips[page]
            ClipPage(
                clip = clip,
                pool = pool,
                isActive = pool.activeId == clip.id,
                onTag = { tag ->
                    pool.releaseAll()
                    model.reload(tag)
                },
                onDelete = if (model.canDelete) ({ model.delete(clip.id) }) else null,
            )
        }

        TopBar(
            tag = model.tag,
            muted = pool.muted,
            onClearTag = {
                pool.releaseAll()
                model.reload(null)
            },
            onToggleMute = pool::toggleMute,
        )

        if (model.clips.isEmpty()) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                if (model.loading || !model.loadedOnce) {
                    CircularProgressIndicator(color = Color.White)
                } else {
                    Text(model.errorMessage ?: "まだ切り抜きがありません", color = Color.Gray)
                    TextButton(onClick = { model.reload(model.tag) }) { Text("再読み込み") }
                }
            }
        }
    }
}

@Composable
private fun TopBar(tag: String?, muted: Boolean, onClearTag: () -> Unit, onToggleMute: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 14.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Clip", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Black)
        if (tag != null) {
            Spacer(Modifier.width(10.dp))
            Row(
                modifier = Modifier
                    .background(Color.White.copy(alpha = 0.18f), RoundedCornerShape(50))
                    .clickable(onClick = onClearTag)
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("#$tag", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(4.dp))
                Icon(Icons.Default.Close, contentDescription = "絞り込みを解除", tint = Color.White, modifier = Modifier.size(14.dp))
            }
        }
        Spacer(Modifier.weight(1f))
        RoundIconButton(onClick = onToggleMute) {
            Icon(
                if (muted) Icons.AutoMirrored.Filled.VolumeOff else Icons.AutoMirrored.Filled.VolumeUp,
                contentDescription = "音声のオン/オフ",
                tint = Color.White,
            )
        }
    }
}

@Composable
private fun RoundIconButton(onClick: () -> Unit, content: @Composable () -> Unit) {
    IconButton(
        onClick = onClick,
        modifier = Modifier.size(44.dp).background(Color.Black.copy(alpha = 0.35f), CircleShape),
    ) { content() }
}

@androidx.annotation.OptIn(UnstableApi::class)
@Composable
private fun ClipPage(clip: Clip, pool: PlayerPool, isActive: Boolean, onTag: (String) -> Unit, onDelete: (() -> Unit)?) {
    val context = LocalContext.current
    var confirmingDelete by remember { mutableStateOf(false) }
    var progress by remember { mutableFloatStateOf(0f) }
    val player = pool.player(clip.id)

    LaunchedEffect(isActive) {
        progress = 0f
        while (isActive) {
            progress = pool.progress()
            delay(100)
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                if (isActive) pool.togglePause()
            },
    ) {
        if (clip.posterUrl != null) {
            AsyncImage(
                model = clip.posterUrl,
                contentDescription = null,
                contentScale = if (clip.isLandscape) ContentScale.Fit else ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        if (player != null) {
            AndroidView(
                factory = { ctx ->
                    PlayerView(ctx).apply {
                        useController = false
                        setShutterBackgroundColor(android.graphics.Color.TRANSPARENT)
                        setKeepContentOnPlayerReset(true)
                    }
                },
                update = { view ->
                    view.player = player
                    view.resizeMode = if (clip.isLandscape) AspectRatioFrameLayout.RESIZE_MODE_FIT else AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                },
                onRelease = { view -> view.player = null },
                modifier = Modifier.fillMaxSize(),
            )
        }
        if (isActive && pool.isPaused) {
            Icon(
                Icons.Default.PlayArrow,
                contentDescription = null,
                tint = Color.White.copy(alpha = 0.85f),
                modifier = Modifier.align(Alignment.Center).size(72.dp),
            )
        }

        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.7f))))
                    .padding(start = 16.dp, end = 12.dp, top = 48.dp, bottom = 16.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(clip.title, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    clip.description?.let {
                        Text(it, color = Color.White.copy(alpha = 0.75f), fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    if (clip.tags.isNotEmpty()) {
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            clip.tags.forEach { tag ->
                                Text("#$tag", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.clickable { onTag(tag) })
                            }
                        }
                    }
                    clip.sourceLink?.let { link ->
                        Text(
                            sourceLabel(clip),
                            color = Color.White.copy(alpha = 0.8f),
                            fontSize = 12.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier
                                .border(1.dp, Color.White.copy(alpha = 0.3f), RoundedCornerShape(6.dp))
                                .clickable { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                }
                Spacer(Modifier.width(12.dp))
                if (onDelete != null) {
                    RoundIconButton(onClick = { confirmingDelete = true }) {
                        Icon(Icons.Default.Delete, contentDescription = "削除", tint = Color.White)
                    }
                }
            }
            Box(Modifier.fillMaxWidth().height(2.dp).background(Color.White.copy(alpha = 0.15f))) {
                Box(Modifier.fillMaxWidth(progress).height(2.dp).background(Accent))
            }
            Spacer(Modifier.navigationBarsPadding())
        }
    }

    if (confirmingDelete) {
        AlertDialog(
            onDismissRequest = { confirmingDelete = false },
            title = { Text("「${clip.title}」を削除しますか？") },
            confirmButton = {
                TextButton(onClick = { confirmingDelete = false; onDelete?.invoke() }) { Text("削除", color = Accent) }
            },
            dismissButton = { TextButton(onClick = { confirmingDelete = false }) { Text("キャンセル") } },
        )
    }
}

private fun sourceLabel(clip: Clip): String {
    val parts = mutableListOf("元動画")
    clip.source?.startSeconds?.takeIf { it > 0 }?.let { s ->
        val h = s / 3600
        val m = s % 3600 / 60
        parts += if (h > 0) "%d:%02d:%02d〜".format(h, m, s % 60) else "%d:%02d〜".format(m, s % 60)
    }
    (clip.source?.title ?: clip.source?.url?.let { Uri.parse(it).host })?.let { parts += it }
    return parts.joinToString(" ")
}
