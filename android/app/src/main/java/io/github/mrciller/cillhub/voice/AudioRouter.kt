package io.github.mrciller.cillhub.voice

/**
 * Where call audio plays (pure state machine, unit-tested). Like a phone call: a headset or Bluetooth device that
 * connects takes over, the user's pick holds while that device exists, and without either a video call or voice channel
 * uses the speaker and an audio-only DM call the earpiece. The adapter (Telecom endpoints or AudioManager) applies it.
 */
class AudioRouter(private val preferSpeaker: () -> Boolean) {
    enum class Type { EARPIECE, SPEAKER, WIRED, BLUETOOTH }
    data class Device(val type: Type, val id: String, val name: String = "")

    var available: List<Device> = emptyList(); private set
    /** The user's pick, kept while that device is there. */
    var chosen: String? = null; private set
    var current: Device? = null; private set

    /** The devices changed (Telecom's endpoint list or AudioManager's callback). Returns the device to use. */
    fun devices(list: List<Device>): Device? {
        val old = available.map { it.id }.toSet()
        available = list
        val fresh = list.filter { it.id !in old && (it.type == Type.WIRED || it.type == Type.BLUETOOTH) }
        if (old.isNotEmpty() && fresh.isNotEmpty()) chosen = (fresh.firstOrNull { it.type == Type.BLUETOOTH } ?: fresh.first()).id
        if (chosen != null && list.none { it.id == chosen }) chosen = null
        return pick()
    }

    fun choose(id: String): Device? {
        if (available.any { it.id == id }) chosen = id
        return pick()
    }

    /** Video started or stopped: without a pick, a call with video moves to the speaker. */
    fun refresh(): Device? = pick()

    private fun pick(): Device? {
        val by = { t: Type -> available.firstOrNull { it.type == t } }
        current = available.firstOrNull { it.id == chosen }
            ?: by(Type.BLUETOOTH) ?: by(Type.WIRED)
            ?: (if (preferSpeaker()) by(Type.SPEAKER) else by(Type.EARPIECE))
            ?: by(Type.SPEAKER) ?: by(Type.EARPIECE)
        return current
    }

    /** The proximity sensor turns the screen off while the phone is held to the ear. */
    val earpiece get() = current?.type == Type.EARPIECE
}
