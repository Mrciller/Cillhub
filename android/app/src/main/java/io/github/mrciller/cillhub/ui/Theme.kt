package io.github.mrciller.cillhub.ui

import android.animation.ValueAnimator
import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.CutCornerShape
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
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import io.github.mrciller.cillhub.R

// Arena design system (the web client's client/src/index.css and appearance/appearance.css). Roles per the phone app
// mapping: background/surface = chat, containers lowest..highest = rail, sidebar, card, menu, input; primary = accent,
// secondaryContainer = selected, onSurface = text, onSurfaceVariant = muted, outline = border, error = danger, tertiary = focus.
internal val Dark = darkColorScheme(
    primary = Color(0xFFFF6A1F), onPrimary = Color(0xFF170900),
    primaryContainer = Color(0xFF2A2E36), onPrimaryContainer = Color(0xFFFFFFFF),
    secondary = Color(0xFFC0C6D0), onSecondary = Color(0xFF17191E),
    secondaryContainer = Color(0xFF2A2E36), onSecondaryContainer = Color(0xFFF7F8FA),
    tertiary = Color(0xFF7CC4FF), onTertiary = Color(0xFF0B0C0F),
    tertiaryContainer = Color(0xFF2A2E36), onTertiaryContainer = Color(0xFFF7F8FA),
    background = Color(0xFF17191E), onBackground = Color(0xFFE3E6EC),
    surface = Color(0xFF17191E), onSurface = Color(0xFFE3E6EC),
    surfaceVariant = Color(0xFF1F2228), onSurfaceVariant = Color(0xFF9AA1AD),
    surfaceContainerLowest = Color(0xFF0B0C0F), surfaceContainerLow = Color(0xFF121418),
    surfaceContainer = Color(0xFF1A1D23), surfaceContainerHigh = Color(0xFF15171C), surfaceContainerHighest = Color(0xFF1F2228),
    surfaceBright = Color(0xFF202329), surfaceDim = Color(0xFF0B0C0F),
    surfaceTint = Color(0xFF17191E), // = surface: no tonal tint on raised surfaces
    outline = Color(0xFF2C3038), outlineVariant = Color(0xFF2C3038),
    // errorContainer: danger 16% over chat, like the web's color-mix tints
    error = Color(0xFFFF4D4D), onError = Color(0xFF170900), errorContainer = Color(0xFF3C2126), onErrorContainer = Color(0xFFFF8A8A),
    inverseSurface = Color(0xFFE3E6EC), inverseOnSurface = Color(0xFF121418), inversePrimary = Color(0xFFC2410C),
    scrim = Color(0xFF000000),
)

internal val Light = lightColorScheme(
    primary = Color(0xFFC2410C), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFD8DCE3), onPrimaryContainer = Color(0xFF0D1016),
    secondary = Color(0xFF3D4555), onSecondary = Color(0xFFFBFBFC),
    secondaryContainer = Color(0xFFD8DCE3), onSecondaryContainer = Color(0xFF0D1016),
    tertiary = Color(0xFF0B5FD6), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFD8DCE3), onTertiaryContainer = Color(0xFF0D1016),
    background = Color(0xFFFBFBFC), onBackground = Color(0xFF1D2128),
    surface = Color(0xFFFBFBFC), onSurface = Color(0xFF1D2128),
    surfaceVariant = Color(0xFFECEEF2), onSurfaceVariant = Color(0xFF596271),
    surfaceContainerLowest = Color(0xFFE3E6EB), surfaceContainerLow = Color(0xFFEEF0F3),
    surfaceContainer = Color(0xFFF2F4F7), surfaceContainerHigh = Color(0xFFFFFFFF), surfaceContainerHighest = Color(0xFFECEEF2),
    surfaceBright = Color(0xFFFFFFFF), surfaceDim = Color(0xFFE3E6EB),
    surfaceTint = Color(0xFFFBFBFC),
    outline = Color(0xFFC8CDD6), outlineVariant = Color(0xFFC8CDD6),
    error = Color(0xFFD93A42), onError = Color(0xFFFFFFFF), errorContainer = Color(0xFFF6DCDE), onErrorContainer = Color(0xFFB91C1C),
    inverseSurface = Color(0xFF1D2128), inverseOnSurface = Color(0xFFFBFBFC), inversePrimary = Color(0xFFFF6A1F),
    scrim = Color(0xFF000000),
)

/** Ash and Onyx change surfaces only (and Ash lifts text and muted a step). */
internal val Ash = Dark.copy(
    background = Color(0xFF24262D), surface = Color(0xFF24262D), surfaceTint = Color(0xFF24262D), surfaceVariant = Color(0xFF2D3038),
    surfaceContainerLowest = Color(0xFF17181C), surfaceContainerLow = Color(0xFF1D1F25),
    surfaceContainer = Color(0xFF22252C), surfaceContainerHigh = Color(0xFF25282F), surfaceContainerHighest = Color(0xFF2D3038),
    surfaceBright = Color(0xFF2C2F37), surfaceDim = Color(0xFF17181C),
    primaryContainer = Color(0xFF363A44), secondaryContainer = Color(0xFF363A44), tertiaryContainer = Color(0xFF363A44),
    outline = Color(0xFF3A3E48), outlineVariant = Color(0xFF3A3E48),
    onBackground = Color(0xFFE8EAEF), onSurface = Color(0xFFE8EAEF), onSurfaceVariant = Color(0xFFAAB0BB),
)

