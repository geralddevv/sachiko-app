package com.sachikooperator.app

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.nio.ByteBuffer

// Gallery uploads aren't capped the way in-app recording is (launchCamera's
// durationLimit only bounds the system camera, not the picker), so a clip
// longer than the maintenance video limit needs to be cut down after the
// fact. This does a stream copy with MediaExtractor/MediaMuxer -- no decode
// or re-encode -- keeping only the first `maxDurationMs` of each track. That
// only works because we always keep the *start* of the file, which is
// already a sync point; trimming the tail end this way would need to seek
// back to the nearest preceding keyframe instead.
class VideoTrimModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "VideoTrim"

  @ReactMethod
  fun trimToMaxDuration(uri: String, maxDurationMs: Double, promise: Promise) {
    val extractor = MediaExtractor()
    var muxer: MediaMuxer? = null
    try {
      extractor.setDataSource(reactApplicationContext, Uri.parse(uri), null)

      val maxDurationUs = (maxDurationMs * 1000).toLong()
      val trackCount = extractor.trackCount
      val muxerTrackIndexOf = HashMap<Int, Int>() // extractor track -> muxer track
      val doneTracks = HashSet<Int>()

      val outFile = File(
        reactApplicationContext.cacheDir,
        "maintenance_trim_${System.currentTimeMillis()}.mp4",
      )
      muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

      var longestTrackDurationUs = 0L
      var maxInputSize = 1_000_000
      for (i in 0 until trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
        if (mime.startsWith("video/") || mime.startsWith("audio/")) {
          muxerTrackIndexOf[i] = muxer.addTrack(format)
          if (format.containsKey(MediaFormat.KEY_DURATION)) {
            longestTrackDurationUs = maxOf(longestTrackDurationUs, format.getLong(MediaFormat.KEY_DURATION))
          }
          if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
            maxInputSize = maxOf(maxInputSize, format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
          }
        }
      }

      if (muxerTrackIndexOf.isEmpty()) {
        throw IllegalStateException("No video/audio tracks found")
      }

      // Already short enough -- hand the original file back rather than
      // writing out an identical copy.
      if (longestTrackDurationUs in 1..maxDurationUs) {
        muxer.release()
        outFile.delete()
        promise.resolve(uri)
        return
      }

      for (extractorTrack in muxerTrackIndexOf.keys) {
        extractor.selectTrack(extractorTrack)
      }

      val buffer = ByteBuffer.allocate(maxInputSize)
      val bufferInfo = android.media.MediaCodec.BufferInfo()
      muxer.start()

      while (doneTracks.size < muxerTrackIndexOf.size) {
        val extractorTrack = extractor.sampleTrackIndex
        if (extractorTrack < 0) {
          break
        }
        val muxerTrack = muxerTrackIndexOf[extractorTrack]
        if (muxerTrack == null || extractorTrack in doneTracks) {
          extractor.advance()
          continue
        }

        val sampleTime = extractor.sampleTime
        if (sampleTime < 0 || sampleTime > maxDurationUs) {
          doneTracks.add(extractorTrack)
          extractor.unselectTrack(extractorTrack)
          continue
        }

        buffer.clear()
        val sampleSize = extractor.readSampleData(buffer, 0)
        if (sampleSize < 0) {
          doneTracks.add(extractorTrack)
          extractor.unselectTrack(extractorTrack)
          continue
        }

        bufferInfo.offset = 0
        bufferInfo.size = sampleSize
        bufferInfo.presentationTimeUs = sampleTime
        bufferInfo.flags = extractor.sampleFlags

        muxer.writeSampleData(muxerTrack, buffer, bufferInfo)
        extractor.advance()
      }

      muxer.stop()
      promise.resolve(Uri.fromFile(outFile).toString())
    } catch (err: Exception) {
      muxer?.let {
        try {
          it.stop()
        } catch (ignored: Exception) {
          // stop() throws if start() was never reached / nothing was written --
          // the reject below is what matters, not this cleanup attempt.
        }
      }
      promise.reject("trim_failed", err.message ?: "Could not trim video", err)
    } finally {
      muxer?.release()
      extractor.release()
    }
  }
}
