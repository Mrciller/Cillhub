package io.github.mrciller.cillhub.ui

import android.content.ClipData
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.E2ee
import io.github.mrciller.cillhub.data.E2eeCrypto
import io.github.mrciller.cillhub.data.Message
import io.github.mrciller.cillhub.data.Seal
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.State
import kotlinx.coroutines.launch

// Encrypted DMs, the UI (client/src/e2ee/E2ee.tsx): settings page, recovery key dialogs, the DM status lines, the lock
// button with security codes, and the report dialog that reveals an encrypted message.

/** Re-reads E2ee's status whenever keys or pins change. */
@Composable
private fun e2eeStatus(): E2ee.Status {
    val v by E2ee.version.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { runCatching { E2ee.ready() } }
    return v.let { E2ee.status }
}

/** Shows a new recovery key once; Done needs the "saved it" tick. */
@Composable
private fun RecoveryKeyDialog(text: String, close: () -> Unit) {
    var saved by rememberSaveable { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    AlertDialog(
        onDismissRequest = { if (saved) close() },
        title = { Text(s(R.string.e2ee_recovery_title).uppercase()) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(s(R.string.e2ee_recovery_text))
                Surface(color = MaterialTheme.colorScheme.surfaceContainerHighest, shape = Hud) {
                    // two rows of four groups, so a group never breaks across lines
                    SelectionContainer { Text(text.split("-").chunked(4).joinToString("\n") { it.joinToString("-") }, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, modifier = Modifier.padding(12.dp).fillMaxWidth()) }
                }
                OutlinedButton({ scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("recovery key", text))); Toast.makeText(ctx, R.string.copied, Toast.LENGTH_SHORT).show() } },
                    shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_copy).uppercase()) }
                Row(Modifier.fillMaxWidth().selectable(saved, role = Role.Checkbox) { saved = !saved }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(saved, null)
                    Text(s(R.string.e2ee_saved_it), Modifier.padding(start = 8.dp))
                }
            }
        },
        confirmButton = { TextButton(close, enabled = saved, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_done).uppercase()) } },
    )
}

/** Asks for the recovery key and unlocks this device. */
@Composable
fun RecoveryPrompt(close: () -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(R.string.e2ee_enter_title).uppercase()) },
        text = {
            Column {
                Text(s(R.string.e2ee_enter_body))
                OutlinedTextField(text, { text = it.take(64); err = null }, label = { Text(s(R.string.e2ee_recovery_label)) }, placeholder = { Text("ABCD-EFGH-…") },
                    singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                err?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
            }
        },
        confirmButton = {
            TextButton({
                busy = true
                scope.launch {
                    try { E2ee.recover(text); Toast.makeText(ctx, R.string.e2ee_unlocked, Toast.LENGTH_SHORT).show(); close() } catch (e: Exception) { err = errorText(ctx, e) }
                    busy = false
                }
            }, enabled = text.isNotBlank() && !busy, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_unlock).uppercase()) }
        },
        dismissButton = { TextButton(close, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
    )
}

/** Settings → Encrypted messages. */
@Composable
fun EncryptionSettings() {
    val status = e2eeStatus()
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var shown by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var confirmReset by remember { mutableStateOf(false) }
    var prompt by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun start() {
        busy = true; error = null
        scope.launch { try { shown = E2ee.enable() } catch (e: Exception) { error = errorText(ctx, e) }; busy = false }
    }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(s(R.string.e2ee_intro))
        Text(s(R.string.e2ee_limits), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        when (status) {
            E2ee.Status.UNKNOWN -> Loading()
            E2ee.Status.OFF -> Button(::start, enabled = !busy, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_turn_on).uppercase()) }
            E2ee.Status.READY -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Ic(R.drawable.ms_lock, null, Modifier.size(18.dp), MaterialTheme.colorScheme.primary)
                    Text(s(R.string.e2ee_on_device), Modifier.padding(start = 8.dp), fontWeight = FontWeight.SemiBold)
                }
                OutlinedButton({ confirmReset = true }, enabled = !busy, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_reset).uppercase(), color = MaterialTheme.colorScheme.error) }
            }
            E2ee.Status.LOCKED -> {
                Text(s(R.string.e2ee_locked_text))
                Button({ prompt = true }, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_enter_key).uppercase()) }
                TextButton({ confirmReset = true }, enabled = !busy, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_lost_key), color = MaterialTheme.colorScheme.error) }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
    if (confirmReset) AlertDialog(
        onDismissRequest = { confirmReset = false },
        title = { Text(s(R.string.e2ee_reset_title).uppercase()) },
        text = { Text(s(R.string.e2ee_reset_text)) },
        confirmButton = { TextButton({ confirmReset = false; start() }, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_reset).uppercase(), color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmReset = false }, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
    )
    if (prompt) RecoveryPrompt { prompt = false }
    shown?.let { RecoveryKeyDialog(it) { shown = null } }
}

