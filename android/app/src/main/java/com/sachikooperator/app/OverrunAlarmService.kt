package com.sachikooperator.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import androidx.core.app.NotificationCompat

// The factory-floor alarm. A foreground service so it keeps sounding after the
// AlarmManager broadcast that started it has returned, with the app closed and the
// screen off. While at least one alarm is active it:
//   - loops the device's alarm sound on the ALARM stream (so silent / media-volume
//     settings don't mute it), with the alarm volume forced to maximum;
//   - vibrates in a repeating pattern;
//   - shows an ongoing notification whose full-screen intent wakes the screen and
//     opens the app over the lock screen.
// It runs until somebody silences it (the modal's button, the notification's
// Silence button, opening the app from the notification, or answering the alert),
// or MAX_RING_MS passes, so a tablet nobody is near doesn't blare for ever.
class OverrunAlarmService : Service() {
  private class Alarm(val title: String, val text: String, val dueAt: Long)

  private val active = LinkedHashMap<String, Alarm>()
  private val handler = Handler(Looper.getMainLooper())
  private val expire = Runnable { onExpired() }
  private var player: MediaPlayer? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var savedVolume = -1

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val key = intent?.getStringExtra(OverrunAlarmNotifier.EXTRA_KEY)
    if (key != null) {
      active[key] = Alarm(
        intent.getStringExtra(OverrunAlarmNotifier.EXTRA_TITLE) ?: "Machine running over time",
        intent.getStringExtra(OverrunAlarmNotifier.EXTRA_TEXT) ?: "A Deckle has run past its expected time.",
        intent.getLongExtra(OverrunAlarmNotifier.EXTRA_DUE, 0L),
      )
    }
    // Started with startForegroundService(): this MUST be reached promptly, whatever
    // the intent held, or Android kills the app.
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(FG_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(FG_ID, notification)
    }
    if (active.isEmpty()) {
      stopSelf()
      return START_NOT_STICKY
    }
    startSound()
    if (key != null) launchApp()
    handler.removeCallbacks(expire)
    handler.postDelayed(expire, MAX_RING_MS)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(expire)
    stopSound()
    if (instance === this) instance = null
    super.onDestroy()
  }

  // Put the app itself on screen, so the operator sees the alarm card rather than
  // just a notification. A full-screen intent only does this on a locked screen
  // (an unlocked one gets a heads-up banner), so the service also asks directly.
  // Android allows it while the "display over other apps" permission is granted,
  // and may refuse it otherwise -- in which case the full-screen intent and the
  // notification are still there. Never silences: only a person does that.
  private fun launchApp() {
    try {
      startActivity(
        Intent(this, MainActivity::class.java).apply {
          flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
          putExtra(OverrunAlarmNotifier.EXTRA_FROM_ALARM, true)
          putExtra(OverrunAlarmNotifier.EXTRA_SILENCE, false)
        },
      )
    } catch (e: Exception) {
      Log.w(TAG, "could not open the app", e)
    }
  }

  // ── Called (same process) by OverrunAlarmNotifier ───────────────────────
  // Posted to the main thread: `active` is only ever touched there, and these are
  // called from React's native-module thread as well.
  fun silence(key: String) {
    handler.post {
      val alarm = active.remove(key) ?: return@post
      OverrunAlarmNotifier.markSilenced(this, key, alarm.dueAt)
      afterChange()
    }
  }

  fun silenceAll() {
    handler.post {
      active.forEach { (key, alarm) -> OverrunAlarmNotifier.markSilenced(this, key, alarm.dueAt) }
      active.clear()
      afterChange()
    }
  }

  private fun afterChange() {
    if (active.isEmpty()) {
      stopSelf()
    } else {
      (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(FG_ID, buildNotification())
    }
  }

  // Nobody answered for MAX_RING_MS: stop the noise but leave each alert in the
  // shade as a plain, silent notification so it is still there to be seen.
  private fun onExpired() {
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    val open = openIntent(1, silence = false)
    active.forEach { (key, alarm) ->
      val n = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_alarm)
        .setContentTitle(alarm.title)
        .setContentText(alarm.text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(alarm.text))
        .setCategory(NotificationCompat.CATEGORY_ALARM)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setAutoCancel(true)
        .setContentIntent(open)
        .build()
      try {
        nm.notify(OverrunAlarmNotifier.idFor(key), n)
      } catch (_: SecurityException) {
      }
      OverrunAlarmNotifier.markSilenced(this, key, alarm.dueAt)
    }
    active.clear()
    stopSelf()
  }

  // ── Notification ────────────────────────────────────────────────────────
  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    // No sound / vibration of its own -- this service plays them, so they loop and
    // can be stopped; a channel sound would play once and could not be silenced.
    val channel = NotificationChannel(CHANNEL_ID, "Machine alarm", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "Sounds when a Deckle runs over time or a break is over"
      setSound(null, null)
      enableVibration(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      setBypassDnd(true)
    }
    nm.createNotificationChannel(channel)
  }

  private fun openIntent(requestOffset: Int, silence: Boolean): PendingIntent {
    val intent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      putExtra(OverrunAlarmNotifier.EXTRA_FROM_ALARM, true)
      // Only a person tapping the notification silences it; the full-screen launch
      // that wakes the screen must NOT, or the alarm would stop before anyone
      // has seen it.
      putExtra(OverrunAlarmNotifier.EXTRA_SILENCE, silence)
    }
    return PendingIntent.getActivity(
      this, FG_ID + requestOffset, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun buildNotification(): Notification {
    ensureChannel()
    val latest = active.values.lastOrNull()
    val extra = if (active.size > 1) " (+${active.size - 1} more)" else ""
    val title = (latest?.title ?: "Machine alarm") + extra
    val text = latest?.text ?: ""
    val silenceIntent = PendingIntent.getBroadcast(
      this,
      FG_ID + 3,
      Intent(this, OverrunSilenceReceiver::class.java).apply { action = OverrunAlarmNotifier.ACTION_SILENCE },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_alarm)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setColor(Color.parseColor("#DC2626"))
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(openIntent(1, silence = true))
      .setFullScreenIntent(openIntent(2, silence = false), true)
      .addAction(0, "Silence", silenceIntent)
      .build()
  }

  // ── Sound + vibration ───────────────────────────────────────────────────
  private fun startSound() {
    if (player != null) return
    try {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sachikooperator:overrun_alarm").apply {
        acquire(MAX_RING_MS + 15_000L)
      }
    } catch (e: Exception) {
      Log.w(TAG, "wake lock failed", e)
    }

    try {
      val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
      savedVolume = audio.getStreamVolume(AudioManager.STREAM_ALARM)
      audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
    } catch (e: Exception) {
      savedVolume = -1
      Log.w(TAG, "could not raise alarm volume", e)
    }

    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    try {
      val uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM)
        ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
      player = MediaPlayer().apply {
        setAudioAttributes(attrs)
        setDataSource(this@OverrunAlarmService, uri)
        isLooping = true
        prepare()
        start()
      }
    } catch (e: Exception) {
      Log.w(TAG, "alarm sound failed", e)
      player?.release()
      player = null
    }

    try {
      val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
      if (vibrator.hasVibrator()) {
        val effect = VibrationEffect.createWaveform(longArrayOf(0, 900, 400, 900, 400, 1400, 700), 0)
        @Suppress("DEPRECATION")
        vibrator.vibrate(effect, attrs)
      }
    } catch (e: Exception) {
      Log.w(TAG, "vibration failed", e)
    }
  }

  private fun stopSound() {
    try {
      player?.let {
        if (it.isPlaying) it.stop()
        it.release()
      }
    } catch (_: Exception) {
    }
    player = null
    try {
      (getSystemService(Context.VIBRATOR_SERVICE) as Vibrator).cancel()
    } catch (_: Exception) {
    }
    try {
      if (savedVolume >= 0) {
        (getSystemService(Context.AUDIO_SERVICE) as AudioManager)
          .setStreamVolume(AudioManager.STREAM_ALARM, savedVolume, 0)
      }
    } catch (_: Exception) {
    }
    savedVolume = -1
    try {
      wakeLock?.let { if (it.isHeld) it.release() }
    } catch (_: Exception) {
    }
    wakeLock = null
  }

  companion object {
    private const val TAG = "OverrunAlarm"
    private const val CHANNEL_ID = "machine_alarm_v2"
    private const val FG_ID = 0x0A1A
    private const val MAX_RING_MS = 10 * 60 * 1000L

    // The running instance, if any -- everything that silences an alarm lives in
    // this same process, and a stop must never itself START a service.
    @Volatile
    var instance: OverrunAlarmService? = null
      private set
  }
}
