package io.github.mrciller.cillhub.ui

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

class ThemeTest {
    private fun channelLum(c: Float): Double {
        val v = c.toDouble()
        return if (v <= 0.03928) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4)
    }

    private fun luminance(c: Color): Double =
        0.2126 * channelLum(c.red) + 0.7152 * channelLum(c.green) + 0.0722 * channelLum(c.blue)

    private fun contrast(a: Color, b: Color): Double {
        val l1 = luminance(a)
        val l2 = luminance(b)
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }

    @Test fun arenaPalettesMatchWebClientAndMeetWcagAaContrast() {
        assertEquals(Color(0xFFFF6A1F), Dark.primary)
        assertEquals(Color(0xFF170900), Dark.onPrimary)
        assertEquals(Color(0xFF17191E), Dark.surface)
        assertEquals(Color(0xFF0B0C0F), Dark.surfaceContainerLowest)
        assertEquals(Color(0xFFFF3D57), DarkExtra.mention)

        assertEquals(Color(0xFFC2410C), Light.primary)
        assertEquals(Color(0xFFFBFBFC), Light.surface)
        assertEquals(Color(0xFFBE123C), LightExtra.mention)

        assertEquals(Color(0xFF24262D), Ash.surface)
        assertEquals(Color(0xFF0A0A0C), Onyx.surface)
        assertEquals(Dark.primary, Onyx.primary)

        // Dark, Ash, Onyx WCAG AA (>= 4.5:1)
        for ((n, d) in listOf("Dark" to Dark, "Ash" to Ash, "Onyx" to Onyx)) {
            assertTrue("$n onSurface on surface >= 4.5", contrast(d.onSurface, d.surface) >= 4.5)
            assertTrue("$n onSurfaceVariant on surface >= 4.5", contrast(d.onSurfaceVariant, d.surface) >= 4.5)
            assertTrue("$n onSurfaceVariant on surfaceContainerLow >= 4.5", contrast(d.onSurfaceVariant, d.surfaceContainerLow) >= 4.5)
            assertTrue("$n onSurfaceVariant on surfaceContainerHighest >= 4.5", contrast(d.onSurfaceVariant, d.surfaceContainerHighest) >= 4.5)
            assertTrue("$n onPrimary on primary >= 4.5", contrast(d.onPrimary, d.primary) >= 4.5)
        }

        // Light WCAG AA (>= 4.5:1)
        assertTrue("Light onSurface on surface >= 4.5", contrast(Light.onSurface, Light.surface) >= 4.5)
        assertTrue("Light onSurfaceVariant on surface >= 4.5", contrast(Light.onSurfaceVariant, Light.surface) >= 4.5)
        assertTrue("Light onSurfaceVariant on surfaceContainerLow >= 4.5", contrast(Light.onSurfaceVariant, Light.surfaceContainerLow) >= 4.5)
        assertTrue("Light onPrimary on primary >= 4.5", contrast(Light.onPrimary, Light.primary) >= 4.5)
    }
}