/** The lines under a DM header: why it is not encrypted, a missing recovery key, an unverified key, changed security keys. */
@Composable
fun E2eeBar(state: State, ch: Channel) {
    val status = e2eeStatus()
    if (!E2ee.isDm(ch)) return
    val me = state.me?.id
    val others = ch.recipients.filter { it.id != me }
    LaunchedEffect(ch.id, ch.e2eeEpoch, others.map { it.id }, status) {
        runCatching { E2ee.openChannel(ch) }.onFailure { android.util.Log.w("CillhubE2ee", "open: ${it.javaClass.simpleName} ${it.message}") }
    }
    var prompt by remember { mutableStateOf(false) }
    var verify by remember { mutableStateOf<String?>(null) }
    val enc = E2ee.isEncrypted(ch)
    val bot = others.any { it.bot || it.system }
    val missing = others.filter { E2ee.publicKey(it.id) == "" }
    val line = when {
        bot -> s(R.string.e2ee_bar_bot)
        E2ee.unverified(ch) -> s(R.string.e2ee_unverified)
        enc && status == E2ee.Status.LOCKED -> s(R.string.e2ee_bar_locked)
        !enc && status == E2ee.Status.OFF -> s(R.string.e2ee_bar_off)
        !enc && missing.isNotEmpty() -> s(R.string.e2ee_bar_missing, missing.joinToString { it.displayName })
        else -> null
    }
    if (line != null) Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Ic(if (enc) R.drawable.ms_lock else R.drawable.ms_lock_open, null, Modifier.size(16.dp), MaterialTheme.colorScheme.onSurfaceVariant)
            Text(line, Modifier.weight(1f).padding(start = 8.dp), style = MaterialTheme.typography.bodySmall)
            if (enc && status == E2ee.Status.LOCKED) TextButton({ prompt = true }, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_enter_key).uppercase()) }
        }
    }
    if (!bot) for (u in others.filter { E2ee.keyChanged(it.id) }) Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp)) {
            Text(s(R.string.e2ee_key_changed, u.displayName), color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
            Row(Modifier.align(Alignment.End)) {
                TextButton({ verify = u.id }, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_verify).uppercase()) }
                TextButton({ E2ee.acceptKey(u.id) }, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_dismiss).uppercase()) }
            }
        }
    }
    if (prompt) RecoveryPrompt { prompt = false }
    verify?.let { SecurityCodeDialog(ch, it) { verify = null } }
}

/** Header button of a DM: closed lock when encrypted; opens the details with the security codes. */
@Composable
fun E2eeLock(state: State, ch: Channel) {
    e2eeStatus()
    if (!E2ee.isDm(ch)) return
    var open by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf<String?>(null) }
    val enc = E2ee.isEncrypted(ch)
    val label = s(if (enc) R.string.e2ee_on else R.string.e2ee_off)
    IconButton({ open = true }) { Ic(if (enc) R.drawable.ms_lock else R.drawable.ms_lock_open, label, tint = if (enc) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) }
    if (open) AlertDialog(
        onDismissRequest = { open = false },
        title = { Text(label.uppercase()) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(s(if (enc) R.string.e2ee_info_on else R.string.e2ee_info_off))
                val others = ch.recipients.filter { it.id != state.me?.id && !it.bot }
                if (enc && others.isNotEmpty()) {
                    Text(s(R.string.e2ee_compare_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    for (u in others) TextButton({ code = u.id }, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_verify_with, u.displayName)) }
                }
            }
        },
        confirmButton = { TextButton({ open = false }, shape = MaterialTheme.shapes.small) { Text(s(R.string.close).uppercase()) } },
    )
    code?.let { SecurityCodeDialog(ch, it) { code = null } }
}

