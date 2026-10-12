package com.sachikooperator.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Fired by AlarmManager at the moment a running Deckle goes overdue (see
// OverrunAlarmModule.schedule). Runs even when the app is closed.
class OverrunAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val key = intent.getStringExtra(OverrunAlarmNotifier.EXTRA_KEY) ?: return
    OverrunAlarmNotifier.post(
      context,
      key,
      intent.getStringExtra(OverrunAlarmNotifier.EXTRA_TITLE) ?: "Machine running over time",
      intent.getStringExtra(OverrunAlarmNotifier.EXTRA_TEXT) ?: "A Deckle has run past its expected time.",
      intent.getLongExtra(OverrunAlarmNotifier.EXTRA_DUE, 0L),
    )
  }
}

// The alarm notification's "Silence" button: stops every alarm that is sounding.
class OverrunSilenceReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val key = intent.getStringExtra(OverrunAlarmNotifier.EXTRA_KEY)
    if (key != null) {
      OverrunAlarmNotifier.cancel(context, key)
    } else {
      OverrunAlarmNotifier.silenceAll(context)
    }
  }
}
