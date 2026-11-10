package io.github.mrciller.cillhub.ui

import android.animation.ValueAnimator
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.CutCornerShape
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
import androidx.compose.ui.text.font.DeviceFontFamilyName
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Argon Tactile Obsidian & Daylight Slate palette (client/src/index.css and appearance.css):
//   Dark  --rail #090C12, --panel #0B0F18, --sidebar #0F141E, --chat #141A26, --input #1B2333, --selected #232E45, --accent #FF6A1F (matches the web client), --signal #F43F5E
//   Light --rail #DFE5EF, --panel #E5EAF3, --sidebar #EEF2F7, --chat #FAFBFD, --input #E6ECF5, --selected #D3DEEF, --accent #B84300, --signal #BE123C
internal val Dark = darkColorScheme(
    primary = Color(0xFFFF6A1F), onPrimary = Color(0xFF1A0A00),
    primaryContainer = Color(0xFF4A1D05), onPrimaryContainer = Color(0xFFFFDBC8),
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
    surfaceTint = Color(0xFFFF6A1F),
    outline = Color(0xFF384664), outlineVariant = Color(0xFF253047),
    error = Color(0xFFF43F5E), onError = Color(0xFFFFFFFF), errorContainer = Color(0xFF4C0519), onErrorContainer = Color(0xFFFFE4E6),
    inverseSurface = Color(0xFFF5F8FF), inverseOnSurface = Color(0xFF0F141E), inversePrimary = Color(0xFFB84300),
    scrim = Color(0xFF000000),
)

internal val Light = lightColorScheme(
    primary = Color(0xFFB84300), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFFFDBC8), onPrimaryContainer = Color(0xFF3A1300),
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
    surfaceTint = Color(0xFFB84300),
    outline = Color(0xFF94A3B8), outlineVariant = Color(0xFFCBD5E4),
    error = Color(0xFFBE123C), onError = Color(0xFFFFFFFF), errorContainer = Color(0xFFFFE4E6), onErrorContainer = Color(0xFF4C0519),
    inverseSurface = Color(0xFF1C2536), inverseOnSurface = Color(0xFFFAFBFD), inversePrimary = Color(0xFFFF6A1F),
    scrim = Color(0xFF000000),
)

// HUD shape language: cut corners instead of rounded ones (the web client's `corner-shape: bevel`)
val ArgonShapes = Shapes(
    extraSmall = CutCornerShape(3.dp),
    small = CutCornerShape(6.dp),
    medium = CutCornerShape(10.dp),
    large = CutCornerShape(14.dp),
    extraLarge = CutCornerShape(18.dp),
)
/** The signature bevel: one cut on the leading top and trailing bottom corner (server icons, the selected row, primary buttons). */
val Hud = CutCornerShape(topStart = 12.dp, bottomEnd = 12.dp)

/** The display face: the system's condensed sans (Roboto Condensed on stock Android), bold, for headers and labels. */
val Condensed = FontFamily(Font(DeviceFontFamilyName("sans-serif-condensed"), FontWeight.Bold))

// Material Design 3 Typography Tokens (https://m3.material.io/styles/typography/type-scale-tokens); headlines and
// titleLarge in the condensed display face, body in the default sans
val ArgonTypography = Typography(
    displayLarge = TextStyle(fontFamily = Condensed, fontSize = 57.sp, lineHeight = 60.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.sp),
    displayMedium = TextStyle(fontFamily = Condensed, fontSize = 45.sp, lineHeight = 48.sp, fontWeight = FontWeight.Bold),
    displaySmall = TextStyle(fontFamily = Condensed, fontSize = 36.sp, lineHeight = 40.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
    headlineLarge = TextStyle(fontFamily = Condensed, fontSize = 32.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold),
    headlineMedium = TextStyle(fontFamily = Condensed, fontSize = 28.sp, lineHeight = 32.sp, fontWeight = FontWeight.Bold),
    headlineSmall = TextStyle(fontFamily = Condensed, fontSize = 24.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
    titleLarge = TextStyle(fontFamily = Condensed, fontSize = 22.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.15.sp),
    titleSmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.1.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.Normal, letterSpacing = 0.5.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Normal, letterSpacing = 0.25.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Normal, letterSpacing = 0.4.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.1.sp),
    // section headers (categories, member groups): condensed, wide tracking, meant to be uppercased by the caller
    labelMedium = TextStyle(fontFamily = Condensed, fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.5.sp),
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
