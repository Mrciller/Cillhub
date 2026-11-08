package io.github.mrciller.cillhub.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** REST shapes from the contracts decode, unknown fields are ignored, and API errors read like the web client's. */
class ModelsTest {
    @Test fun messageWithReplyAttachmentsEmbedsReactions() {
        val m = json.decodeFromString(Message.serializer(), """{
          "id":"9","type":19,"channel_id":"3","guild_id":"2","author":{"id":"1","username":"ciller","global_name":null,"avatar":null,"discriminator":"0","bot":false},
          "content":"hi <@1>","timestamp":"2026-11-03T12:00:00.000Z","edited_timestamp":"2026-11-03T12:01:00.000Z","tts":false,
          "mentions":[{"id":"1","username":"ciller"}],"mention_roles":["5"],"mention_everyone":false,
          "attachments":[{"id":"7","filename":"a.png","size":123,"content_type":"image/png","url":"/attachments/3/7/a.png","width":640,"height":480}],
          "embeds":[{"type":"link","title":"T","url":"https://e.org","thumbnail":{"url":"https://e.org/i.png","proxy_url":"/external/abc"},"fields":[{"name":"n","value":"v","inline":true}]}],
          "reactions":[{"emoji":{"id":null,"name":"👍"},"count":2,"me":true}],"pinned":false,"nonce":"n1",
          "message_reference":{"message_id":"8","channel_id":"3"},"referenced_message":{"id":"8","channel_id":"3","author":{"id":"2","username":"bob"},"content":"q"},
          "some_future_field":{"x":1}
        }""")
        assertEquals(19, m.type)
        assertEquals("ciller", m.author.displayName)
        assertTrue(m.attachments.single().isImage)
        assertEquals("/external/abc", m.embeds.single().thumbnail!!.proxyUrl)
        assertEquals("👍", m.reactions.single().emoji.key)
        assertEquals("8", m.referencedMessage!!.id)
        assertEquals("n1", m.nonce)
    }

    @Test fun nullsAndMissingFieldsFallBack() {
        val c = json.decodeFromString(Channel.serializer(), """{"id":"1","type":0,"name":null,"position":null,"last_message_id":null}""")
        assertNull(c.name)
        assertEquals(0, c.position)
        val u = json.decodeFromString(User.serializer(), """{"id":"5","username":"x","global_name":""}""")
        assertEquals("x", u.displayName)
    }

    @Test fun loginAnswers() {
        val mfa = json.decodeFromString(LoginAnswer.serializer(), """{"user_id":"1","mfa":true,"ticket":"t","totp":true,"backup":true,"sms":false,"webauthn":null}""")
        assertTrue(mfa.mfa); assertNull(mfa.token)
        val renew = json.decodeFromString(LoginAnswer.serializer(), """{"token":"x","user_id":"1","user_settings":{"locale":"de"},"required_actions":["update_password"]}""")
        assertEquals(listOf("update_password"), renew.requiredActions)
    }

    @Test fun apiErrorsShowTheFieldReasonAndRetryAfter() {
        val e = ApiError.parse(400, """{"code":50035,"message":"Invalid Form Body","errors":{"username":{"_errors":[{"code":"USERNAME_ALREADY_TAKEN","message":"Username is unavailable."}]}}}""", null)
        assertEquals("Username is unavailable.", e.message)
        val r = ApiError.parse(429, """{"message":"You are being rate limited.","retry_after":1.5,"global":false}""", null)
        assertEquals(1.5, r.retryAfter, 0.0)
        assertEquals(2.0, ApiError.parse(429, "not json", "2").retryAfter, 0.0)
    }

    @Test fun instanceInfo() {
        val i = json.decodeFromString(InstanceInfo.serializer(), """{"name":"N","motd":null,"registration_mode":"invite","gifs_enabled":true,"max_upload_bytes":1048576,"setup_pending":false,"voice":{}}""")
        assertEquals("invite", i.registrationMode)
        assertEquals(1048576L, i.maxUploadBytes)
    }
}
