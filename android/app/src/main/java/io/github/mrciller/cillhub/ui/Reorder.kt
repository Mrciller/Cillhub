package io.github.mrciller.cillhub.ui

import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.zIndex
import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.Role

/**
 * Drag to reorder rows of a LazyColumn by a handle: the dragged row follows the finger and swaps places with the row
 * under its middle; the list scrolls while the row is dragged against an edge. [items] is the order as dragged.
 */
class DragList<T>(initial: List<T>, private val key: (T) -> Any, private val lazy: LazyListState) {
    val items = initial.toMutableStateList()
    var dragging by mutableStateOf<Any?>(null); private set
    private var offset by mutableFloatStateOf(0f)

    fun drag(dy: Float) {
        val k = dragging ?: return
        offset += dy
        val layout = lazy.layoutInfo
        val cur = layout.visibleItemsInfo.firstOrNull { it.key == k } ?: return
        val mid = cur.offset + offset + cur.size / 2
        val edge = cur.size.toFloat()
        val scroll = when {
            mid > layout.viewportEndOffset - edge && dy > 0 -> dy
            mid < layout.viewportStartOffset + edge && dy < 0 -> dy
            else -> 0f
        }
        if (scroll != 0f) offset += lazy.dispatchRawDelta(scroll)
        val over = layout.visibleItemsInfo.firstOrNull { it.key != k && mid >= it.offset && mid < it.offset + it.size } ?: return
        val from = items.indexOfFirst { key(it) == k }
        val to = items.indexOfFirst { key(it) == over.key }
        if (from < 0 || to < 0) return
        items.add(to, items.removeAt(from))
        // the row is laid out at its new slot next frame: keep it under the finger
        offset -= if (to > from) over.offset + over.size - cur.size - cur.offset else over.offset - cur.offset
    }

    /** The row under drag follows the finger and draws above the others. */
    fun rowModifier(k: Any): Modifier =
        if (dragging == k) Modifier.zIndex(1f).graphicsLayer { translationY = offset; shadowElevation = 8f } else Modifier

    /** The handle: drag starts at once (no long press), [onDrop] gets the dragged item. */
    fun handle(k: Any, onDrop: (T) -> Unit): Modifier = Modifier.pointerInput(this, k) {
        fun end() {
            val moved = items.firstOrNull { key(it) == dragging }
            dragging = null; offset = 0f
            moved?.let(onDrop)
        }
        detectDragGestures(onDragStart = { dragging = k; offset = 0f }, onDragEnd = ::end, onDragCancel = ::end) { change, amount -> change.consume(); drag(amount.y) }
    }
}

/** Positions for roles listed top to bottom (without @everyone): the top role gets the highest; the server renumbers 1..n. */
fun rolePositions(order: List<Role>): List<Pair<String, Int>> = order.mapIndexed { i, r -> r.id to order.size - i }

/** True when the drag kept every role the user may not move at its old place (the server would refuse the rest). */
fun rolesStayPut(before: List<Role>, after: List<Role>, movable: (Role) -> Boolean) =
    before.size == after.size && after.indices.all { i -> movable(after[i]) || after[i].id == before[i].id }

/**
 * Parents and positions after a channel drag. [flat] is the list as dropped: channels without a category first, then
 * each category followed by its channels. A dragged channel joins the category above it (none above: no category);
 * a dragged category moves alone and keeps its channels. Returns the channels whose position or parent changed.
 */
fun channelMoves(flat: List<Channel>, moved: Channel): List<Channel> {
    val cats = flat.filter { it.type == 4 }
    val catIds = cats.map { it.id }.toSet()
    val parentOf = HashMap<String, String?>()
    if (moved.type == 4) {
        for (c in flat) if (c.type != 4) parentOf[c.id] = c.parentId?.takeIf { it in catIds }
    } else {
        var cat: String? = null
        for (c in flat) if (c.type == 4) cat = c.id else parentOf[c.id] = if (c.id == moved.id) cat else c.parentId?.takeIf { it in catIds }
    }
    val out = ArrayList<Channel>()
    cats.forEachIndexed { i, c -> if (c.position != i) out += c.copy(position = i) }
    flat.filter { it.type != 4 }.groupBy { parentOf[it.id] }.forEach { (parent, list) ->
        list.forEachIndexed { i, c -> if (c.position != i || c.parentId != parent) out += c.copy(position = i, parentId = parent) }
    }
    return out
}
