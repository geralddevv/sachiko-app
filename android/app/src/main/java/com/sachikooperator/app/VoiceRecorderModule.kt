package com.sachikooperator.app

import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File

// Records a short voice message for a maintenance ticket: mono AAC in an .m4a
// (MPEG-4) container, which the server accepts as-is and plays back everywhere.
//
// The length cap is enforced here, by MediaRecorder itself (setMaxDuration), not
// by a JS timer -- a timer on the JS thread can drift or be paused with the app,
// the recorder cannot overrun. When the cap is hit the recorder stops by itself
// and a "VoiceRecorderAutoStopped" event is sent so the UI can finish up; the
// file is kept and stop() then just returns it.
class VoiceRecorderModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "VoiceRecorder"

  private var recorder: MediaRecorder? = null
  private var outFile: File? = null
  private var startedAt = 0L
  private var finishedDurationMs = -1L // set once the recorder has stopped itself

  private fun newRecorder(): MediaRecorder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(reactApplicationContext)
    else @Suppress("DEPRECATION") MediaRecorder()

  private fun release() {
    try { recorder?.release() } catch (_: Exception) {}
    recorder = null
  }

  private fun discardFile() {
    try { outFile?.delete() } catch (_: Exception) {}
    outFile = null
  }

  @ReactMethod
  fun start(maxDurationMs: Double, promise: Promise) {
    try {
      // A recording left over from an earlier screen must not leak the mic.
      release()
      discardFile()

      val file = File(reactApplicationContext.cacheDir, "voice_${System.currentTimeMillis()}.m4a")
      val r = newRecorder()
      r.setAudioSource(MediaRecorder.AudioSource.MIC)
      r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      r.setAudioChannels(1)
      r.setAudioSamplingRate(44100)
      r.setAudioEncodingBitRate(64000)
      r.setMaxDuration(maxDurationMs.toInt())
      r.setOutputFile(file.absolutePath)
      r.setOnInfoListener { _, what, _ ->
        if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) {
          finishedDurationMs = SystemClock.elapsedRealtime() - startedAt
          try { r.stop() } catch (_: Exception) {}
          reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("VoiceRecorderAutoStopped", null)
        }
      }
      r.prepare()
      r.start()

      recorder = r
      outFile = file
      startedAt = SystemClock.elapsedRealtime()
      finishedDurationMs = -1L
      promise.resolve(null)
    } catch (e: Exception) {
      release()
      discardFile()
      promise.reject("E_RECORD_START", e.message ?: "Could not start recording", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    val r = recorder
    val file = outFile
    if (r == null || file == null) {
      promise.reject("E_NOT_RECORDING", "No recording in progress")
      return
    }
    try {
      val autoStopped = finishedDurationMs >= 0
      val durationMs = if (autoStopped) finishedDurationMs else SystemClock.elapsedRealtime() - startedAt
      if (!autoStopped) {
        r.stop() // throws if nothing was captured yet (stopped almost instantly)
      }
      release()
      recorder = null

      val map = Arguments.createMap()
      map.putString("uri", "file://" + file.absolutePath)
      map.putString("name", file.name)
      map.putString("type", "audio/mp4")
      map.putDouble("durationMs", durationMs.toDouble())
      map.putDouble("size", file.length().toDouble())
      promise.resolve(map)
    } catch (e: Exception) {
      release()
      discardFile()
      promise.reject("E_RECORD_STOP", "Recording was too short", e)
    }
  }

  // Abandon the current recording (leaving the screen, tapping delete).
  @ReactMethod
  fun cancel(promise: Promise) {
    try {
      try { recorder?.stop() } catch (_: Exception) {}
      release()
      discardFile()
      finishedDurationMs = -1L
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_RECORD_CANCEL", e.message, e)
    }
  }

  // Required by NativeEventEmitter on newer RN; harmless otherwise.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}
}
