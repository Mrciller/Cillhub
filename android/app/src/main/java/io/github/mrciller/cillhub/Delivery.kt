package io.github.mrciller.cillhub

import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Chooses how notifications reach the phone: the gateway foreground service (default, needs nothing
 * else) or, when the user turns that off and the build has Firebase and the server has an FCM sender,
 * Firebase Cloud Messaging. Never both, so nothing is shown twice.
 */
object Delivery {
    private const val TAG = "CillcordDelivery"

    fun firebaseAvailable(ctx: Context): Boolean = BuildConfig.HAS_FIREBASE && FirebaseApp.getApps(ctx).isNotEmpty()

    /** Call after login, logout and settings changes. startService: we are in the foreground (may start the service). */
    fun apply(ctx: Context, startService: Boolean = true) {
        val prefs = Prefs(ctx)
        val token = TokenStore.get(ctx)
        if (token == null || !prefs.background) GatewayService.stop(ctx)
        else if (startService) GatewayService.start(ctx)
        val wantFcm = token != null && !prefs.background && firebaseAvailable(ctx)
        @Suppress("DEPRECATION") // Firebase 26 prefers register()/onRegistered; getToken() still returns the same token
        if (wantFcm) FirebaseMessaging.getInstance().token.addOnSuccessListener { register(ctx, it) }
        else prefs.fcmRegistered?.let { old -> Thread { unregister(ctx, old, token) }.start() }
    }

    /** New or current FCM token: tell the server, if FCM is the chosen path. */
    fun register(ctx: Context, fcmToken: String) {
        val prefs = Prefs(ctx)
        if (prefs.background || !firebaseAvailable(ctx)) return
        val api = Api.of(ctx) ?: return
        Thread {
            try {
                if (!api.fcmEnabled()) { Log.i(TAG, "server has no FCM sender"); return@Thread }
                api.registerFcm(fcmToken)
                prefs.fcmRegistered = fcmToken
            } catch (e: Exception) {
                Log.w(TAG, "FCM registration failed: ${e.message}")
            }
        }.start()
    }

    /** Blocking; with the token that registered it (logout passes the old one). */
    fun unregister(ctx: Context, fcmToken: String, authToken: String?) {
        try {
            authToken?.let { Api(it).unregisterFcm(fcmToken) }
        } catch (e: Exception) {
            Log.w(TAG, "FCM unregistration failed: ${e.message}")
        }
        Prefs(ctx).fcmRegistered = null
    }
}
