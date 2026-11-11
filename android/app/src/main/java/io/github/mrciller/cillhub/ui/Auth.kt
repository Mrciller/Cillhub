package io.github.mrciller.cillhub.ui

import android.app.Activity
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mrciller.cillhub.BuildConfig
import io.github.mrciller.cillhub.CaptchaActivity
import io.github.mrciller.cillhub.Config
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.ApiError
import io.github.mrciller.cillhub.data.LegalInfo
import io.github.mrciller.cillhub.data.LoginAnswer
import io.github.mrciller.cillhub.data.Session
import kotlinx.coroutines.launch

/** Sign in, create an account, two-factor code, required password change, and "Use another server". */
@Composable
fun AuthFlow() {
    // "login" | "register" | "forgot" | "mfa" | "renew"
    var step by rememberSaveable { mutableStateOf("login") }
    var ticket by rememberSaveable { mutableStateOf("") }
    var renewToken by rememberSaveable { mutableStateOf("") }
    var renewOld by rememberSaveable { mutableStateOf("") }
    var pickServer by rememberSaveable { mutableStateOf(false) }
    val info by Session.instance.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { Session.loadInstance() }

    fun finish(a: LoginAnswer, password: String) {
        when {
            a.mfa && a.ticket != null -> { ticket = a.ticket; step = "mfa" }
            a.token != null && "update_password" in a.requiredActions -> { renewToken = a.token; renewOld = password; step = "renew" }
            a.token != null -> Session.signedIn(a.token)
        }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 440.dp).fillMaxWidth()) {
                Spacer(Modifier.height(32.dp))
                // the wordmark: condensed caps with the accent edge, like a team banner
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.width(6.dp).height(40.dp).background(MaterialTheme.colorScheme.primary))
                    Spacer(Modifier.width(12.dp))
                    Text("CILLHUB", style = MaterialTheme.typography.displaySmall.copy(letterSpacing = 3.sp), color = MaterialTheme.colorScheme.onSurface)
                }
                Spacer(Modifier.height(8.dp))
                ServerChip(info?.name) { pickServer = true }
                info?.motd?.takeIf { it.isNotBlank() }?.let {
                    Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.padding(top = 16.dp).fillMaxWidth()) {
                        Text(it, Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
                    }
                }
                Spacer(Modifier.height(24.dp))
                when (step) {
                    "register" -> RegisterForm(info?.registrationMode ?: "open", info?.legal, { step = "login" }) { a, pw -> finish(a, pw) }
                    "forgot" -> ForgotForm { step = "login" }
                    "mfa" -> MfaForm(ticket, { step = "login" }) { a -> finish(a, "") }
                    "renew" -> RenewForm(renewToken, renewOld) { Session.signedIn(it) }
                    else -> LoginForm({ step = "register" }, if (info?.passwordReset == true) ({ step = "forgot" }) else null) { a, pw -> finish(a, pw) }
                }
                if (info?.legal != null) LegalLinks()
            }
        }
    }
    if (pickServer) ServerDialog { pickServer = false }
}

@Composable
private fun ServerChip(name: String?, onClick: () -> Unit) {
    val host = Config.APP_URL.substringAfter("://")
    Column {
        Text(s(R.string.server_label, name?.takeIf { it.isNotBlank() }?.let { "$it · $host" } ?: host), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp, vertical = 8.dp), shape = MaterialTheme.shapes.small) { Text(s(R.string.use_another_server).uppercase()) }
    }
}

@Composable
private fun Field(value: String, onChange: (String) -> Unit, label: String, type: ContentType? = null, keyboard: KeyboardType = KeyboardType.Text, password: Boolean = false, ime: ImeAction = ImeAction.Next, onDone: () -> Unit = {}, error: Boolean = false) {
    var shown by rememberSaveable { mutableStateOf(false) }
    OutlinedTextField(
        value, onChange, label = { Text(label) }, singleLine = true, isError = error,
        modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp).semantics { if (type != null) contentType = type },
        keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboard, imeAction = ime, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onDone = { onDone() }, onGo = { onDone() }),
        visualTransformation = if (password && !shown) PasswordVisualTransformation() else VisualTransformation.None,
        trailingIcon = if (password) { { IconButton({ shown = !shown }) { Ic(if (shown) R.drawable.ms_visibility_off else R.drawable.ms_visibility, s(if (shown) R.string.hide_password else R.string.show_password)) } } } else null,
    )
}

