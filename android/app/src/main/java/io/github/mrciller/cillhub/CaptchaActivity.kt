package io.github.mrciller.cillhub

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * The server's reCAPTCHA checkbox (sign-up and password reset, 7.10): the native app has no web origin for Google's
 * widget, so the server's own /captcha.html shows it and posts the token back through the CillhubCaptcha bridge (main
 * frame of the server's origin only). Result: RESULT_OK with EXTRA_TOKEN. No login token is handed to this page.
 */
class CaptchaActivity : ComponentActivity() {
    companion object { const val EXTRA_TOKEN = "token" }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return finish()
        val web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
        }
        web.setBackgroundColor(0xFF070A14.toInt())
        WebViewCompat.addWebMessageListener(web, "CillhubCaptcha", setOf(Config.ORIGIN)) { _, message, sourceOrigin, isMainFrame, _ ->
            val token = message.data
            if (!Origins.bridgeAccepts(sourceOrigin.toString(), isMainFrame, Config.ORIGIN) || token.isNullOrEmpty() || token.length > 4000) return@addWebMessageListener
            setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_TOKEN, token))
            finish()
        }
        // the page stays on the server; Google's links (privacy, terms) open in the browser
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (Origins.same(request.url.toString(), Config.ORIGIN)) return false
                if (request.url.scheme == "https") runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url).addCategory(Intent.CATEGORY_BROWSABLE)) }
                return true
            }
        }
        web.loadUrl("${Config.APP_URL}/captcha.html")
    }
}
