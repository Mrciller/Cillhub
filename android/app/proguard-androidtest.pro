# The test APK of the "minified" build: only remapped onto the app's obfuscated names, not shrunk itself.
# Robolectric (pulled in by the Car App Library's testing artifact) references platform internals the device has.
-dontshrink
-dontoptimize
-dontwarn **