@Composable
private fun ErrorLine(text: String?) {
    if (text != null) Text(text, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.padding(bottom = 12.dp).semantics { liveRegion = LiveRegionMode.Polite })
}

@Composable
private fun Submit(label: String, busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Button(onClick, enabled = enabled && !busy, modifier = Modifier.fillMaxWidth().height(52.dp), shape = MaterialTheme.shapes.small) {
        if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp) else Text(label.uppercase())
    }
}

/** Opens the server's captcha page; `retry` gets the token (nothing happens when the user backs out). */
@Composable
private fun rememberCaptcha(): ((String) -> Unit) -> Unit {
    val ctx = LocalContext.current
    val pending = remember { arrayOfNulls<(String) -> Unit>(1) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val token = r.data?.getStringExtra(CaptchaActivity.EXTRA_TOKEN)
        if (r.resultCode == Activity.RESULT_OK && token != null) pending[0]?.invoke(token)
        pending[0] = null
    }
    return { retry -> pending[0] = retry; launcher.launch(Intent(ctx, CaptchaActivity::class.java)) }
}

@Composable
private fun LoginForm(toRegister: () -> Unit, toForgot: (() -> Unit)?, done: (LoginAnswer, String) -> Unit) {
    var login by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val submit = {
        if (login.isNotBlank() && password.isNotEmpty() && !busy) scope.launch {
            busy = true; error = null
            try { done(Session.login(login.trim(), password), password) } catch (e: ApiError) {
                error = if (e.status == 401) ctx.getString(R.string.login_failed) else errorText(ctx, e)
            }
            busy = false
        }
    }
    Text(s(R.string.login_title), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
    Text(s(R.string.login_subtitle), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 20.dp))
    Field(login, { login = it }, s(R.string.email_or_username), ContentType.Username + ContentType.EmailAddress, KeyboardType.Email)
    Field(password, { password = it }, s(R.string.password), ContentType.Password, password = true, ime = ImeAction.Go, onDone = { submit() })
    ErrorLine(error)
    Submit(s(R.string.log_in), busy, login.isNotBlank() && password.isNotEmpty()) { submit() }
    TextButton(toRegister, Modifier.padding(top = 8.dp), shape = MaterialTheme.shapes.small) { Text(s(R.string.create_account).uppercase()) }
    if (toForgot != null) TextButton(toForgot, shape = MaterialTheme.shapes.small) { Text(s(R.string.forgot_password).uppercase()) }
}

/** Password reset by email: the link in the mail opens the web page; the answer never says whether the address exists. */
@Composable
private fun ForgotForm(back: () -> Unit) {
    var email by rememberSaveable { mutableStateOf("") }
    var busy by rememberSaveable { mutableStateOf(false) }
    var sent by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val captcha = rememberCaptcha()
    fun attempt(token: String?) {
        scope.launch {
            busy = true; error = null
            try { Session.forgot(email.trim(), token); sent = true } catch (e: ApiError) {
                if (e.captcha && token == null) captcha { attempt(it) } else error = errorText(ctx, e)
            }
            busy = false
        }
    }
    Text(s(R.string.forgot_password), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
    if (sent) {
        Text(s(R.string.forgot_sent), modifier = Modifier.padding(vertical = 16.dp).semantics { liveRegion = LiveRegionMode.Polite })
    } else {
        Text(s(R.string.forgot_text), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 20.dp))
        Field(email, { email = it }, s(R.string.email), ContentType.EmailAddress, KeyboardType.Email, ime = ImeAction.Go, onDone = { if (email.contains('@') && !busy) attempt(null) })
        ErrorLine(error)
        Submit(s(R.string.forgot_send), busy, email.contains('@')) { attempt(null) }
    }
    TextButton(back, Modifier.padding(top = 8.dp), shape = MaterialTheme.shapes.small) { Text(s(R.string.back).uppercase()) }
}

