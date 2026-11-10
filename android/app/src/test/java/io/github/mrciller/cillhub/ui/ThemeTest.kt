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

    @Test fun argonPalettesMatchWebClientAndMeetWcagAaContrast() {
        assertEquals(Color(0xFFFF6A1F), Dark.primary)
        assertEquals(Color(0xFF141A26), Dark.surface)
        assertEquals(Color(0xFF090C12), Dark.surfaceContainerLowest)
        assertEquals(Color(0xFFF43F5E), DarkExtra.mention)

        assertEquals(Color(0xFFB84300), Light.primary)
        assertEquals(Color(0xFFFAFBFD), Light.surface)
        assertEquals(Color(0xFFBE123C), LightExtra.mention)

        // Dark WCAG AA (>= 4.5:1)
        assertTrue("Dark onSurface on surface >= 4.5", contrast(Dark.onSurface, Dark.surface) >= 4.5)
        assertTrue("Dark onSurfaceVariant on surface >= 4.5", contrast(Dark.onSurfaceVariant, Dark.surface) >= 4.5)
        assertTrue("Dark onSurfaceVariant on surfaceContainerLow >= 4.5", contrast(Dark.onSurfaceVariant, Dark.surfaceContainerLow) >= 4.5)
        assertTrue("Dark onPrimary on primary >= 4.5", contrast(Dark.onPrimary, Dark.primary) >= 4.5)

        // Light WCAG AA (>= 4.5:1)
        assertTrue("Light onSurface on surface >= 4.5", contrast(Light.onSurface, Light.surface) >= 4.5)
        assertTrue("Light onSurfaceVariant on surface >= 4.5", contrast(Light.onSurfaceVariant, Light.surface) >= 4.5)
        assertTrue("Light onSurfaceVariant on surfaceContainerLow >= 4.5", contrast(Light.onSurfaceVariant, Light.surfaceContainerLow) >= 4.5)
        assertTrue("Light onPrimary on primary >= 4.5", contrast(Light.onPrimary, Light.primary) >= 4.5)
    }
}
