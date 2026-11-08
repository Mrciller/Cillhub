package io.github.mrciller.cillhub.voice

import io.github.mrciller.cillhub.voice.AudioRouter.Device
import io.github.mrciller.cillhub.voice.AudioRouter.Type
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioRouterTest {
    private val ear = Device(Type.EARPIECE, "e")
    private val spk = Device(Type.SPEAKER, "s")
    private val wired = Device(Type.WIRED, "w")
    private val bt = Device(Type.BLUETOOTH, "b", "Car")
    private var speaker = false
    private val r = AudioRouter { speaker }

    @Test fun anAudioCallStartsOnTheEarpieceAVoiceChannelOnTheSpeaker() {
        assertEquals(ear, r.devices(listOf(ear, spk)))
        assertTrue(r.earpiece)
        speaker = true
        assertEquals(spk, r.refresh())
        assertFalse(r.earpiece)
    }

    @Test fun aHeadsetPresentAtTheStartIsUsed() {
        assertEquals(wired, r.devices(listOf(ear, spk, wired)))
        assertEquals(bt, AudioRouter { true }.devices(listOf(ear, spk, wired, bt)))
    }

    @Test fun aHeadsetThatConnectsTakesOverAndTheOldRouteReturnsWhenItGoes() {
        speaker = true
        r.devices(listOf(ear, spk))
        assertEquals(bt, r.devices(listOf(ear, spk, bt)))
        assertEquals("b", r.chosen)
        assertEquals(spk, r.devices(listOf(ear, spk)))
        assertEquals(null, r.chosen)
    }

    @Test fun theUsersPickHoldsUntilDevicesChange() {
        r.devices(listOf(ear, spk, wired))
        assertEquals(spk, r.choose("s"))
        assertEquals(spk, r.refresh())
        assertEquals(spk, r.devices(listOf(ear, spk, wired))) // the same devices again: nothing new connected
        assertEquals(bt, r.devices(listOf(ear, spk, wired, bt))) // a new Bluetooth device wins
        assertEquals(bt, r.choose("nope")) // unknown ids are ignored
    }

    @Test fun aTabletWithoutEarpieceUsesTheSpeaker() {
        assertEquals(spk, r.devices(listOf(spk)))
        assertEquals(null, AudioRouter { false }.devices(emptyList()))
    }
}