/** The server's own legal pages (7.10.3), opened in the browser. */
@Composable
private fun LegalLinks() {
    val ctx = LocalContext.current
    Column(Modifier.padding(top = 24.dp)) {
        for ((label, path) in listOf(R.string.legal_imprint to "imprint", R.string.legal_privacy to "privacy", R.string.legal_terms to "terms", R.string.legal_report to "report-content")) {
            TextButton({ openUrl(ctx, "${Config.APP_URL}/$path") }, shape = MaterialTheme.shapes.small) { Text(s(label).uppercase()) }
        }
    }
}

/** A sign-up checkbox; the whole row toggles it. */
@Composable
private fun Check(checked: Boolean, onChange: (Boolean) -> Unit, label: String) {
    Row(Modifier.fillMaxWidth().toggleable(checked, role = Role.Checkbox, onValueChange = onChange).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked, null)
        Spacer(Modifier.width(8.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun RegisterForm(mode: String, legal: LegalInfo?, toLogin: () -> Unit, done: (LoginAnswer, String) -> Unit) {
    var email by rememberSaveable { mutableStateOf("") }
    var username by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var termsOk by rememberSaveable { mutableStateOf(false) }
    var ageOk by rememberSaveable { mutableStateOf(false) }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    Text(s(R.string.register_title), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
    if (mode == "closed") {
        Text(s(R.string.registration_closed), modifier = Modifier.padding(vertical = 16.dp))
        TextButton(toLogin, shape = MaterialTheme.shapes.small) { Text(s(R.string.have_account).uppercase()) }
        return
    }
    Spacer(Modifier.height(16.dp))
    // 7.10.3 servers: the age always, the terms once the operator published terms or a privacy notice
    val askTerms = legal?.acceptVersion != null
    val checked = legal != null && ageOk && (termsOk || !askTerms)
    val ok = email.contains('@') && username.trim().length in 2..32 && password.length >= 8 && (mode != "invite" || code.isNotBlank()) && (legal == null || checked)
    val captcha = rememberCaptcha()
    fun attempt(token: String?) {
        scope.launch {
            busy = true; error = null
            try { done(Session.register(email.trim(), username.trim(), password, code, token, checked), password) } catch (e: ApiError) {
                if (e.captcha && token == null) captcha { attempt(it) } else error = errorText(ctx, e)
            }
            busy = false
        }
    }
    val submit = { if (ok && !busy) attempt(null) }
    Field(email, { email = it }, s(R.string.email), ContentType.EmailAddress, KeyboardType.Email)
    Field(username, { username = it }, s(R.string.username), ContentType.NewUsername)
    Field(password, { password = it }, s(R.string.password_new_hint), ContentType.NewPassword, password = true, ime = if (mode == "invite") ImeAction.Next else ImeAction.Go, onDone = { submit() })
    if (mode == "invite") Field(code, { code = it }, s(R.string.registration_code), ime = ImeAction.Go, onDone = { submit() })
    if (legal != null) {
        if (askTerms) {
            Check(termsOk, { termsOk = it }, s(R.string.signup_terms))
            Row {
                TextButton({ openUrl(ctx, "${Config.APP_URL}/terms") }, shape = MaterialTheme.shapes.small) { Text(s(R.string.legal_terms).uppercase()) }
                TextButton({ openUrl(ctx, "${Config.APP_URL}/privacy") }, shape = MaterialTheme.shapes.small) { Text(s(R.string.legal_privacy).uppercase()) }
            }
        }
        Check(ageOk, { ageOk = it }, s(R.string.signup_age, legal.minAge))
        Spacer(Modifier.height(12.dp))
    }
    ErrorLine(error)
    Submit(s(R.string.register), busy, ok) { submit() }
    TextButton(toLogin, Modifier.padding(top = 8.dp), shape = MaterialTheme.shapes.small) { Text(s(R.string.have_account).uppercase()) }
}

@Composable
private fun MfaForm(ticket: String, cancel: () -> Unit, done: (LoginAnswer) -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    var backup by rememberSaveable { mutableStateOf(false) }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val ok = if (backup) code.trim().length >= 8 else code.trim().length == 6
    val submit = {
        if (ok && !busy) scope.launch {
            busy = true; error = null
            try { done(Session.mfa(ticket, code.trim().replace(" ", ""), backup)) } catch (e: ApiError) { error = errorText(ctx, e) }
            busy = false
        }
    }
    Text(s(R.string.mfa_title), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
    Text(s(if (backup) R.string.mfa_backup_text else R.string.mfa_text), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 20.dp))
    Field(code, { code = it }, s(if (backup) R.string.backup_code else R.string.mfa_code), ContentType.SmsOtpCode, if (backup) KeyboardType.Text else KeyboardType.NumberPassword, ime = ImeAction.Go, onDone = { submit() })
    ErrorLine(error)
    Submit(s(R.string.verify), busy, ok) { submit() }
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        TextButton({ backup = !backup; code = "" }, shape = MaterialTheme.shapes.small) { Text(s(if (backup) R.string.use_mfa_code else R.string.use_backup_code).uppercase()) }
        TextButton(cancel, shape = MaterialTheme.shapes.small) { Text(s(R.string.back).uppercase()) }
    }
}

@Composable
private fun RenewForm(token: String, old: String, done: (String) -> Unit) {
    var pw by rememberSaveable { mutableStateOf("") }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    Text(s(R.string.renew_title), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
    Text(s(R.string.renew_text), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 20.dp))
    Field(pw, { pw = it }, s(R.string.password_new_hint), ContentType.NewPassword, password = true, ime = ImeAction.Done)
    ErrorLine(error)
    Submit(s(R.string.save), busy, pw.length >= 8) {
        scope.launch {
            busy = true; error = null
            try { done(Session.forcedPassword(token, old, pw)) } catch (e: ApiError) { error = errorText(ctx, e) }
            busy = false
        }
    }
}

/** "Use another server": any https address of a Cillhub node (http only in debug builds, for local test servers). */
@Composable
private fun ServerDialog(close: () -> Unit) {
    var url by rememberSaveable { mutableStateOf(if (Config.isDefault()) "" else Config.APP_URL) }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(R.string.use_another_server).uppercase()) },
        text = {
            Column {
                Text(s(R.string.server_dialog_text), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 12.dp))
                OutlinedTextField(url, { url = it; error = null }, label = { Text(s(R.string.server_address)) }, placeholder = { Text("chat.example.org") }, singleLine = true, isError = error != null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done, autoCorrectEnabled = false), modifier = Modifier.fillMaxWidth())
                ErrorLine(error)
                AssistChip({ Session.useServer(Config.DEFAULT_URL, null); scope.launch { Session.loadInstance() }; close() }, label = { Text(s(R.string.use_default_server)) }, modifier = Modifier.padding(top = 8.dp))
            }
        },
        confirmButton = {
            TextButton(enabled = url.isNotBlank() && !busy, onClick = {
                scope.launch {
                    busy = true
                    try {
                        val (origin, info) = Session.checkServer(url, allowHttp = BuildConfig.DEBUG)
                        Session.useServer(origin, info)
                        close()
                    } catch (e: ApiError) {
                        error = ctx.getString(when (e.message) { "https" -> R.string.server_needs_https; "invalid" -> R.string.server_invalid; else -> R.string.server_not_cillhub })
                    }
                    busy = false
                }
            }, shape = MaterialTheme.shapes.small) { Text(s(R.string.connect).uppercase()) }
        },
        dismissButton = { TextButton(close, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
    )
}
