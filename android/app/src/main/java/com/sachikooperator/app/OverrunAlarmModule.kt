package com.sachikooperator.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

// JS side of the machine-overrun alarm (src/services/overrunAlarm.js).
//   schedule  -- have Android wake the device and sound the alarm at a time, even
//                with the app closed (one pending alarm per job, replaced on
//                every call with the same key);
//   cancel / cancelAll -- drop those alarms (a Deckle was stopped, or paused);
//   ring      -- sound it now (the app noticed the overrun itself); `dueAt` is the
//                moment it was due, so an alarm already silenced isn't restarted;
//   silence   -- stop a sounding alarm.
class OverrunAlarmModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "OverrunAlarm"

  private val ctx: Context get() = reactApplicationContext
  private val alarms: AlarmManager get() = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
  private val prefs get() = ctx.getSharedPreferences("overrun_alarm", Context.MODE_PRIVATE)

  // The same Intent (action + data uri + request code) must be rebuilt to cancel
  // an alarm as was used to set it.
  private fun pending(key: String, title: String = "", text: String = "", dueAt: Long = 0L): PendingIntent {
    val intent = Intent(ctx, OverrunAlarmReceiver::class.java).apply {
      action = "com.sachikooperator.app.OVERRUN_ALARM"
      data = Uri.parse("sachiko-overrun://" + Uri.encode(key))
      putExtra(OverrunAlarmNotifier.EXTRA_KEY, key)
      putExtra(OverrunAlarmNotifier.EXTRA_TITLE, title)
      putExtra(OverrunAlarmNotifier.EXTRA_TEXT, text)
      putExtra(OverrunAlarmNotifier.EXTRA_DUE, dueAt)
    }
    return PendingIntent.getBroadcast(
      ctx, OverrunAlarmNotifier.idFor(key), intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun remember(key: String, add: Boolean) {
    val set = HashSet(prefs.getStringSet("keys", emptySet()) ?: emptySet())
    if (add) set.add(key) else set.remove(key)
    prefs.edit().putStringSet("keys", set).apply()
  }

  @ReactMethod
  fun schedule(key: String, atMs: Double, title: String, text: String, promise: Promise) {
    try {
      val at = atMs.toLong()
      val pi = pending(key, title, text, at)
      val exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()
      if (exact) {
        alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
      } else {
        // Exact alarms not granted (Android 14+ denies them by default): still
        // fires, just possibly a few minutes late rather than on the dot.
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
      }
      remember(key, true)
      promise.resolve(exact)
    } catch (e: Exception) {
      promise.reject("E_SCHEDULE", e.message, e)
    }
  }

  @ReactMethod
  fun cancel(key: String, promise: Promise) {
    try {
      alarms.cancel(pending(key))
      remember(key, false)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_CANCEL", e.message, e)
    }
  }

  @ReactMethod
  fun cancelAll(promise: Promise) {
    try {
      (prefs.getStringSet("keys", emptySet()) ?: emptySet()).forEach { alarms.cancel(pending(it)) }
      prefs.edit().remove("keys").apply()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_CANCEL", e.message, e)
    }
  }

  @ReactMethod
  fun ring(key: String, title: String, text: String, dueAt: Double, promise: Promise) {
    OverrunAlarmNotifier.post(ctx, key, title, text, dueAt.toLong())
    promise.resolve(null)
  }

  @ReactMethod
  fun silence(key: String, promise: Promise) {
    OverrunAlarmNotifier.cancel(ctx, key)
    promise.resolve(null)
  }

  @ReactMethod
  fun notificationsAllowed(promise: Promise) {
    promise.resolve(NotificationManagerCompat.from(ctx).areNotificationsEnabled())
  }
}
