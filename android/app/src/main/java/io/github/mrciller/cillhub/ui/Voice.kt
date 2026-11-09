package io.github.mrciller.cillhub.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.speech.tts.TextToSpeech
import java.util.Locale
import kotlinx.coroutines.delay
import io.github.mrciller.cillhub.data.Message
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mrciller.cillhub.Calls
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.Perm
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.State
import io.github.mrciller.cillhub.data.VoiceState
import io.github.mrciller.cillhub.data.isPrivate
import io.github.mrciller.cillhub.voice.AudioRouter
import io.github.mrciller.cillhub.voice.CallAudio
import io.github.mrciller.cillhub.voice.Media
import io.github.mrciller.cillhub.voice.ScreenQuality
import io.github.mrciller.cillhub.voice.Tile
import io.github.mrciller.cillhub.voice.VStatus
import io.github.mrciller.cillhub.voice.Voice
import io.github.mrciller.cillhub.voice.VoiceUi
import io.livekit.android.renderer.TextureViewRenderer
import livekit.org.webrtc.RendererCommon
import livekit.org.webrtc.VideoTrack

/** Whether the voice screen is on top, so leaving the app can turn it into picture-in-picture (MainActivity). */
val voiceScreenShown = kotlinx.coroutines.flow.MutableStateFlow(false)

private fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

/** One video track drawn into a TextureView (so it can be zoomed and moved); detached when it leaves the screen. */
@Composable
fun VideoView(tile: Tile, mirror: Boolean, fit: Boolean, modifier: Modifier = Modifier) {
    val track = tile.track
    val lk = tile.lk
    fun attach(r: TextureViewRenderer) = runCatching { if (lk != null) lk.addRenderer(r) else track.addSink(r) }
    fun detach(r: TextureViewRenderer, t: Any?) = runCatching { if (t is io.livekit.android.room.track.VideoTrack) t.removeRenderer(r) else (t as? VideoTrack)?.removeSink(r) }
    AndroidView(
        factory = { ctx -> TextureViewRenderer(ctx).apply { init(Media.egl.eglBaseContext, null); setEnableHardwareScaler(true) } },
        update = { r ->
            r.setScalingType(if (fit) RendererCommon.ScalingType.SCALE_ASPECT_FIT else RendererCommon.ScalingType.SCALE_ASPECT_FILL)
            r.setMirror(mirror)
            val key = lk ?: track
            if (r.tag !== key) {
                detach(r, r.tag)
                attach(r)
                r.tag = key
            }
        },
        onRelease = { r -> detach(r, r.tag); r.release() },
        modifier = modifier,
    )
}

