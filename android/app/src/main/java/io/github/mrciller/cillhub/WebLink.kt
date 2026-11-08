package io.github.mrciller.cillhub

import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/** Native -> web client messages, delivered through the bridge port of the visible WebView. */
object WebLink {
    private val main = Handler(Looper.getMainLooper())
    private val pending = ArrayList<String>()
    private var sink: ((String) -> Unit)? = null

    /** queue: keep it until a page connects (e.g. join a call after the app opens); else drop it when no page is there. */
    fun send(msg: JSONObject, queue: Boolean) = main.post {
        val s = sink
        if (s != null) s(msg.toString()) else if (queue) pending.add(msg.toString())
    }

    fun attach(s: (String) -> Unit) = main.post {
        sink = s
        pending.forEach(s)
        pending.clear()
    }

    fun detach() = main.post { sink = null }
}
