package com.sachikooperator.app

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import kotlin.math.PI
import kotlin.math.sin

// A scan's outcome needs an audible cue on the shop floor -- an operator
// watching the reel in their hands, not the screen. The tones are synthesised
// here (no bundled audio asset, no extra native dependency) to sound like a
// handheld barcode scanner: a short, crisp high-pitched beep for a good read,
// and a rapid triple of a lower pitch for a rejection. They differ in rhythm
// as well as pitch, so they stay distinguishable in a noisy hall.
class ScanFeedbackModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "ScanFeedback"

  private val sampleRate = 44100
  private val handler = Handler(Looper.getMainLooper())

  // One burst of sine at `freq` Hz, with a 6 ms fade in/out so it starts and
  // ends cleanly instead of clicking.
  private fun burst(freq: Double, ms: Int): ShortArray {
    val n = sampleRate * ms / 1000
    val fade = sampleRate * 6 / 1000
    return ShortArray(n) { i ->
      val env = when {
        i < fade -> i.toDouble() / fade
        i > n - fade -> (n - i).toDouble() / fade
        else -> 1.0
      }
      (sin(2.0 * PI * freq * i / sampleRate) * env * 0.9 * Short.MAX_VALUE).toInt().toShort()
    }
  }

  private fun silence(ms: Int) = ShortArray(sampleRate * ms / 1000)

  private val successPcm: ShortArray by lazy { burst(2800.0, 110) }
  private val errorPcm: ShortArray by lazy {
    val b = burst(1900.0, 75)
    val gap = silence(60)
    b + gap + b + gap + b
  }

  private fun play(pcm: ShortArray) {
    try {
      val track = AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(sampleRate)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        )
        .setBufferSizeInBytes(pcm.size * 2)
        .setTransferMode(AudioTrack.MODE_STATIC)
        .build()
      track.write(pcm, 0, pcm.size)
      track.play()
      val durationMs = pcm.size * 1000L / sampleRate
      handler.postDelayed({ track.release() }, durationMs + 150)
    } catch (_: Exception) {
      // Feedback is a nicety; never let it break a scan.
    }
  }

  @ReactMethod
  fun playSuccess() {
    play(successPcm)
  }

  @ReactMethod
  fun playError() {
    play(errorPcm)
  }
}
