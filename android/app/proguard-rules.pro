# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# ===========================================================================
# R8 keep rules (minifyEnabled = true since the 101 MB -> ~35 MB size pass).
# The RN and ML Kit AARs ship most of these as consumer rules already; they
# are repeated here so a dependency bump can't silently strip a JNI entry
# point and turn this into a runtime crash that only shows up in release.
# ===========================================================================

# --- React Native: anything reached from C++ is resolved by name ---
-keep,allowobfuscation @interface com.facebook.proguard.annotations.DoNotStrip
-keep,allowobfuscation @interface com.facebook.proguard.annotations.DoNotStripAny
-keep,allowobfuscation @interface com.facebook.common.internal.DoNotStrip

-keep @com.facebook.proguard.annotations.DoNotStrip class *
-keep @com.facebook.common.internal.DoNotStrip class *
-keepclassmembers class * {
    @com.facebook.proguard.annotations.DoNotStrip *;
    @com.facebook.common.internal.DoNotStrip *;
}

-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}

-keep class com.facebook.jni.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# --- Bridge surface: discovered reflectively at startup ---
-keepclassmembers class * { @com.facebook.react.bridge.ReactMethod <methods>; }
-keepclassmembers class * { @com.facebook.react.uimanager.annotations.ReactProp <methods>; }
-keepclassmembers class * { @com.facebook.react.uimanager.annotations.ReactPropGroup <methods>; }
-keep class * implements com.facebook.react.bridge.ReactPackage { *; }
-keep class * implements com.facebook.react.bridge.NativeModule { *; }
-keep class * extends com.facebook.react.uimanager.ViewManager { *; }

# --- react-native-camera-kit -> ML Kit barcode scanning ---
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }
-dontwarn com.google.mlkit.**

# --- react-native-video -> AndroidX Media3 / ExoPlayer ---
-dontwarn androidx.media3.**

# --- RN networking (OkHttp/Okio) pulls in compile-only annotations ---
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
