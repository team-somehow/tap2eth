package expo.modules.keystoresigner

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * The phone's key for Tap2ETH: a P-256 key generated inside Android Keystore (TEE / StrongBox),
 * usable only after a strong biometric check, for every single signature.
 */
class KeystoreSignerModule : Module() {
  private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  override fun definition() = ModuleDefinition {
    Name("KeystoreSigner")

    Function("hasKey") { alias: String -> keyStore().containsAlias(alias) }

    Function("deleteKey") { alias: String -> keyStore().deleteEntry(alias) }

    Function("biometricsAvailable") {
      val ctx = appContext.reactContext ?: return@Function false
      BiometricManager.from(ctx).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
    }

    /** Creates the key if missing; returns the public key as base64 X.509 SubjectPublicKeyInfo. */
    Function("generateKey") { alias: String ->
      val ks = keyStore()
      if (!ks.containsAlias(alias)) {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
          .setUserAuthenticationRequired(true)
          .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
          // false: adding or removing a fingerprint must not destroy the wallet's only phone key. A wallet
          // with a dead phone key can't approve anything, and recovery needs a phone signature. The card is
          // still required for every payment above the small phone-only limit (if that option is on).
          .setInvalidatedByBiometricEnrollment(false)
          .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
          initialize(spec)
          generateKeyPair()
        }
      }
      Base64.encodeToString(ks.getCertificate(alias).publicKey.encoded, Base64.NO_WRAP)
    }

    /** Shows the fingerprint prompt, then signs SHA-256(data) with the key. Returns DER signature (base64). */
    AsyncFunction("sign") { alias: String, dataB64: String, title: String, subtitle: String, promise: Promise ->
      val activity = appContext.currentActivity as? FragmentActivity
        ?: return@AsyncFunction promise.reject("NO_ACTIVITY", "No active screen", null)
      val key = keyStore().getKey(alias, null) as? PrivateKey
        ?: return@AsyncFunction promise.reject("NO_KEY", "No key on this phone", null)
      val data = Base64.decode(dataB64, Base64.NO_WRAP)
      val sig = Signature.getInstance("SHA256withECDSA").apply { initSign(key) }

      activity.runOnUiThread {
        val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            try {
              val s = result.cryptoObject!!.signature!!
              s.update(data)
              promise.resolve(Base64.encodeToString(s.sign(), Base64.NO_WRAP))
            } catch (e: Exception) {
              promise.reject("SIGN_FAILED", e.message, e)
            }
          }
          override fun onAuthenticationError(code: Int, msg: CharSequence) {
            promise.reject("CANCELLED", msg.toString(), null)
          }
        })
        val info = BiometricPrompt.PromptInfo.Builder()
          .setTitle(title)
          .setSubtitle(subtitle)
          .setNegativeButtonText("Cancel")
          .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
          .build()
        prompt.authenticate(info, BiometricPrompt.CryptoObject(sig))
      }
    }
  }
}
