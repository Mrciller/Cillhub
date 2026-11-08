package io.github.mrciller.cillhub.ui

import android.app.Activity
import android.app.LocaleManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.LocaleList
import android.os.PowerManager
import android.provider.Settings
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mrciller.cillhub.BuildConfig
import io.github.mrciller.cillhub.Config
import io.github.mrciller.cillhub.Delivery
import io.github.mrciller.cillhub.Prefs
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.TokenStore
import io.github.mrciller.cillhub.Updater
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Theme and colour choices, read by MainActivity's theme (local to this device). */
object AppearancePrefs {
    val theme = MutableStateFlow("system")
    val dynamic = MutableStateFlow(android.os.Build.VERSION.SDK_INT >= 31)
    fun load(p: Prefs) { theme.value = p.theme; dynamic.value = p.dynamicColor }
}

/** You tab: own profile, status and settings. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun YouScreen() {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val nav = LocalNav.current
    val me = state.me
    var statusSheet by rememberSaveable { mutableStateOf(false) }
    var logout by rememberSaveable { mutableStateOf(false) }
    Scaffold(topBar = { TopAppBar(title = { Text(s(R.string.tab_you), fontWeight = FontWeight.Bold) }) }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState())) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainer,
                shape = MaterialTheme.shapes.extraLarge,
                border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                modifier = Modifier.padding(16.dp).fillMaxWidth(),
            ) {
                Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(me, 64.dp, Sel.presence(state, me?.id ?: ""))
                    Spacer(Modifier.width(16.dp))
                    Column(Modifier.weight(1f)) {
                        Text(me?.displayName ?: "", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                        Text(me?.username ?: "", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Row(Modifier.padding(horizontal = 16.dp)) {
                OutlinedButton({ statusSheet = true }, Modifier.weight(1f)) {
                    androidx.compose.foundation.layout.Box(Modifier.padding(end = 8.dp)) { StatusDot(state.myStatus) }
                    Text(s(presenceLabel(state.myStatus)))
                }
                Spacer(Modifier.width(8.dp))
                OutlinedButton({ me?.let { nav.openProfile(it.id, null) } }, Modifier.weight(1f)) { Text(s(R.string.view_profile)) }
            }
            Spacer(Modifier.padding(8.dp))
            SettingRow(R.drawable.ms_account_circle, R.string.settings_account) { nav.openSettings("account") }
            SettingRow(R.drawable.ms_notifications, R.string.settings_notifications) { nav.openSettings("notifications") }
            SettingRow(R.drawable.ms_settings_voice, R.string.settings_voice) { nav.openSettings("voice") }
            SettingRow(R.drawable.ms_palette, R.string.settings_appearance) { nav.openSettings("appearance") }
            SettingRow(R.drawable.ms_language, R.string.settings_language) { nav.openSettings("language") }
            SettingRow(R.drawable.ms_info, R.string.settings_about) { nav.openSettings("about") }
            HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ms_logout, R.string.log_out, MaterialTheme.colorScheme.error, chevron = false) { logout = true }
        }
    }
    if (statusSheet) ModalBottomSheet({ statusSheet = false }) {
        Column(Modifier.padding(bottom = 24.dp).selectableGroup()) {
            Text(s(R.string.set_status), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp).semantics { heading() })
            for ((st, desc) in listOf("online" to null, "idle" to null, "dnd" to R.string.status_dnd_text, "invisible" to R.string.status_invisible_text)) {
                ListItem(
                    headlineContent = { Text(s(presenceLabel(st))) },
                    supportingContent = desc?.let { { Text(s(it)) } },
                    leadingContent = { StatusDot(st) },
                    trailingContent = { RadioButton(state.myStatus == st, null) },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.selectable(state.myStatus == st, role = Role.RadioButton) { Session.setStatus(st); statusSheet = false },
                )
            }
        }
    }
    if (logout) AlertDialog(
        onDismissRequest = { logout = false },
        title = { Text(s(R.string.log_out)) },
        text = { Text(s(R.string.log_out_text)) },
        confirmButton = { TextButton({ logout = false; Session.logout() }) { Text(s(R.string.log_out), color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ logout = false }) { Text(s(R.string.cancel)) } },
    )
}

@Composable
private fun StatusDot(status: String) = androidx.compose.foundation.layout.Box(
    Modifier.size(12.dp).background(presenceColor(if (status == "invisible") "offline" else status), androidx.compose.foundation.shape.CircleShape))

@Composable
private fun SettingRow(icon: Int, @StringRes label: Int, color: Color = MaterialTheme.colorScheme.onSurface, chevron: Boolean = true, onClick: () -> Unit) =
    ListItem(
        headlineContent = { Text(s(label), color = color) },
        leadingContent = { Ic(icon, null, tint = color) },
        trailingContent = if (chevron) { { Ic(R.drawable.ms_chevron_right, null, tint = MaterialTheme.colorScheme.onSurfaceVariant) } } else null,
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable(onClick = onClick),
    )

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(page: String) {
    val nav = LocalNav.current
    val title = when (page) { "account" -> R.string.settings_account; "notifications" -> R.string.settings_notifications; "voice" -> R.string.settings_voice; "appearance" -> R.string.settings_appearance; "language" -> R.string.settings_language; else -> R.string.settings_about }
    Scaffold(topBar = { TopAppBar(title = { Text(s(title)) }, navigationIcon = { IconButton(nav::back) { Ic(R.drawable.ms_arrow_back, s(R.string.back)) } }) }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState())) {
            when (page) {
                "account" -> AccountSettings()
                "notifications" -> NotificationSettings()
                "voice" -> VoiceSettings()
                "appearance" -> AppearanceSettings()
                "language" -> LanguageSettings()
                else -> AboutSettings()
            }
        }
    }
}

@Composable
private fun Section(@StringRes title: Int) = Text(s(title), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary,
    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp).semantics { heading() })

@Composable
private fun AccountSettings() {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val me = state.me
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var name by rememberSaveable(me?.globalName) { mutableStateOf(me?.globalName ?: "") }
    var msg by remember { mutableStateOf<String?>(null) }
    var password by rememberSaveable { mutableStateOf(false) }
    Section(R.string.profile_section)
    OutlinedTextField(name, { name = it.take(32) }, label = { Text(s(R.string.display_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp))
    Button({ scope.launch { msg = try { Session.patchMe(buildJsonObject { put("global_name", name.trim().ifEmpty { null }) }); ctx.getString(R.string.saved) } catch (e: Exception) { errorText(ctx, e) } } },
        Modifier.padding(16.dp), enabled = name.trim() != (me?.globalName ?: "")) { Text(s(R.string.save)) }
    msg?.let { Text(it, modifier = Modifier.padding(horizontal = 16.dp)) }
    Section(R.string.account_section)
    ListItem(headlineContent = { Text(s(R.string.username)) }, supportingContent = { Text(me?.username ?: "") }, colors = ListItemDefaults.colors(containerColor = Color.Transparent))
    ListItem(headlineContent = { Text(s(R.string.email)) }, supportingContent = { Text(me?.email ?: "–") }, colors = ListItemDefaults.colors(containerColor = Color.Transparent))
    ListItem(headlineContent = { Text(s(R.string.two_factor)) }, supportingContent = { Text(s(if (me?.mfaEnabled == true) R.string.two_factor_on else R.string.two_factor_off)) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent))
    ListItem(headlineContent = { Text(s(R.string.change_password)) }, leadingContent = { Ic(R.drawable.ms_lock, null) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent), modifier = Modifier.clickable { password = true })
    ListItem(headlineContent = { Text(s(R.string.more_on_web)) }, supportingContent = { Text(s(R.string.more_on_web_text)) }, leadingContent = { Ic(R.drawable.ms_open_in_new, null) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent), modifier = Modifier.clickable { openUrl(ctx, Config.APP_URL + "/channels/@me") })

    val prefs = remember { Prefs(ctx) }
    var dmReceipts by remember { mutableStateOf(prefs.dmReadReceipts) }
    var exporting by remember { mutableStateOf(false) }

    Section(R.string.privacy_section)
    SwitchRow(R.string.dm_read_receipts, R.string.dm_read_receipts_desc, dmReceipts) { v ->
        dmReceipts = v
        prefs.dmReadReceipts = v
        scope.launch { runCatching { Session.setDmReadReceipts(v) } }
    }
    ListItem(
        headlineContent = { Text(s(R.string.export_my_data)) },
        supportingContent = { Text(s(R.string.export_my_data_desc)) },
        leadingContent = { Ic(R.drawable.ms_download, null) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable {
            if (!exporting) {
                exporting = true
                scope.launch {
                    try {
                        val data = Session.exportMyData()
                        val sendIntent = Intent(Intent.ACTION_SEND).apply {
                            type = "application/json"
                            putExtra(Intent.EXTRA_TEXT, data)
                            putExtra(Intent.EXTRA_SUBJECT, "cillhub-data-export.json")
                        }
                        ctx.startActivity(Intent.createChooser(sendIntent, ctx.getString(R.string.export_my_data)))
                    } catch (e: Exception) {
                        msg = errorText(ctx, e)
                    } finally {
                        exporting = false
                    }
                }
            }
        },
    )
    if (password) {
        var old by rememberSaveable { mutableStateOf("") }
        var new by rememberSaveable { mutableStateOf("") }
        var err by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { password = false },
            title = { Text(s(R.string.change_password)) },
            text = {
                Column {
                    OutlinedTextField(old, { old = it }, label = { Text(s(R.string.current_password)) }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                    OutlinedTextField(new, { new = it }, label = { Text(s(R.string.password_new_hint)) }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.padding(top = 8.dp))
                    err?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
                }
            },
            confirmButton = {
                TextButton({ scope.launch { try { Session.patchMe(buildJsonObject { put("password", old); put("new_password", new) }); password = false; msg = ctx.getString(R.string.password_changed) } catch (e: Exception) { err = errorText(ctx, e) } } },
                    enabled = old.isNotEmpty() && new.length >= 8) { Text(s(R.string.save)) }
            },
            dismissButton = { TextButton({ password = false }) { Text(s(R.string.cancel)) } },
        )
    }
}

@Composable
private fun NotificationSettings() {
    val ctx = LocalContext.current
    val prefs = remember { Prefs(ctx) }
    var bg by remember { mutableStateOf(prefs.background) }
    var tick by remember { mutableIntStateOf(0) }
    val ignoring = remember(tick) { ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(ctx.packageName) }
    androidx.lifecycle.compose.LifecycleResumeEffect(Unit) { tick++; onPauseOrDispose { } }
    ListItem(
        headlineContent = { Text(s(R.string.background)) },
        supportingContent = { Text(s(R.string.background_text)) },
        trailingContent = { Switch(bg, null) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.selectable(bg, role = Role.Switch) { bg = !bg; prefs.background = bg; Delivery.apply(ctx); tick++ },
    )
    val status = when {
        TokenStore.get(ctx) == null -> R.string.status_logged_out
        bg -> R.string.status_service
        Delivery.firebaseAvailable(ctx) -> if (prefs.fcmRegistered != null) R.string.status_fcm else R.string.status_fcm_pending
        else -> R.string.status_none
    }
    Text(s(status), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
    if (bg && !ignoring) ListItem(
        headlineContent = { Text(s(R.string.battery)) }, supportingContent = { Text(s(R.string.battery_text)) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable {
            try { ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}"))) }
            catch (e: Exception) { ctx.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        },
    )
    ListItem(
        headlineContent = { Text(s(R.string.system_notification_settings)) }, leadingContent = { Ic(R.drawable.ms_open_in_new, null) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable { ctx.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)) },
    )
}

@Composable
private fun SwitchRow(@StringRes label: Int, @StringRes text: Int?, on: Boolean, onChange: (Boolean) -> Unit) = ListItem(
    headlineContent = { Text(s(label)) }, supportingContent = text?.let { { Text(s(it)) } }, trailingContent = { Switch(on, null) },
    colors = ListItemDefaults.colors(containerColor = Color.Transparent), modifier = Modifier.selectable(on, role = Role.Switch) { onChange(!on) },
)

/** Voice and video (the web client's Voice & Video settings, as far as a phone needs them). */
@Composable
private fun VoiceSettings() {
    val p = io.github.mrciller.cillhub.voice.Voice.prefs
    var tick by remember { mutableIntStateOf(0) }
    fun set(f: () -> Unit, audio: Boolean = false) { f(); tick++; if (audio) io.github.mrciller.cillhub.voice.Voice.audioSettingsChanged() }
    key(tick) {
        Section(R.string.voice_input_mode)
        Column(Modifier.selectableGroup()) {
            RadioRow(s(R.string.voice_activity), !p.pushToTalk) { set({ p.pushToTalk = false }) }
            RadioRow(s(R.string.voice_push_to_talk), p.pushToTalk) { set({ p.pushToTalk = true }) }
        }

        Section(R.string.voice_noise_suppression_engine)
        Column(Modifier.selectableGroup()) {
            val engines = listOf(
                "off" to R.string.noise_engine_off,
                "standard" to R.string.noise_engine_standard,
                "speex" to R.string.noise_engine_speex,
                "enhanced" to R.string.noise_engine_enhanced,
                "studio" to R.string.noise_engine_studio,
            )
            for ((eng, labelRes) in engines) {
                RadioRow(s(labelRes), p.noiseSuppressionMode == eng) {
                    set({ p.noiseSuppressionMode = eng }, audio = true)
                }
            }
        }

        Section(R.string.voice_noise_gate)
        SwitchRow(R.string.voice_noise_gate_enable, R.string.voice_noise_gate_desc, p.gateEnabled) { v -> set({ p.gateEnabled = v }, audio = true) }
        if (p.gateEnabled) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                Text(s(R.string.voice_gate_open, p.gateOpenDb.toInt()), style = MaterialTheme.typography.labelSmall)
                androidx.compose.material3.Slider(
                    value = p.gateOpenDb,
                    onValueChange = { set({ p.gateOpenDb = it }, audio = true) },
                    valueRange = -80f..0f,
                )
                Text(s(R.string.voice_gate_close, p.gateCloseDb.toInt()), style = MaterialTheme.typography.labelSmall)
                androidx.compose.material3.Slider(
                    value = p.gateCloseDb,
                    onValueChange = { set({ p.gateCloseDb = it }, audio = true) },
                    valueRange = -80f..0f,
                )
                Text(s(R.string.voice_gate_hold, p.gateHoldMs), style = MaterialTheme.typography.labelSmall)
                androidx.compose.material3.Slider(
                    value = p.gateHoldMs.toFloat(),
                    onValueChange = { set({ p.gateHoldMs = it.toInt() }, audio = true) },
                    valueRange = 10f..500f,
                )
            }
        }

        Section(R.string.voice_dsp_studio)
        SwitchRow(R.string.voice_high_pass, R.string.voice_high_pass_desc, p.highPassFilter) { v -> set({ p.highPassFilter = v }, audio = true) }
        SwitchRow(R.string.voice_compressor, R.string.voice_compressor_desc, p.voiceCompressor) { v -> set({ p.voiceCompressor = v }, audio = true) }

        Section(R.string.voice_processing)
        SwitchRow(R.string.voice_echo_cancellation, null, p.echoCancellation) { v -> set({ p.echoCancellation = v }, audio = true) }
        SwitchRow(R.string.voice_auto_gain, null, p.autoGainControl) { v -> set({ p.autoGainControl = v }, audio = true) }
        SwitchRow(R.string.voice_dtx, R.string.voice_dtx_text, p.dtx) { v -> set({ p.dtx = v }) }

        Section(R.string.voice_screen_codec)
        Column(Modifier.selectableGroup()) {
            for ((c, l) in listOf(io.github.mrciller.cillhub.voice.Codecs.Choice.AUTO to R.string.voice_codec_auto, io.github.mrciller.cillhub.voice.Codecs.Choice.H264 to R.string.voice_codec_h264,
                io.github.mrciller.cillhub.voice.Codecs.Choice.AV1 to R.string.voice_codec_av1, io.github.mrciller.cillhub.voice.Codecs.Choice.VP8 to R.string.voice_codec_vp8))
                RadioRow(s(l), p.screenCodec == c) { set({ p.screenCodec = c }) }
        }

        Section(R.string.voice_soundboard_volume)
        Text("${(p.soundboardVolume * 100).toInt()}%", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 16.dp))
        androidx.compose.material3.Slider(
            value = p.soundboardVolume,
            onValueChange = { v -> p.soundboardVolume = v; tick++ },
            valueRange = 0f..2f,
            modifier = Modifier.padding(horizontal = 16.dp),
        )

        Text(s(R.string.voice_settings_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
    }
}

