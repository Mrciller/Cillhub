package io.github.mrciller.cillhub

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import io.github.mrciller.cillhub.data.Session
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Phase 1 fallback for voice: calls and voice channels run in the hosted web client in a WebView until native voice
 * lands (android/NATIVE-PLAN.md, Phase 2). Only the server's own origin loads; the native login token is handed to
 * the page before its scripts run; the JS bridge (window.CillcordAndroid) reports the voice connection so calls go
 * through Telecom (Calls, CallService) and takes join/leave commands from notifications.
 */
class WebCallActivity : ComponentActivity() {
    companion object {
        const val EXTRA_PATH = "path"
        private val PATH = Regex("^/channels/(@me|\\d{1,19})/\\d{1,19}$")
        private val PERMISSIONS = mapOf(
            PermissionRequest.RESOURCE_AUDIO_CAPTURE to Manifest.permission.RECORD_AUDIO,
            PermissionRequest.RESOURCE_VIDEO_CAPTURE to Manifest.permission.CAMERA,
        )

        fun intent(ctx: Context, path: String): Intent = Intent(ctx, WebCallActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra(EXTRA_PATH, path)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

        /** Open a DM call (join = start or answer it) or a voice channel. */
        fun open(ctx: Context, guildId: String?, channelId: String, join: Boolean) {
            if (join && guildId == null) WebLink.send(JSONObject().put("type", "join-call").put("channel_id", channelId), queue = true)
            ctx.startActivity(intent(ctx, "/channels/${guildId ?: "@me"}/$channelId"))
        }
    }

    private lateinit var web: WebView
    private lateinit var offline: View
    private var failed = false
    private var pendingPermission: PermissionRequest? = null
    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
        pendingPermission?.let { grantKnown(it) }
        pendingPermission = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_web_call)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        web = findViewById(R.id.web)
        offline = findViewById(R.id.offline)
        findViewById<View>(R.id.retry).setOnClickListener { failed = false; offline.visibility = View.GONE; web.reload() }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString CillhubAndroid/${BuildConfig.VERSION_NAME}"
        }
        web.setBackgroundColor(0xFF070A14.toInt())
        // the page signs in with the app's token (same origin only, before any page script runs)
        val token = TokenStore.get(this)
        if (token != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, "try{localStorage.setItem('token',${JSONObject.quote(token)})}catch(e){}", setOf(Config.ORIGIN))
        }
        lifecycleScope.launch { Session.loggedIn.first { !it }; finish() } // logged out in the app: close the page that holds the token
        installBridge()
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            // back returns to the native app; the call keeps running in this task
            override fun handleOnBackPressed() { moveTaskToBack(true) }
        })
        web.loadUrl(Config.APP_URL + (intent.getStringExtra(EXTRA_PATH)?.takeIf { PATH.matches(it) } ?: "/channels/@me"))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(EXTRA_PATH)?.takeIf { PATH.matches(it) }?.let { WebLink.send(JSONObject().put("type", "open").put("path", it), queue = true) }
    }

    private fun installBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(web, "CillcordAndroid", setOf(Config.ORIGIN)) { _, message, sourceOrigin, isMainFrame, reply ->
            if (!Origins.bridgeAccepts(sourceOrigin.toString(), isMainFrame, Config.ORIGIN)) return@addWebMessageListener
            onBridge(BridgeMessage.parse(message.data) ?: return@addWebMessageListener, reply)
        }
    }

    // the native app owns the login: token/logout messages from the page are ignored here
    private fun onBridge(m: BridgeMessage, reply: JavaScriptReplyProxy) {
        when (m) {
            BridgeMessage.Ready -> WebLink.attach { reply.postMessage(it) }
            is BridgeMessage.Voice -> Calls.webVoice(this, m.guildId, m.channelId)
            else -> {}
        }
    }

    private fun grantKnown(req: PermissionRequest) {
        val ok = req.resources.filter { r -> PERMISSIONS[r]?.let { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED } == true }
        if (ok.isEmpty()) req.deny() else req.grant(ok.toTypedArray())
    }

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            if (!Origins.same(request.origin.toString(), Config.ORIGIN)) return request.deny()
            val missing = request.resources.mapNotNull { PERMISSIONS[it] }
                .filter { ContextCompat.checkSelfPermission(this@WebCallActivity, it) != PackageManager.PERMISSION_GRANTED }
            if (missing.isEmpty()) return grantKnown(request)
            pendingPermission?.deny()
            pendingPermission = request
            askPermissions.launch(missing.toTypedArray())
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingPermission == request) pendingPermission = null
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (Origins.same(request.url.toString(), Config.ORIGIN)) return false
            if (request.url.scheme in setOf("http", "https")) try { startActivity(Intent(Intent.ACTION_VIEW, request.url).addCategory(Intent.CATEGORY_BROWSABLE)) } catch (e: Exception) { }
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) { failed = true; offline.visibility = View.VISIBLE }
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (!failed) offline.visibility = View.GONE
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            WebLink.detach()
            recreate()
            return true
        }
    }

    override fun onDestroy() {
        WebLink.detach()
        web.destroy()
        super.onDestroy()
    }
}
