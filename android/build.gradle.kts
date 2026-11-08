buildscript {
    // AGP 9.5's built-in Kotlin is 2.2.10; the libraries (kotlinx-serialization 1.12, Compose 1.12) need a 2.4 compiler
    dependencies { classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.10") }
}

plugins {
    id("com.android.application") version "9.5.0" apply false
    id("com.google.gms.google-services") version "4.5.0" apply false
    // both compiler plugins must match the Kotlin version above
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.10" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.10" apply false
}