@Composable
private fun RadioRow(label: String, selected: Boolean, onClick: () -> Unit) =
    ListItem(headlineContent = { Text(label) }, leadingContent = { RadioButton(selected, null) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.selectable(selected, role = Role.RadioButton, onClick = onClick))

@Composable
private fun AppearanceSettings() {
    val ctx = LocalContext.current
    val prefs = remember { Prefs(ctx) }
    val theme by AppearancePrefs.theme.collectAsStateWithLifecycle()
    val dynamic by AppearancePrefs.dynamic.collectAsStateWithLifecycle()
    Section(R.string.theme)
    Column(Modifier.selectableGroup()) {
        for ((v, l) in listOf("system" to R.string.theme_system, "dark" to R.string.theme_dark, "light" to R.string.theme_light))
            RadioRow(s(l), theme == v) { prefs.theme = v; AppearancePrefs.theme.value = v }
    }
    if (Build.VERSION.SDK_INT >= 31) ListItem(
        headlineContent = { Text(s(R.string.dynamic_color)) }, supportingContent = { Text(s(R.string.dynamic_color_text)) },
        trailingContent = { Switch(dynamic, null) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.selectable(dynamic, role = Role.Switch) { prefs.dynamicColor = !dynamic; AppearancePrefs.dynamic.value = !dynamic },
    )
    Text(s(R.string.motion_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
}

/** Per-app language: Android 13+ keeps it in LocaleManager (also shown in system settings); older versions use our own setting. */
@Composable
private fun LanguageSettings() {
    val ctx = LocalContext.current
    val current = remember {
        if (Build.VERSION.SDK_INT >= 33) ctx.getSystemService(LocaleManager::class.java).applicationLocales.takeIf { !it.isEmpty }?.get(0)?.language ?: ""
        else Prefs(ctx).language
    }
    Column(Modifier.selectableGroup()) {
        for ((tag, l) in listOf("" to R.string.language_system, "en" to R.string.language_en, "de" to R.string.language_de)) RadioRow(s(l), current == tag) {
            if (Build.VERSION.SDK_INT >= 33) ctx.getSystemService(LocaleManager::class.java).applicationLocales = if (tag.isEmpty()) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(tag)
            else { Prefs(ctx).language = tag; (ctx as? Activity)?.recreate() }
        }
    }
}

@Composable
private fun AboutSettings() {
    val ctx = LocalContext.current
    ListItem(headlineContent = { Text(s(R.string.version_label)) }, supportingContent = { Text("${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})") }, colors = ListItemDefaults.colors(containerColor = Color.Transparent))
    ListItem(headlineContent = { Text(s(R.string.server_address)) }, supportingContent = { Text(Config.APP_URL) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent))
    ListItem(headlineContent = { Text(s(R.string.check_update)) }, leadingContent = { Ic(R.drawable.ms_refresh, null) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable { (ctx as? Activity)?.let { Updater.checkFromActivity(it, interactive = true) } })
    Section(R.string.licenses)
    Text(s(R.string.licenses_text), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
    ListItem(headlineContent = { Text(s(R.string.source_code)) }, leadingContent = { Ic(R.drawable.ms_open_in_new, null) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable { openUrl(ctx, "https://github.com/Mrciller/cillhub") })
}
