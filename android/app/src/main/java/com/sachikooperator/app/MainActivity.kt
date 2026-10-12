package com.sachikooperator.app

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "SachikoOperatorApp"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handleAlarmIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleAlarmIntent(intent)
  }

  // Opened by the machine alarm: appear over the lock screen and light the screen so
  // the operator sees it without unlocking, and -- when a person tapped the
  // notification, as opposed to the full-screen launch that woke the screen --
  // stop the sound. The extras are cleared so a later relaunch from recents,
  // which reuses this intent, can't silence an alarm it knows nothing about.
  private fun handleAlarmIntent(intent: Intent?) {
    if (intent?.getBooleanExtra(OverrunAlarmNotifier.EXTRA_FROM_ALARM, false) != true) {
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
      )
    }
    if (intent.getBooleanExtra(OverrunAlarmNotifier.EXTRA_SILENCE, false)) {
      OverrunAlarmNotifier.silenceAll(this)
    }
    intent.removeExtra(OverrunAlarmNotifier.EXTRA_FROM_ALARM)
    intent.removeExtra(OverrunAlarmNotifier.EXTRA_SILENCE)
  }
}