/** Tap a voice channel: the voice screen with who is in it, and Join (or Listen for a stage, Call for a DM). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceScreen(channelId: String, start: Boolean = false) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val v by Voice.state.collectAsStateWithLifecycle()
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val ch = state.channels[channelId]
    val here = v.channelId == channelId
    var full by remember { mutableStateOf<String?>(null) }
    var volumeFor by remember { mutableStateOf<String?>(null) }
    var routes by remember { mutableStateOf(false) }
    var share by remember { mutableStateOf(false) }
    var ttsEnabled by rememberSaveable { mutableStateOf(false) }
    var ttsInstance by remember { mutableStateOf<TextToSpeech?>(null) }
    val ringing = Calls.current?.let { it.channelId == channelId && it.state == Calls.State.RINGING } == true

    androidx.compose.runtime.DisposableEffect(ttsEnabled) {
        if (ttsEnabled) {
            val tts = TextToSpeech(ctx.applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    runCatching { ttsInstance?.language = Locale.getDefault() }
                }
            }
            ttsInstance = tts
            onDispose {
                tts.stop()
                tts.shutdown()
                ttsInstance = null
            }
        } else {
            ttsInstance?.stop()
            ttsInstance?.shutdown()
            ttsInstance = null
            onDispose { }
        }
    }

    var lastToastMessage by remember { mutableStateOf<Message?>(null) }
    var showToast by remember { mutableStateOf(false) }
    val channelMessages = state.messages[channelId]

    LaunchedEffect(channelMessages?.size) {
        val latest = channelMessages?.lastOrNull()
        if (latest != null && latest.author.id != state.me?.id) {
            lastToastMessage = latest
            showToast = true
            if (ttsEnabled && ttsInstance != null) {
                val authorName = Sel.memberName(state, ch?.guildId, latest.author.id)
                val text = "$authorName says: ${latest.content}"
                ttsInstance?.speak(text, TextToSpeech.QUEUE_ADD, null, latest.id)
            }
            delay(5000)
            showToast = false
        }
    }

    LaunchedEffect(Unit) { voiceScreenShown.value = true }
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { voiceScreenShown.value = false } }

    // joining asks for the microphone first; without it the call is listen-only
    var pendingJoin by remember { mutableStateOf<(() -> Unit)?>(null) }
    val micAsk = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { pendingJoin?.invoke(); pendingJoin = null }
    fun withMic(f: () -> Unit) = if (granted(ctx, Manifest.permission.RECORD_AUDIO)) f() else { pendingJoin = f; micAsk.launch(Manifest.permission.RECORD_AUDIO) }
    fun join(ring: Boolean = false) = withMic { Voice.join(ch?.guildId, channelId, ring = ring && ch != null && isPrivate(ch)) }
    LaunchedEffect(start) { if (start && !here) join(ring = true) }

    val camAsk = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { if (it) Voice.toggleCamera() }
    val projection = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r -> if (r.resultCode == Activity.RESULT_OK) r.data?.let { Voice.startScreen(it) } }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
        TopAppBar(
            navigationIcon = { IconButton(nav::back) { Ic(R.drawable.ms_arrow_back, s(R.string.back)) } },
            title = {
                Column {
                    Text(ch?.let { Sel.channelName(state, it) } ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
                    val sub = if (here) statusText(ctx, v) else ch?.status
                    if (!sub.isNullOrBlank()) Text(sub, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                }
            },
            actions = {
                if (here) {
                    IconButton({ ttsEnabled = !ttsEnabled }) {
                        Ic(
                            R.drawable.ms_record_voice_over,
                            s(R.string.voice_tts),
                            tint = if (ttsEnabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton({ routes = true }) { Ic(routeIcon(CallAudio.state.collectAsStateWithLifecycle().value.current), s(R.string.voice_audio_output)) }
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
            windowInsets = TopAppBarDefaults.windowInsets.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
        )
        if (here && ch?.status != null) Text(ch.status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
        if (here && v.error != 0) Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(ctx.getString(v.error, v.errorDetail).trim(), color = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Assertive })
                if (v.status == VStatus.ERROR) TextButton({ Voice.retry() }) { Text(s(R.string.retry)) } else TextButton({ Voice.clearError() }) { Text(s(R.string.close)) }
            }
        }
        val people = ch?.let { Sel.voiceUsers(state, it.guildId, it.id) }.orEmpty()
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (people.isEmpty() && !here) EmptyState(R.drawable.ms_volume_up, s(R.string.voice_empty), ch?.status)
            else ParticipantGrid(state, ch, people, if (here) v else null, onOpen = { full = it }, onVolume = { volumeFor = it })

            if (showToast && lastToastMessage != null) {
                val msg = lastToastMessage!!
                val authorName = Sel.memberName(state, ch?.guildId, msg.author.id)
                Surface(
                    shape = MaterialTheme.shapes.extraLarge,
                    color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.95f),
                    shadowElevation = 6.dp,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 16.dp, start = 16.dp, end = 16.dp)
                        .clickable { showToast = false },
                ) {
                    Row(
                        Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(msg.author, 28.dp)
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f, fill = false)) {
                            Text(authorName, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium)
                            Text(msg.content, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
        when {
            ringing -> Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                Button({ Calls.decline(ctx, channelId); nav.back() }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error), shape = Hud) { Text(s(R.string.decline)) }
                Button({ withMic { Calls.answer(ctx, channelId, openApp = false) } }, colors = ButtonDefaults.buttonColors(containerColor = LocalExtra.current.online), shape = Hud) { Text(s(R.string.answer)) }
            }
            here -> Controls(v, ch,
                onCamera = { if (granted(ctx, Manifest.permission.CAMERA)) Voice.toggleCamera() else camAsk.launch(Manifest.permission.CAMERA) },
                onScreen = { if (v.stream) Voice.stopScreen() else share = true })
            ch != null -> Box(Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp), contentAlignment = Alignment.Center) {
                val canJoin = Sel.canJoinVoice(state, ch)
                Button({ join(ring = isPrivate(ch)) }, enabled = canJoin, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = Hud) {
                    Text(s(when { isPrivate(ch) -> if (state.calls.containsKey(ch.id)) R.string.voice_join_call else R.string.start_call; ch.type == 13 -> R.string.voice_listen; else -> R.string.voice_join }))
                }
            }
        }
    }

    full?.let { key -> v.tiles.firstOrNull { it.key == key }?.let { t -> FullVideo(state, ch, t) { full = null } } ?: run { full = null } }
    volumeFor?.let { u -> VolumeSheet(state, ch?.guildId, u) { volumeFor = null } }
    if (routes) RouteSheet { routes = false }
    if (share) ShareDialog(onDismiss = { share = false }) {
        share = false
        projection.launch(ctx.getSystemService(MediaProjectionManager::class.java).createScreenCaptureIntent())
    }
}

fun statusText(ctx: Context, v: VoiceUi): String = when (v.status) {
    VStatus.WAITING, VStatus.CONNECTING -> ctx.getString(R.string.voice_connecting)
    VStatus.CONNECTED -> ctx.getString(if (v.held) R.string.voice_on_hold else R.string.voice_connected_via, v.backend ?: "")
    VStatus.ERROR -> ctx.getString(R.string.voice_disconnected)
    VStatus.UNCONFIGURED -> ctx.getString(R.string.voice_err_unconfigured)
    VStatus.IDLE -> ""
}

fun routeIcon(d: AudioRouter.Device?) = when (d?.type) {
    AudioRouter.Type.EARPIECE -> R.drawable.ms_phone_in_talk
    AudioRouter.Type.WIRED -> R.drawable.ms_headphones
    AudioRouter.Type.BLUETOOTH -> R.drawable.ms_bluetooth
    else -> R.drawable.ms_volume_up
}

private fun routeLabel(ctx: Context, d: AudioRouter.Device) = when (d.type) {
    AudioRouter.Type.EARPIECE -> ctx.getString(R.string.route_earpiece)
    AudioRouter.Type.SPEAKER -> ctx.getString(R.string.route_speaker)
    AudioRouter.Type.WIRED -> ctx.getString(R.string.route_wired)
    AudioRouter.Type.BLUETOOTH -> d.name.ifBlank { ctx.getString(R.string.route_bluetooth) }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ParticipantGrid(state: State, ch: Channel?, people: List<VoiceState>, v: VoiceUi?, onOpen: (String) -> Unit, onVolume: (String) -> Unit) {
    val me = state.me?.id
    val nav = LocalNav.current
    val tiles = v?.tiles.orEmpty()
    val screens = tiles.filter { it.screen }
    LazyVerticalGrid(GridCells.Adaptive(150.dp), Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items(screens, key = { it.key }, span = { GridItemSpan(maxLineSpan) }) { t ->
            val name = Sel.memberName(state, ch?.guildId, t.userId)
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(MaterialTheme.shapes.large).background(Color.Black)
                .then(if (t.local) Modifier else Modifier.clickable(onClickLabel = s(R.string.voice_full_screen)) { onOpen(t.key) })
                .semantics(mergeDescendants = true) { contentDescription = name }) {
                // our own share would show this screen inside itself: a note instead
                if (t.local) Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.secondaryContainer).padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Ic(R.drawable.ms_screen_share, null, Modifier.size(36.dp), MaterialTheme.colorScheme.onSecondaryContainer)
                    Text(s(R.string.voice_you_share), Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.onSecondaryContainer, style = MaterialTheme.typography.titleSmall)
                    TextButton({ Voice.stopScreen() }) { Text(s(R.string.voice_stop_share)) }
                }
                else VideoView(t, mirror = false, fit = true, modifier = Modifier.fillMaxSize())
                if (!t.local) Label(s(R.string.voice_screen_of, name), Modifier.align(Alignment.BottomStart))
            }
        }
        items(people, key = { it.userId }) { p ->
            val cam = tiles.firstOrNull { it.userId == p.userId && !it.screen }
            val speaking = v?.speaking?.contains(p.userId) == true
            val name = Sel.memberName(state, ch?.guildId, p.userId)
            val ctx = LocalContext.current
            val desc = listOfNotNull(
                name,
                ctx.getString(R.string.voice_speaking).takeIf { speaking },
                ctx.getString(R.string.voice_server_muted).takeIf { p.mute }, ctx.getString(R.string.voice_server_deafened).takeIf { p.deaf },
                ctx.getString(R.string.voice_muted).takeIf { p.selfMute && !p.mute }, ctx.getString(R.string.voice_deafened).takeIf { p.selfDeaf && !p.deaf },
                ctx.getString(R.string.voice_live).takeIf { p.selfStream }, v?.effects?.get(p.userId),
            ).joinToString(", ")
            Box(
                Modifier.fillMaxWidth().aspectRatio(1f).clip(MaterialTheme.shapes.large)
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                    .border(if (speaking) 3.dp else 0.dp, if (speaking) LocalExtra.current.online else Color.Transparent, MaterialTheme.shapes.large)
                    .combinedClickable(
                        onClickLabel = if (cam != null) s(R.string.voice_full_screen) else null,
                        onLongClickLabel = if (p.userId != me) s(R.string.voice_user_volume) else null,
                        onLongClick = if (p.userId != me) ({ onVolume(p.userId) }) else null,
                    ) { if (cam != null) onOpen(cam.key) else nav.openProfile(p.userId, ch?.guildId) }
                    .semantics(mergeDescendants = true) { contentDescription = desc },
                contentAlignment = Alignment.Center,
            ) {
                if (cam != null) VideoView(cam, mirror = cam.local && (v?.frontCamera ?: true), fit = false, modifier = Modifier.fillMaxSize())
                else Avatar(state.users[p.userId], 72.dp, modifier = Modifier.speakingRing(speaking, LocalExtra.current.online))
                Row(Modifier.align(Alignment.BottomStart).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Label(name)
                    if (p.mute || p.selfMute || p.deaf || p.selfDeaf) {
                        Spacer(Modifier.width(4.dp))
                        Ic(if (p.deaf || p.selfDeaf) R.drawable.ms_headset_off else R.drawable.ms_mic_off, null, Modifier.size(18.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)).padding(2.dp),
                            if (p.mute || p.deaf) MaterialTheme.colorScheme.error else Color.White)
                    }
                }
                v?.effects?.get(p.userId)?.let { Text(it, Modifier.align(Alignment.TopEnd).padding(8.dp), style = MaterialTheme.typography.headlineSmall) }
                if (p.selfStream) Text(s(R.string.voice_live).uppercase(), Modifier.align(Alignment.TopStart).padding(8.dp).clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.error).padding(horizontal = 6.dp, vertical = 2.dp),
                    color = MaterialTheme.colorScheme.onError, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun Label(text: String, modifier: Modifier = Modifier) =
    Text(text, modifier.padding(6.dp).clip(MaterialTheme.shapes.small).background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 6.dp, vertical = 2.dp),
        color = Color.White, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)

@Composable
private fun Controls(v: VoiceUi, ch: Channel?, onCamera: () -> Unit, onScreen: () -> Unit) {
    val ctx = LocalContext.current
    val state = Session.store.state.collectAsStateWithLifecycle().value
    val canVideo = ch == null || isPrivate(ch) || (ch.type != 13 && Sel.can(state, ch, Perm.STREAM))
    val ptt = Voice.prefs.pushToTalk
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer).navigationBarsPadding().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (ptt) {
            val talk = s(R.string.voice_push_to_talk_hold)
            Box(Modifier.padding(bottom = 12.dp).size(width = 220.dp, height = 56.dp).clip(Hud)
                .background(if (v.talking) LocalExtra.current.online else MaterialTheme.colorScheme.secondaryContainer)
                .pointerInput(Unit) { detectTapGestures(onPress = { Voice.setTalking(true); tryAwaitRelease(); Voice.setTalking(false) }) }
                .semantics { contentDescription = talk; stateDescription = if (v.talking) ctx.getString(R.string.voice_talking) else "" },
                contentAlignment = Alignment.Center) { Text(talk, fontWeight = FontWeight.SemiBold) }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            Toggle(v.selfMute, R.drawable.ms_mic_off, R.drawable.ms_mic, if (v.selfMute) R.string.voice_unmute else R.string.voice_mute) { Voice.setSelfMute(!v.selfMute) }
            Toggle(v.selfDeaf, R.drawable.ms_headset_off, R.drawable.ms_headphones, if (v.selfDeaf) R.string.voice_undeafen else R.string.voice_deafen) { Voice.setSelfDeaf(!v.selfDeaf) }
            if (canVideo) Toggle(v.video, R.drawable.ms_videocam, R.drawable.ms_videocam_off, if (v.video) R.string.voice_camera_off else R.string.voice_camera_on, active = true, onClick = onCamera)
            if (v.video) FilledTonalIconButton({ Voice.flipCamera() }, Modifier.size(52.dp)) { Ic(R.drawable.ms_cameraswitch, s(R.string.voice_flip_camera)) }
            if (canVideo) Toggle(v.stream, R.drawable.ms_stop_screen_share, R.drawable.ms_screen_share, if (v.stream) R.string.voice_stop_share else R.string.voice_share_screen, active = true, onClick = onScreen)
            FilledIconButton({ Voice.leave() }, Modifier.size(52.dp), colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.error)) {
                Ic(R.drawable.ms_call_end, s(R.string.voice_leave), tint = MaterialTheme.colorScheme.onError)
            }
        }
    }
}

/** A round toggle; [active] marks "on" as the highlighted state (camera, screen) instead of a warning (mute, deafen). */
@Composable
private fun Toggle(on: Boolean, onIcon: Int, offIcon: Int, label: Int, active: Boolean = false, onClick: () -> Unit) {
    val ctx = LocalContext.current
    val colors = when {
        on && active -> IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.primary)
        on -> IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer)
        else -> IconButtonDefaults.filledTonalIconButtonColors()
    }
    FilledIconButton(onClick, Modifier.size(52.dp).semantics { stateDescription = ctx.getString(if (on) R.string.on else R.string.off) }, colors = colors) { Ic(if (on) onIcon else offIcon, s(label)) }
}

