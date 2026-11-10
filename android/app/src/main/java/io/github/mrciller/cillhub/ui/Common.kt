package io.github.mrciller.cillhub.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import kotlinx.coroutines.delay
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import io.github.mrciller.cillhub.Config
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.ApiError
import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.Guild
import io.github.mrciller.cillhub.data.User
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@Composable
fun Ic(@DrawableRes id: Int, contentDescription: String?, modifier: Modifier = Modifier, tint: Color = androidx.compose.material3.LocalContentColor.current) =
    Icon(painterResource(id), contentDescription, modifier, tint)

private val AVATAR_COLORS = listOf(0xFF0098B3, 0xFF2563EB, 0xFF7C3AED, 0xFFE11D48, 0xFFD97706, 0xFF059669, 0xFF475569).map { Color(it) }

/** A stable colour per id for letter avatars. */
fun idColor(id: String) = AVATAR_COLORS[(id.hashCode() and 0x7fffffff) % AVATAR_COLORS.size]

fun avatarUrl(u: User?): String? = u?.avatar?.let { Config.cdn("/avatars/${u.id}/$it.png?size=128") }
fun guildIconUrl(g: Guild): String? = g.icon?.let { Config.cdn("/icons/${g.id}/$it.png?size=128") }
fun groupIconUrl(c: Channel): String? = c.icon?.let { Config.cdn("/channel-icons/${c.id}/$it.png?size=128") }

/** An image with a letter fallback (no image, or it failed to load). */
@Composable
fun Picture(url: String?, letterOf: String, id: String, size: Dp, shape: Shape = CircleShape, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(shape).background(idColor(id)), contentAlignment = Alignment.Center) {
        Text(letterOf.trim().take(1).uppercase().ifEmpty { "?" }, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = (size.value * 0.42f).sp)
        if (url != null) AsyncImage(url, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
    }
}

@Composable
fun presenceColor(status: String): Color = LocalExtra.current.let {
    when (status) { "online" -> it.online; "idle" -> it.idle; "dnd" -> it.dnd; else -> it.offline }
}

@StringRes
fun presenceLabel(status: String) = when (status) { "online" -> R.string.status_online; "idle" -> R.string.status_idle; "dnd" -> R.string.status_dnd; "invisible" -> R.string.status_invisible; else -> R.string.status_offline }

/** User avatar with an optional presence dot (its meaning is in the row's accessibility text). */
@Composable
fun Avatar(user: User?, size: Dp, presence: String? = null, modifier: Modifier = Modifier) {
    Box(modifier.size(size)) {
        Picture(avatarUrl(user), user?.displayName ?: "?", user?.id ?: "0", size)
        if (presence != null) {
            val dot = (size.value * 0.32f).dp
            Box(
                Modifier.align(Alignment.BottomEnd).size(dot).clip(CircleShape).background(presenceColor(presence))
                    .border((size.value * 0.06f).coerceAtLeast(1.5f).dp, MaterialTheme.colorScheme.surface, CircleShape)
            )
        }
    }
}

/** A red count tag (mentions), or nothing. */
@Composable
fun CountBadge(count: Int, modifier: Modifier = Modifier) {
    if (count <= 0) return
    Box(modifier.sizeIn(minWidth = 20.dp, minHeight = 20.dp).clip(MaterialTheme.shapes.extraSmall).background(LocalExtra.current.mention).padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
        Text(if (count > 99) "99+" else count.toString(), color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

/** A section header in the HUD style: condensed uppercase label with a hairline rule running out to the end. */
@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Row(modifier.fillMaxWidth().semantics { heading() }, verticalAlignment = Alignment.CenterVertically) {
        Text(text.uppercase(), style = MaterialTheme.typography.labelMedium, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Box(Modifier.weight(1f).padding(start = 10.dp).height(1.dp).background(MaterialTheme.colorScheme.outlineVariant))
    }
}

@Composable
fun EmptyState(@DrawableRes icon: Int, title: String, text: String? = null, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center) {
        Box(
            Modifier.size(72.dp).clip(Hud).background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, Hud),
            contentAlignment = Alignment.Center,
        ) {
            Ic(icon, null, Modifier.size(34.dp), MaterialTheme.colorScheme.primary)
        }
        Text(title.uppercase(), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 16.dp), textAlign = TextAlign.Center)
        if (text != null) Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp), textAlign = TextAlign.Center)
    }
}

// Motion. Every helper is a no-op when the system's "Remove animations" is on. Springs (M3 standard spatial
// motion), never linear tweens; values are only read in the draw phase so a running animation recomposes nothing.

