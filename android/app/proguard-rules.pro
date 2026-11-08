# R8 rules of the app itself. The libraries bring their own (consumer rules): kotlinx.serialization, OkHttp, Coil,
# the LiveKit SDK (which also covers libwebrtc's JNI, the SDP parser, protobuf and JNA), the Car App Library, Firebase.

# Navigation's type-safe routes and the API models are @Serializable: their generated serializers are looked up
# through the companion; keep them for every class of the app.
-keepclassmembers @kotlinx.serialization.Serializable class io.github.mrciller.cillhub.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class io.github.mrciller.cillhub.**$$serializer { *; }

# Stack traces in bug reports stay readable with the mapping file; keep the line numbers.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Optional at runtime, referenced by OkHttp/LiveKit's dependencies only on other platforms.
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn javax.naming.**

# The shell compares the current destination's route with ServersRoute::class.qualifiedName (App.kt); Navigation
# names routes by their serial name, which is the original class name, so the route classes keep their names.
-keepnames class io.github.mrciller.cillhub.ui.*Route