/** A video full screen: pinch to zoom, drag to move, double tap to reset; picture-in-picture from here too. */
@Composable
private fun FullVideo(state: State, ch: Channel?, t: Tile, close: () -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val zoom = rememberTransformableState { z, pan, _ -> scale = (scale * z).coerceIn(1f, 6f); offset = if (scale == 1f) Offset.Zero else offset + pan }
    val activity = LocalContext.current as? Activity
    Dialog(close, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            Box(Modifier.fillMaxSize().transformable(zoom).pointerInput(Unit) { detectTapGestures(onDoubleTap = { scale = 1f; offset = Offset.Zero }) }
                .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y)) {
                VideoView(t, mirror = t.local && !t.screen && Voice.state.value.frontCamera, fit = true, modifier = Modifier.fillMaxSize())
            }
            Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(close) { Ic(R.drawable.ms_fullscreen_exit, s(R.string.voice_exit_full_screen), tint = Color.White) }
                Text(Sel.memberName(state, ch?.guildId, t.userId), color = Color.White, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (activity != null && android.os.Build.VERSION.SDK_INT >= 26) IconButton({ close(); (activity as? io.github.mrciller.cillhub.MainActivity)?.enterPip() }) {
                    Ic(R.drawable.ms_picture_in_picture_alt, s(R.string.voice_pip), tint = Color.White)
                }
            }
        }
    }
}