/** M3 standard spatial spring: settles in ~350 ms without overshoot. */
val Spatial = spring<Float>(Spring.DampingRatioNoBouncy, Spring.StiffnessMediumLow)
/** M3 emphasized easing: enter decelerates, exit accelerates. */
val EmphasizedDecelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
val EmphasizedAccelerate = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)

/** Remember once where a list lives and pass to [reveal]: rows only animate while the list is new (its first 400 ms). */
@Composable
fun rememberRevealClock(): Long = remember { android.os.SystemClock.uptimeMillis() }

/**
 * Fades and slides a row in when its list first appears, staggered 25 ms by [index] (the first six rows; the rest come
 * with the sixth). A row composed later (scrolled back into view, a new message or channel) is shown as-is.
 */
@Composable
fun Modifier.reveal(index: Int, clock: Long): Modifier {
    val reduce = LocalReduceMotion.current
    val animate = remember { !reduce && android.os.SystemClock.uptimeMillis() - clock < 400 }
    if (!animate) return this
    val shown = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        delay((index.coerceAtMost(6) * 25).toLong())
        shown.animateTo(1f, Spatial)
    }
    return graphicsLayer { alpha = shown.value; translationY = (1f - shown.value) * 8.dp.toPx() }
}

/** Shrinks the element a little while it is pressed (press feedback for icons that have no ripple of their own). */
@Composable
fun Modifier.pressScale(interaction: MutableInteractionSource): Modifier {
    if (LocalReduceMotion.current) return this
    val pressed by interaction.collectIsPressedAsState()
    // stiff on the way down so the touch answers at once, the standard spring on release
    val scale = animateFloatAsState(if (pressed) 0.96f else 1f, if (pressed) spring(Spring.DampingRatioNoBouncy, Spring.StiffnessHigh) else Spatial, label = "press")
    return graphicsLayer { scaleX = scale.value; scaleY = scale.value }
}

/** A ring in [color] around a round element while [on]: pulsing, or a plain ring with animations off (live / speaking). */
@Composable
fun Modifier.speakingRing(on: Boolean, color: Color, width: Dp = 3.dp): Modifier {
    if (!on) return this
    val reduce = LocalReduceMotion.current
    // a sine-like ease is symmetric, so the reversed repeat has no kink at the turning points
    val pulse = if (reduce) null else rememberInfiniteTransition(label = "speaking").animateFloat(
        0f, 1f, infiniteRepeatable(tween(800, easing = CubicBezierEasing(0.45f, 0f, 0.55f, 1f)), RepeatMode.Reverse), label = "pulse",
    )
    return drawBehind {
        val p = pulse?.value ?: 0f
        val w = width.toPx()
        val r = size.minDimension / 2 + w / 2 + p * w
        drawCircle(color, r, alpha = 1f - p * 0.5f, style = Stroke(w))
    }
}

/** Readable text for a failed request. */
fun errorText(ctx: Context, e: Throwable): String = when {
    e is ApiError && e.status == 0 -> ctx.getString(R.string.error_network)
    e is ApiError && e.status == 429 -> ctx.getString(R.string.error_slow_down, Math.ceil(e.retryAfter).toInt().coerceAtLeast(1))
    else -> e.message ?: ctx.getString(R.string.error_generic)
}

@Composable
fun errorText(e: Throwable): String = errorText(androidx.compose.ui.platform.LocalContext.current, e)

private val timeFmt = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
private val dateFmt = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)

fun instantOf(iso: String): Instant? = runCatching { Instant.parse(iso) }.getOrNull()

/** "10:32", "Yesterday, 10:32" or "5 Nov 2026, 10:32" in the device's locale. */
fun messageTime(ctx: Context, iso: String): String {
    val t = instantOf(iso)?.atZone(ZoneId.systemDefault()) ?: return ""
    val today = LocalDate.now()
    return when (t.toLocalDate()) {
        today -> t.format(timeFmt)
        today.minusDays(1) -> ctx.getString(R.string.yesterday_at, t.format(timeFmt))
        else -> "${t.format(dateFmt)}, ${t.format(timeFmt)}"
    }
}

fun shortTime(iso: String): String = instantOf(iso)?.atZone(ZoneId.systemDefault())?.format(timeFmt) ?: ""
fun dayOf(iso: String): LocalDate? = instantOf(iso)?.atZone(ZoneId.systemDefault())?.toLocalDate()
fun dayLabel(ctx: Context, d: LocalDate): String = when (d) {
    LocalDate.now() -> ctx.getString(R.string.today)
    LocalDate.now().minusDays(1) -> ctx.getString(R.string.yesterday)
    else -> d.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG))
}

fun openUrl(ctx: Context, url: String) {
    try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)) } catch (e: Exception) { }
}

@Composable
fun s(@StringRes id: Int, vararg args: Any): String = stringResource(id, *args)
