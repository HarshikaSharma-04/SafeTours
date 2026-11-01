package expo.modules.safetourssms

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Sends ONE text message directly (no composer) with android.telephony.SmsManager and reports what the radio
 * said. Every part of the message gets a "sent" PendingIntent; the promise resolves only when all parts have
 * reported (or after 30 s), with { ok, error }. It never claims success on its own: ok is true only when every
 * part came back RESULT_OK.
 *
 * Needs the SEND_SMS permission (requested from JS with PermissionsAndroid). Google Play restricts this
 * permission: see the notes in the phase 6B report.
 */
class SafeToursSmsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("SafeToursSms")

    AsyncFunction("isAvailableAsync") {
      return@AsyncFunction context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
    }

    AsyncFunction("hasPermissionAsync") {
      return@AsyncFunction ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
    }

    AsyncFunction("sendTextAsync") { phone: String, message: String, promise: Promise ->
      sendText(phone, message, promise)
    }
  }

  // The SIM the user chose for SMS (dual-SIM phones); the system default when none is chosen.
  @Suppress("DEPRECATION")
  private fun smsManager(): SmsManager {
    val subscriptionId = SubscriptionManager.getDefaultSmsSubscriptionId()
    val hasDefault = subscriptionId != SubscriptionManager.INVALID_SUBSCRIPTION_ID
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val manager = context.getSystemService(SmsManager::class.java)
      if (hasDefault) manager.createForSubscriptionId(subscriptionId) else manager
    } else {
      if (hasDefault) SmsManager.getSmsManagerForSubscriptionId(subscriptionId) else SmsManager.getDefault()
    }
  }

  // True only when every slot is definitely empty: any other state is left for the radio to answer.
  @Suppress("DEPRECATION")
  private fun noSimInserted(): Boolean {
    val telephony = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return false
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return telephony.simState == TelephonyManager.SIM_STATE_ABSENT
    val slots = telephony.phoneCount
    return slots > 0 && (0 until slots).all { telephony.getSimState(it) == TelephonyManager.SIM_STATE_ABSENT }
  }

  private fun describe(resultCode: Int): String = when (resultCode) {
    SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "generic_failure"
    SmsManager.RESULT_ERROR_RADIO_OFF -> "radio_off"
    SmsManager.RESULT_ERROR_NULL_PDU -> "null_pdu"
    4 -> "no_service" // SmsManager.RESULT_ERROR_NO_SERVICE
    5 -> "limit_exceeded" // RESULT_ERROR_LIMIT_EXCEEDED
    9 -> "radio_off" // RESULT_RADIO_NOT_AVAILABLE
    else -> "error_$resultCode"
  }

  private fun sendText(phone: String, message: String, promise: Promise) {
    val ctx = context
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
      promise.resolve(mapOf("ok" to false, "error" to "no_permission"))
      return
    }

    val done = AtomicBoolean(false)
    val handler = Handler(Looper.getMainLooper())
    var receiver: BroadcastReceiver? = null
    // Every way out goes through here, so the receiver and the timeout are always released.
    val finish = { ok: Boolean, error: String? ->
      if (done.compareAndSet(false, true)) {
        handler.removeCallbacksAndMessages(null)
        try {
          receiver?.let { ctx.unregisterReceiver(it) }
        } catch (e: Exception) {
          // already unregistered
        }
        promise.resolve(mapOf("ok" to ok, "error" to error))
      }
    }

    try {
      if (noSimInserted()) {
        finish(false, "no_sim")
        return
      }

      val manager = smsManager()
      val parts = manager.divideMessage(message)
      val action = "expo.modules.safetourssms.SENT." + UUID.randomUUID()
      val remaining = AtomicInteger(parts.size)
      val failure = arrayOfNulls<String>(1)

      val sentReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
          if (resultCode != Activity.RESULT_OK && failure[0] == null) failure[0] = describe(resultCode)
          if (remaining.decrementAndGet() == 0) finish(failure[0] == null, failure[0])
        }
      }
      receiver = sentReceiver

      val filter = IntentFilter(action)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ctx.registerReceiver(sentReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        ctx.registerReceiver(sentReceiver, filter)
      }

      // The radio can take a while without signal: stop waiting (and say so) after 30 s.
      handler.postDelayed({ finish(false, "timeout") }, 30000)

      val sentIntents = ArrayList<PendingIntent>()
      for (i in 0 until parts.size) {
        val intent = Intent(action).setPackage(ctx.packageName)
        sentIntents.add(
          PendingIntent.getBroadcast(ctx, i, intent, PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE)
        )
      }

      if (parts.size == 1) {
        manager.sendTextMessage(phone, null, message, sentIntents[0], null)
      } else {
        manager.sendMultipartTextMessage(phone, null, parts, sentIntents, null)
      }
    } catch (e: SecurityException) {
      finish(false, "security_exception")
    } catch (e: Exception) {
      finish(false, e.javaClass.simpleName + ": " + (e.message ?: "send failed"))
    }
  }
}