/** What picture-in-picture shows: a remote screen share or camera, else whoever speaks. */
@Composable
fun PipContent() {
    val v by Voice.state.collectAsStateWithLifecycle()
    val state by Session.store.state.collectAsStateWithLifecycle()
    val t = v.tiles.firstOrNull { it.screen && !it.local } ?: v.tiles.firstOrNull { !it.local } ?: v.tiles.firstOrNull()
    Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        if (t != null) VideoView(t, mirror = false, fit = true, modifier = Modifier.fillMaxSize())
        else (v.speaking.firstOrNull { it != state.me?.id } ?: state.me?.id)?.let { Avatar(state.users[it], 64.dp) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VolumeSheet(state: State, guildId: String?, userId: String, close: () -> Unit) {
    var vol by remember { mutableFloatStateOf(Voice.prefs.volume(userId).toFloat()) }
    var sbMuted by remember { mutableStateOf(Voice.prefs.isSoundboardMuted(userId)) }
    val nav = LocalNav.current
    ModalBottomSheet(close) {
        Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp)) {
            Text(Sel.memberName(state, guildId, userId), style = MaterialTheme.typography.titleMedium)
            Text(s(R.string.voice_user_volume) + ": ${(vol * 100).toInt()} %", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 12.dp))
            Slider(vol, { vol = it; Voice.setUserVolume(userId, it.toDouble()) }, valueRange = 0f..2f, steps = 19)
            Row(
                Modifier.fillMaxWidth().padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(s(R.string.mute_soundboard_user), style = MaterialTheme.typography.bodyMedium)
                androidx.compose.material3.Switch(sbMuted, {
                    sbMuted = it
                    Voice.prefs.setSoundboardMuted(userId, it)
                })
            }
            TextButton({ nav.openProfile(userId, guildId); close() }) { Text(s(R.string.view_profile)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RouteSheet(close: () -> Unit) {
    val r by CallAudio.state.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    ModalBottomSheet(close) {
        Column(Modifier.padding(bottom = 24.dp)) {
            Text(s(R.string.voice_audio_output), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp).semantics { heading() })
            for (d in r.devices) Row(
                Modifier.fillMaxWidth().selectable(d.id == r.current?.id, role = Role.RadioButton) { CallAudio.choose(d.id); close() }.heightIn(min = 56.dp).padding(horizontal = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Ic(routeIcon(d), null)
                Text(routeLabel(ctx, d), Modifier.weight(1f).padding(start = 16.dp))
                RadioButton(d.id == r.current?.id, null)
            }
            if (r.devices.isEmpty()) Text(s(R.string.voice_no_routes), Modifier.padding(24.dp))
        }
    }
}

/** The screen share quality before Android's own consent dialog (the web client's Go Live dialog). */
@Composable
private fun ShareDialog(onDismiss: () -> Unit, onShare: () -> Unit) {
    var q by remember { mutableStateOf(Voice.prefs.screenQuality) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(s(R.string.voice_share_screen)) },
        text = {
            Column {
                Text(s(R.string.voice_share_quality), style = MaterialTheme.typography.labelLarge)
                for (p in ScreenQuality.entries) Row(
                    Modifier.fillMaxWidth().selectable(p == q, role = Role.RadioButton) { q = p }.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(p == q, null)
                    Text("${p.height}p · ${p.fps} FPS", Modifier.padding(start = 12.dp))
                }
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                Text(s(R.string.voice_share_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = { TextButton({ Voice.prefs.screenQuality = q; onShare() }) { Text(s(R.string.voice_go_live)) } },
        dismissButton = { TextButton(onDismiss) { Text(s(R.string.cancel)) } },
    )
}

/** "Voice connected" above the bottom bar while in a call and away from its screen: tap to open, mute, leave. */
@Composable
fun VoiceBar(onOpen: (String) -> Unit) {
    val v by Voice.state.collectAsStateWithLifecycle()
    val state by Session.store.state.collectAsStateWithLifecycle()
    val id = v.channelId ?: return
    val ctx = LocalContext.current
    val name = state.channels[id]?.let { Sel.channelName(state, it) } ?: ""
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.clickable(onClickLabel = s(R.string.voice_open)) { onOpen(id) }.padding(start = 16.dp, end = 4.dp).heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
            Ic(R.drawable.ms_graphic_eq, null, tint = if (v.status == VStatus.CONNECTED) LocalExtra.current.online else MaterialTheme.colorScheme.onSecondaryContainer)
            Column(Modifier.weight(1f).padding(horizontal = 12.dp).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }) {
                Text(statusText(ctx, v), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton({ Voice.setSelfMute(!v.selfMute) }) { Ic(if (v.selfMute) R.drawable.ms_mic_off else R.drawable.ms_mic, s(if (v.selfMute) R.string.voice_unmute else R.string.voice_mute)) }
            IconButton({ Voice.leave() }) { Ic(R.drawable.ms_call_end, s(R.string.voice_leave), tint = MaterialTheme.colorScheme.error) }
        }
    }
}

/** Who is in a voice channel, under its row in the channel list. */
@Composable
fun VoiceChannelUsers(state: State, c: Channel) {
    val people = Sel.voiceUsers(state, c.guildId, c.id)
    val speaking = Voice.state.collectAsStateWithLifecycle().value.let { if (it.channelId == c.id) it.speaking else emptySet() }
    if (c.status != null) Text(c.status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(start = 50.dp, end = 16.dp, bottom = 2.dp))
    for (p in people) Row(Modifier.padding(start = 46.dp, end = 16.dp).height(32.dp), verticalAlignment = Alignment.CenterVertically) {
        val talking = p.userId in speaking
        Avatar(state.users[p.userId], 22.dp, modifier = Modifier.speakingRing(talking, LocalExtra.current.online, 2.dp))
        Text(Sel.memberName(state, c.guildId, p.userId), Modifier.weight(1f).padding(start = 8.dp), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (p.selfStream) Text(s(R.string.voice_live).uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold)
        if (p.selfVideo) Ic(R.drawable.ms_videocam, s(R.string.voice_camera_on_label), Modifier.size(16.dp).padding(start = 2.dp), MaterialTheme.colorScheme.onSurfaceVariant)
        if (p.mute || p.selfMute) Ic(R.drawable.ms_mic_off, s(if (p.mute) R.string.voice_server_muted else R.string.voice_muted), Modifier.size(16.dp), if (p.mute) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        if (p.deaf || p.selfDeaf) Ic(R.drawable.ms_headset_off, s(if (p.deaf) R.string.voice_server_deafened else R.string.voice_deafened), Modifier.size(16.dp), if (p.deaf) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