@Composable
private fun SecurityCodeDialog(ch: Channel, userId: String, close: () -> Unit) {
    val name = E2ee.nameOf(ch, userId)
    val mine = E2ee.myPub
    val theirs = E2ee.publicKey(userId)
    val code = remember(mine, theirs) { if (mine.isNotEmpty() && !theirs.isNullOrEmpty()) runCatching { E2eeCrypto.securityCode(mine, theirs) }.getOrNull() else null }
    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(R.string.e2ee_code_title, name).uppercase()) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(s(R.string.e2ee_code_text, name))
                if (code != null) Surface(color = MaterialTheme.colorScheme.surfaceContainerHighest, shape = Hud) {
                    // 12 groups of 5 digits, 3 per line, like a phone number to read out
                    Text(code.split(" ").chunked(3).joinToString("\n") { it.joinToString("  ") }, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(12.dp).fillMaxWidth())
                } else Text(s(R.string.e2ee_no_code), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = { TextButton(close, shape = MaterialTheme.shapes.small) { Text(s(R.string.close).uppercase()) } },
        dismissButton = if (code != null && E2ee.keyChanged(userId)) { { TextButton({ E2ee.acceptKey(userId); close() }, shape = MaterialTheme.shapes.small) { Text(s(R.string.e2ee_codes_match).uppercase()) } } } else null,
    )
}

/** What an encrypted message shows instead of its text while it is not open. */
@Composable
fun SealLine(seal: Seal) = Text(
    s(when (seal) { Seal.PENDING -> R.string.e2ee_decrypting; Seal.LOCKED -> R.string.e2ee_locked_message; else -> R.string.e2ee_cannot_decrypt }),
    fontStyle = FontStyle.Italic, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium,
)

private val REASONS = listOf(
    "spam" to R.string.report_spam, "harassment" to R.string.report_harassment, "hate" to R.string.report_hate, "nsfw" to R.string.report_nsfw,
    "violence" to R.string.report_violence, "self_harm" to R.string.report_self_harm, "illegal" to R.string.report_illegal,
    "impersonation" to R.string.report_impersonation, "other" to R.string.report_other,
)

/** Report a message to the instance admins; an encrypted one sends its message key (and, if chosen, up to 10 before it). */
@Composable
fun ReportDialog(m: Message, close: () -> Unit) {
    var reason by rememberSaveable { mutableStateOf<String?>(null) }
    var note by rememberSaveable { mutableStateOf("") }
    var context by rememberSaveable { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val encrypted = m.e2eeEnvelope != null
    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(R.string.report_title).uppercase()) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(s(R.string.report_hint), style = MaterialTheme.typography.bodySmall)
                if (encrypted) {
                    Text(s(R.string.report_encrypted_hint), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
                    Row(Modifier.fillMaxWidth().selectable(context, role = Role.Checkbox) { context = !context }, verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(context, null)
                        Text(s(R.string.report_context), Modifier.padding(start = 8.dp))
                    }
                }
                Text(s(R.string.report_why), fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
                for ((k, l) in REASONS) Row(Modifier.fillMaxWidth().selectable(reason == k, role = Role.RadioButton) { reason = k }, verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(reason == k, null)
                    Text(s(l), Modifier.padding(start = 8.dp, top = 6.dp, bottom = 6.dp))
                }
                OutlinedTextField(note, { note = it.take(1000) }, label = { Text(s(R.string.report_note)) }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                err?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
            }
        },
        confirmButton = {
            TextButton({
                busy = true
                scope.launch {
                    try {
                        val before = if (encrypted && context) Session.store.value.messages[m.channelId].orEmpty()
                            .filter { it.e2eeEnvelope != null && !it.pending && it.id.toBigInteger() < m.id.toBigInteger() }.takeLast(10) else emptyList()
                        Session.report(m, reason!!, note, before)
                        Toast.makeText(ctx, R.string.report_done, Toast.LENGTH_LONG).show()
                        close()
                    } catch (e: Exception) { err = errorText(ctx, e) }
                    busy = false
                }
            }, enabled = reason != null && !busy, shape = MaterialTheme.shapes.small) { Text(s(R.string.report).uppercase(), color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(close, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
    )
}
