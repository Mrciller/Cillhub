# Only for the "minified" build type the instrumented tests run against: members only the tests call (Voice.stats,
# test helpers in Session, ...) are kept from removal. Names are still obfuscated (the test APK gets the app's mapping),
# so R8's renaming and the library rules are exercised as in release. Release builds do not use this file.
-keepclassmembers,allowobfuscation class io.github.mrciller.cillhub.** { *; }
# Libraries the test APK shares with the app (Gradle leaves them out of the test APK, so what R8 removes from the app
# is missing for the tests): kept whole here. The app's own code, Coil, LiveKit, libwebrtc, protobuf, JNA and
# the SDP parser still go through R8 exactly as in release; OkHttp is shared with the tests too.
-keep class kotlin.** { *; }
-keep class kotlinx.** { *; }
-keep class androidx.** { *; }
-keep class okhttp3.** { *; }
-keep class okio.** { *; }
