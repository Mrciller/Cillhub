package io.github.mrciller.cillhub.ui

import android.animation.ValueAnimator
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Argon Tactile Obsidian & Daylight Slate palette (client/src/index.css and appearance.css):
//   Dark  --rail #090C12, --panel #0B0F18, --sidebar #0F141E, --chat #141A26, --input #1B2333, --selected #232E45, --accent #00D2EB, --signal #F43F5E
//   Light --rail #DFE5EF, --panel #E5EAF3, --sidebar #EEF2F7, --chat #FAFBFD, --input #E6ECF5, --selected #D3DEEF, --accent #0068A8, --signal #BE123C
internal val Dark = darkColorScheme(
    primary = Color(0xFF00D2EB), onPrimary = Color(0xFF041318),
    primaryContainer = Color(0xFF0A3242), onPrimaryContainer = Color(0xFFA5F3FC),
    secondary = Color(0xFF38BDF8), onSecondary = Color(0xFF041318),
    secondaryContainer = Color(0xFF232E45), onSecondaryContainer = Color(0xFFF5F8FF),
    tertiary = Color(0xFFF43F5E), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFF4C0519), onTertiaryContainer = Color(0xFFFFE4E6),
    background = Color(0xFF141A26), onBackground = Color(0xFFDFE6F4),
    surface = Color(0xFF141A26), onSurface = Color(0xFFDFE6F4),
    surfaceVariant = Color(0xFF1B2333), onSurfaceVariant = Color(0xFF929FB8),
    surfaceContainerLowest = Color(0xFF090C12), surfaceContainerLow = Color(0xFF0B0F18),
    surfaceContainer = Color(0xFF0F141E), surfaceContainerHigh = Color(0xFF1B2333), surfaceContainerHighest = Color(0xFF232E45),
    surfaceBright = Color(0xFF28344E), surfaceDim = Color(0xFF090C12),
    outline = Color(0xFF384664), outlineVariant = Color(0xFF253047),
    error = Color(0xFFF43F5E), onError = Color(0xFFFFFFFF), errorContainer = Color(0xFF4C0519), onErrorContainer = Color(0xFFFFE4E6),
    inverseSurface = Color(0xFFF5F8FF), inverseOnSurface = Color(0xFF0F141E), inversePrimary = Color(0xFF0068A8),
    scrim = Color(0xFF000000),
)

internal val Light = lightColorScheme(
    primary = Color(0xFF0068A8), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFD6EFFF), onPrimaryContainer = Color(0xFF002038),
    secondary = Color(0xFF0284C7), onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFD3DEEF), onSecondaryContainer = Color(0xFF0D1320),
    tertiary = Color(0xFFBE123C), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFFFE4E6), onTertiaryContainer = Color(0xFF4C0519),
    background = Color(0xFFFAFBFD), onBackground = Color(0xFF1C2536),
    surface = Color(0xFFFAFBFD), onSurface = Color(0xFF1C2536),
    surfaceVariant = Color(0xFFE6ECF5), onSurfaceVariant = Color(0xFF505E75),
    surfaceContainerLowest = Color(0xFFDFE5EF), surfaceContainerLow = Color(0xFFE5EAF3),
    surfaceContainer = Color(0xFFEEF2F7), surfaceContainerHigh = Color(0xFFE6ECF5), surfaceContainerHighest = Color(0xFFD3DEEF),
    surfaceBright = Color(0xFFFFFFFF), surfaceDim = Color(0xFFDFE5EF),
    outline = Color(0xFF94A3B8), outlineVariant = Color(0xFFCBD5E4),
    error = Color(0xFFBE123C), onError = Color(0xFFFFFFFF), errorContainer = Color(0xFFFFE4E6), onErrorContainer = Color(0xFF4C0519),
    inverseSurface = Color(0xFF1C2536), inverseOnSurface = Color(0xFFFAFBFD), inversePrimary = Color(0xFF00D2EB),
    scrim = Color(0xFF000000),
)

val ArgonShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(22.dp),
)

val ArgonTypography = Typography(
    displaySmall = TextStyle(fontSize = 34.sp, lineHeight = 40.sp, fontWeight = FontWeight.Black, letterSpacing = (-0.5).sp),
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.3).sp),
    titleLarge = TextStyle(fontSize = 19.sp, lineHeight = 25.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.2).sp),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.1).sp),
    titleSmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.2.sp),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp, fontWeight = FontWeight.Normal),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Normal),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 17.sp, fontWeight = FontWeight.Normal),
    labelLarge = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.1.sp),
    labelMedium = TextStyle(fontSize = 11.5.sp, lineHeight = 15.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.2.sp),
    labelSmall = TextStyle(fontSize = 10.5.sp, lineHeight = 14.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.3.sp),
)

/** Colours Material has no role for: presence, mention highlight. */
@Immutable
data class Extra(val online: Color, val idle: Color, val dnd: Color, val offline: Color, val mention: Color, val mentionBg: Color, val isDark: Boolean)

internal val DarkExtra = Extra(Color(0xFF10B981), Color(0xFFF59E0B), Color(0xFFF43F5E), Color(0xFF6E7B94), Color(0xFFF43F5E), Color(0x20F59E0B), true)
internal val LightExtra = Extra(Color(0xFF0D8252), Color(0xFFA15C00), Color(0xFFC81E3A), Color(0xFF5A677D), Color(0xFFBE123C), Color(0x1FD97706), false)

val LocalExtra = staticCompositionLocalOf { DarkExtra }
/** True when the system's "Remove animations" is on (animator duration scale 0). */
val LocalReduceMotion = staticCompositionLocalOf { false }

@Composable
fun CillhubTheme(theme: String, dynamic: Boolean, content: @Composable () -> Unit) {
    val dark = when (theme) { "light" -> false; "dark" -> true; else -> isSystemInDarkTheme() }
    val ctx = LocalContext.current
    val scheme: ColorScheme = when {
        dynamic && Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        dark -> Dark
        else -> Light
    }
    CompositionLocalProvider(LocalExtra provides if (dark) DarkExtra else LightExtra, LocalReduceMotion provides !ValueAnimator.areAnimatorsEnabled()) {
        MaterialTheme(colorScheme = scheme, typography = ArgonTypography, shapes = ArgonShapes, content = content)
    }
}