internal val Onyx = Dark.copy(
    background = Color(0xFF0A0A0C), surface = Color(0xFF0A0A0C), surfaceTint = Color(0xFF0A0A0C), surfaceVariant = Color(0xFF15161A),
    surfaceContainerLowest = Color(0xFF000000), surfaceContainerLow = Color(0xFF060607),
    surfaceContainer = Color(0xFF0E0F12), surfaceContainerHigh = Color(0xFF0E0F12), surfaceContainerHighest = Color(0xFF15161A),
    surfaceBright = Color(0xFF141518), surfaceDim = Color(0xFF000000),
    primaryContainer = Color(0xFF1E1F24), secondaryContainer = Color(0xFF1E1F24), tertiaryContainer = Color(0xFF1E1F24),
    outline = Color(0xFF24262C), outlineVariant = Color(0xFF24262C),
)

/** The notch: the HUD cut on the top-left and bottom-right corner of cards, dialogs and sheets. Never on rows, buttons or fields. */
val Hud = CutCornerShape(topStart = 12.dp, bottomEnd = 12.dp)

/** radius-s: buttons, fields, chips, list rows. M3 buttons default to pills, so they take this explicitly. */
val Sharp = RoundedCornerShape(2.dp)

// radius-s / radius-m / radius-l; extraLarge carries the notch because M3 draws dialogs and bottom sheets with it
val ArenaShapes = Shapes(
    extraSmall = Sharp,
    small = Sharp,
    medium = RoundedCornerShape(3.dp),
    large = RoundedCornerShape(4.dp),
    extraLarge = Hud,
)

private fun inter(w: Int) = Font(R.font.inter, FontWeight(w), variationSettings = FontVariation.Settings(FontVariation.weight(w)))
val Inter = FontFamily(inter(400), inter(500), inter(600), inter(700))
/** display: Barlow Condensed 600, for headings and labels (uppercase by the caller). */
val Condensed = FontFamily(Font(R.font.barlow_condensed_semibold, FontWeight.SemiBold))
val Mono = FontFamily(Font(R.font.jetbrains_mono, FontWeight.Normal, variationSettings = FontVariation.Settings(FontVariation.weight(400))))

private val display = TextStyle(fontFamily = Condensed, fontWeight = FontWeight.SemiBold, letterSpacing = 0.02.em)
private val label = TextStyle(fontFamily = Condensed, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.08.em)

// display-xl -> headlineMedium, display-l -> titleLarge, label -> labelLarge (and labelMedium, the section headers here),
// title -> titleMedium, body -> bodyLarge, body-s -> bodyMedium, caption -> labelSmall; the rest fill the gaps
val ArenaTypography = Typography(
    displayLarge = display.copy(fontSize = 57.sp, lineHeight = 60.sp),
    displayMedium = display.copy(fontSize = 45.sp, lineHeight = 48.sp),
    displaySmall = display.copy(fontSize = 36.sp, lineHeight = 40.sp),
    headlineLarge = display.copy(fontSize = 36.sp, lineHeight = 38.sp),
    headlineMedium = display.copy(fontSize = 32.sp, lineHeight = 34.sp),
    headlineSmall = display.copy(fontSize = 26.sp, lineHeight = 30.sp),
    titleLarge = display.copy(fontSize = 22.sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontFamily = Inter, fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontFamily = Inter, fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontFamily = Inter, fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.006).em),
    bodyMedium = TextStyle(fontFamily = Inter, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Normal),
    bodySmall = TextStyle(fontFamily = Inter, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Normal),
    labelLarge = label,
    labelMedium = label,
    labelSmall = TextStyle(fontFamily = Inter, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
)

/** Colours Material has no role for: presence, mention highlight. */
@Immutable
data class Extra(val online: Color, val idle: Color, val dnd: Color, val offline: Color, val mention: Color, val mentionBg: Color, val isDark: Boolean)

internal val DarkExtra = Extra(Color(0xFF2FD36A), Color(0xFFFFB020), Color(0xFFFF4D4D), Color(0xFF7D8591), Color(0xFFFF3D57), Color(0x1AFF3D57), true)
internal val LightExtra = Extra(Color(0xFF15803D), Color(0xFFFFB020), Color(0xFFD93A42), Color(0xFF6B7380), Color(0xFFBE123C), Color(0x14BE123C), false)

val LocalExtra = staticCompositionLocalOf { DarkExtra }
/** True when the system's "Remove animations" is on (animator duration scale 0). */
val LocalReduceMotion = staticCompositionLocalOf { false }

@Composable
fun CillhubTheme(theme: String, dynamic: Boolean, content: @Composable () -> Unit) {
    val dark = when (theme) { "light" -> false; "dark", "ash", "onyx" -> true; else -> isSystemInDarkTheme() }
    val ctx = LocalContext.current
    val scheme: ColorScheme = when {
        dynamic && Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        theme == "ash" -> Ash
        theme == "onyx" -> Onyx
        dark -> Dark
        else -> Light
    }
    // bar icons follow the app's theme, not the system's (the bars are transparent over our surfaces)
    val view = LocalView.current
    if (!view.isInEditMode) SideEffect {
        (view.context as? Activity)?.window?.let { WindowCompat.getInsetsController(it, view).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark } }
    }
    CompositionLocalProvider(LocalExtra provides if (dark) DarkExtra else LightExtra, LocalReduceMotion provides !ValueAnimator.areAnimatorsEnabled()) {
        MaterialTheme(colorScheme = scheme, typography = ArenaTypography, shapes = ArenaShapes, content = content)
    }
}
