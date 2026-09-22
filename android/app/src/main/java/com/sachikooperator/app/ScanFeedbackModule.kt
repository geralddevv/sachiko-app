package com.sachikooperator.app

import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

// A scan's outcome needs an audible cue on the shop floor -- an operator
// watching the reel in their hands, not the screen. ToneGenerator's built-in
// ACK/NACK tones give two clearly distinct sounds with no bundled audio asset
// and no extra native dependency to keep in sync with the New Architecture.
class ScanFeedbackModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "ScanFeedback"

  private fun play(toneType: Int) {
    val generator = ToneGenerator(AudioManager.STREAM_NOTIFICATION, ToneGenerator.MAX_VOLUME)
    generator.startTone(toneType)
    // ACK/NACK are short, fixed-duration tones (well under 300ms); released
    // once they've had time to finish rather than held open indefinitely.
    Handler(Looper.getMainLooper()).postDelayed({ generator.release() }, 300)
  }

  @ReactMethod
  fun playSuccess() {
    play(ToneGenerator.TONE_PROP_ACK)
  }

  @ReactMethod
  fun playError() {
    play(ToneGenerator.TONE_PROP_NACK)
  }
}
