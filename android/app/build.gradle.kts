import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Firebase Cloud Messaging is optional: only with a google-services.json from the owner's Firebase project (see README)
val hasFirebase = file("google-services.json").exists()
if (hasFirebase) apply(plugin = "com.google.gms.google-services")

// the release signing key lives outside the repo: -Pcillhub.signingDir=/path (or ~/.gradle/gradle.properties, or env
// CILLHUB_SIGNING_DIR) names a folder with cillcord-release.p12 and password.txt; without it assembleRelease stops (use assembleDebug)
val signingDir = providers.gradleProperty("cillhub.signingDir").orElse(providers.environmentVariable("CILLHUB_SIGNING_DIR")).orNull?.let { file(it) }
// the default hub: the one place its address lives (release builds always use it)
val prodUrl = "https://cillhub.cillerian.org"
// debug builds only: -Pcillhub.url=http://10.0.2.2:3350 points the app at a test instance
val debugUrl = providers.gradleProperty("cillhub.url").getOrElse(prodUrl)

android {
    namespace = "io.github.mrciller.cillhub"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.mrciller.cillhub"
        minSdk = 26
        targetSdk = 36
        versionCode = 16
        versionName = "3.7.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "HAS_FIREBASE", hasFirebase.toString())
    }

    signingConfigs {
        create("release") {
            val pw = signingDir?.resolve("password.txt")
            if (pw != null && pw.exists()) {
                storeFile = pw.resolveSibling("cillcord-release.p12")
                storePassword = pw.readText().trim()
                keyAlias = "cillcord"
                keyPassword = pw.readText().trim()
            }
        }
    }

    buildTypes {
        getByName("debug") {
            buildConfigField("String", "APP_URL", "\"$debugUrl\"")
            applicationIdSuffix = ".debug"
            resValue("string", "app_name", "Cillhub Debug")
        }
        getByName("release") {
            buildConfigField("String", "APP_URL", "\"$prodUrl\"")
            resValue("string", "app_name", "Cillhub")
            signingConfig = signingConfigs.getByName("release")
            // R8: the emulator tests run against the same minified code through the "minified" build type below
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        // the release build (R8, release key when available) pointed at a test server, for the instrumented tests:
        // ./gradlew connectedMinifiedAndroidTest -Pcillhub.testBuildType=minified -Pcillhub.url=http://10.0.2.2:3360
        create("minified") {
            initWith(getByName("release"))
            matchingFallbacks += listOf("release")
            applicationIdSuffix = ".minified"
            buildConfigField("String", "APP_URL", "\"$debugUrl\"")
            resValue("string", "app_name", "Cillhub Minified")
            // the members only the tests call survive R8 here; nothing else differs from release
            proguardFiles("proguard-test.pro")
            testProguardFiles("proguard-androidtest.pro")
            if (signingConfigs.getByName("release").storeFile == null) signingConfig = signingConfigs.getByName("debug")
        }
    }
    testBuildType = providers.gradleProperty("cillhub.testBuildType").getOrElse("debug")
    // the minified test build talks to local test servers over http, as debug builds may
    sourceSets.getByName("minified").res.srcDir("src/debug/res")

    // one APK per processor family keeps the download small (libwebrtc is about 12 MB per ABI); the universal APK stays
    // for anyone who downloads by hand and for 3.0.0-alpha apps that read only the feed's url. The updater picks the one
    // for Build.SUPPORTED_ABIS (UpdateInfo). An app bundle (Play) splits by itself.
    // native libraries compressed in the APK: about 8 MB less to download per update; Android unpacks them at install
    packaging.jniLibs.useLegacyPackaging = true

    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
            isUniversalApk = true
        }
    }

    buildFeatures { buildConfig = true; resValues = true; compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material3:material3-window-size-class")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.navigation:navigation-compose:2.10.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("io.coil-kt.coil3:coil-compose:3.6.3")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.6.3")
    implementation("io.coil-kt.coil3:coil-gif:3.6.3") // animated GIFs (picker, favourites, chat, animated emoji)
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.fragment:fragment:1.9.1") // the car app library pulls an old one; activity results need >= 1.3
    implementation("androidx.core:core-telecom:1.0.1")
    implementation("androidx.car.app:app:1.7.0")
    // voice and video: LiveKit's SDK, and its build of libwebrtc (package livekit.org.webrtc) for cillvoice too
    implementation("io.livekit:livekit-android:2.30.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("com.google.firebase:firebase-messaging:26.0.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")

    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.4.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.7.0")
    // its Robolectric dependency would make androidx.test drive the main looper the Robolectric way on the device
    androidTestImplementation("androidx.car.app:app-testing:1.7.0") { exclude(group = "org.robolectric") }
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    "minifiedImplementation"("androidx.compose.ui:ui-test-manifest")
}
