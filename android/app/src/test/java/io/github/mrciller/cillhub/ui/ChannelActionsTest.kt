package io.github.mrciller.cillhub.ui

import io.github.mrciller.cillhub.data.Perm
import io.github.mrciller.cillhub.ui.ChannelAction.*
import org.junit.Assert.assertEquals
import org.junit.Test

/** The long-press sheet offers only what the viewer may do in the channel. */
class ChannelActionsTest {
    @Test fun readOnlyUserGetsNotificationsReadAndLink() =
        assertEquals(listOf(NOTIFY, MARK_READ, COPY_LINK), channelActions(Perm.VIEW_CHANNEL, category = false))

    @Test fun managerGetsEverything() =
        assertEquals(listOf(EDIT, ACCESS, NOTIFY, MARK_READ, COPY_LINK, CLONE, DELETE), channelActions(Perm.MANAGE_CHANNELS or Perm.MANAGE_ROLES, category = false))

    @Test fun categoryHasNoLinkOrClone() {
        assertEquals(listOf(EDIT, NOTIFY, MARK_READ, DELETE), channelActions(Perm.MANAGE_CHANNELS, category = true))
        assertEquals(listOf(ACCESS, NOTIFY, MARK_READ), channelActions(Perm.MANAGE_ROLES, category = true))
    }
}
