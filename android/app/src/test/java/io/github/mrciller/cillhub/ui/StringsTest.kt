package io.github.mrciller.cillhub.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.util.regex.Pattern

class StringsTest {
    @Test
    fun englishAndGermanStringResourcesHaveIdenticalKeys() {
        val root = File("src/main/res")
        val enFile = File(root, "values/strings.xml")
        val deFile = File(root, "values-de/strings.xml")

        val enContent = enFile.readText()
        val deContent = deFile.readText()

        val stringKeyPattern = Pattern.compile("<string\\s+name=\"([^\"]+)\"")
        val pluralKeyPattern = Pattern.compile("<plurals\\s+name=\"([^\"]+)\"")

        fun extractKeys(content: String): Pair<Set<String>, Set<String>> {
            val strings = mutableSetOf<String>()
            val plurals = mutableSetOf<String>()

            val sm = stringKeyPattern.matcher(content)
            while (sm.find()) {
                strings.add(sm.group(1))
            }

            val pm = pluralKeyPattern.matcher(content)
            while (pm.find()) {
                plurals.add(pm.group(1))
            }

            return strings to plurals
        }

        val (enStrings, enPlurals) = extractKeys(enContent)
        val (deStrings, dePlurals) = extractKeys(deContent)

        val missingInDe = enStrings - deStrings
        val extraInDe = deStrings - enStrings

        assertEquals("Missing string keys in values-de/strings.xml: $missingInDe", emptySet<String>(), missingInDe)
        assertEquals("Extra string keys in values-de/strings.xml: $extraInDe", emptySet<String>(), extraInDe)

        val missingPluralsInDe = enPlurals - dePlurals
        val extraPluralsInDe = dePlurals - enPlurals

        assertEquals("Missing plural keys in values-de/strings.xml: $missingPluralsInDe", emptySet<String>(), missingPluralsInDe)
        assertEquals("Extra plural keys in values-de/strings.xml: $extraPluralsInDe", emptySet<String>(), extraPluralsInDe)
    }
}
