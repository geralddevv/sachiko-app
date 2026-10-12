package com.sachikooperator.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

// Entry point for the machine alarm ("a Deckle ran over its time" / "break is over").
// Both come through here, from AlarmManager (OverrunAlarmReceiver -- app closed or
// screen off) and from the app itself (OverrunAlarmModule.ring) -- and both end up
// in OverrunAlarmService, which does the loud part. An alarm the operator has
// already silenced is remembered (key + due time) so the app opening, or the
// second of the two paths arriving late, never starts it up again.
object OverrunAlarmNotifier {
  // Only used if Android refuses to let the service start (a background-start
  // restriction): a high-importance channel with the alarm sound, insistent.
  private const val FALLBACK_CHANNEL_ID = "machine_alarm_fallback_v1"
  // Channels earlier builds created; removed so they don't linger in the settings.
  private val OLD_CHANNELS = listOf("machine_overrun_alarm_v1", "overtime_reminder_v1", "break_over_alarm_v1")
  const val ACTION_SILENCE = "com.sachikooperator.app.OVERRUN_SILENCE"
  const val EXTRA_KEY = "key"
  const val EXTRA_TITLE = "title"
  const val EXTRA_TEXT = "text"
  const val EXTRA_DUE = "due"
  // Set on the intents that open the app from the alarm; MainActivity then shows
  // over the lock screen, and for EXTRA_SILENCE also stops the sound.
  const val EXTRA_FROM_ALARM = "from_alarm"
  const val EXTRA_SILENCE = "silence_alarm"

  private const val PREFS = "overrun_alarm_state"
  private const val SILENCED = "silenced"
  private const val KEEP_MS = 24 * 60 * 60 * 1000L

  fun idFor(key: String): Int = key.hashCode()

  private fun entry(key: String, dueAt: Long) = "$key@$dueAt"

  fun markSilenced(context: Context, key: String, dueAt: Long) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    // Entries are "key@due|stampedAt"; anything older than a day is dropped.
    val kept = (prefs.getStringSet(SILENCED, emptySet()) ?: emptySet()).filter {
      val at = it.substringAfterLast('|', "0").toLongOrNull() ?: 0L
      now - at < KEEP_MS && !it.startsWith(entry(key, dueAt) + "|")
    }.toMutableSet()
    kept.add(entry(key, dueAt) + "|" + now)
    prefs.edit().putStringSet(SILENCED, kept).apply()
  }

  private fun isSilenced(context: Context, key: String, dueAt: Long): Boolean {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val prefix = entry(key, dueAt) + "|"
    return (prefs.getStringSet(SILENCED, emptySet()) ?: emptySet()).any { it.startsWith(prefix) }
  }

  fun post(context: Context, key: String, title: String, text: String, dueAt: Long) {
    if (isSilenced(context, key, dueAt)) return
    val intent = Intent(context, OverrunAlarmService::class.java).apply {
      putExtra(EXTRA_KEY, key)
      putExtra(EXTRA_TITLE, title)
      putExtra(EXTRA_TEXT, text)
      putExtra(EXTRA_DUE, dueAt)
    }
    try {
      ContextCompat.startForegroundService(context, intent)
    } catch (e: Exception) {
      postFallback(context, key, title, text)
    }
  }

  fun cancel(context: Context, key: String) {
    OverrunAlarmService.instance?.silence(key)
    (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(idFor(key))
  }

  fun silenceAll(context: Context) {
    OverrunAlarmService.instance?.silenceAll()
  }

  private fun postFallback(context: Context, key: String, title: String, text: String) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      OLD_CHANNELS.forEach { nm.deleteNotificationChannel(it) }
      if (nm.getNotificationChannel(FALLBACK_CHANNEL_ID) == null) {
        val channel = NotificationChannel(FALLBACK_CHANNEL_ID, "Machine alarm (backup)", NotificationManager.IMPORTANCE_HIGH).apply {
          setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_ALARM)
              .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
              .build(),
          )
          enableVibration(true)
          vibrationPattern = longArrayOf(0, 900, 400, 900, 400, 1400)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
          setBypassDnd(true)
        }
        nm.createNotificationChannel(channel)
      }
    }
    val open = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      putExtra(EXTRA_FROM_ALARM, true)
    }
    val pending = PendingIntent.getActivity(
      context, idFor(key), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(context, FALLBACK_CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_alarm)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setAutoCancel(true)
      .setContentIntent(pending)
      .setFullScreenIntent(pending, true)
      .build()
    // Keep repeating the sound until it is opened or cleared, like an alarm clock.
    notification.flags = notification.flags or Notification.FLAG_INSISTENT
    try {
      nm.notify(idFor(key), notification)
    } catch (_: SecurityException) {
      // Notifications not allowed -- the in-app alarm card still shows.
    }
  }
}
