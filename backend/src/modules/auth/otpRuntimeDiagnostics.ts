import { getEmailConfigStatus } from "./emailService";
import { logOtpFailure, logOtpStage } from "./otpDiagnostics";
import { getOtpLimiter, getOtpRedisConfigStatus } from "./tokenBucket";

/** Startup diagnostics never block startup and never print credential values. */
export async function logOtpRuntimeDiagnostics(): Promise<void> {
  logOtpStage("OTP service initialization started");

  const redis = getOtpRedisConfigStatus();
  console.info(`[CONFIG] UPSTASH_REDIS_REST_URL configured: ${redis.urlConfigured}`);
  console.info(`[CONFIG] UPSTASH_REDIS_REST_TOKEN configured: ${redis.tokenConfigured}`);
  const redisConfigurationValid = redis.urlConfigured && redis.tokenConfigured;
  console.info(`[OTP] Redis configuration: ${process.env.NODE_ENV === "production" ? (redisConfigurationValid ? "OK" : "FAILED") : "not required outside production"}`);
  const otpHashSecretConfigured = Boolean(process.env.OTP_HASH_SECRET?.trim());
  console.info(`[CONFIG] OTP_HASH_SECRET configured: ${otpHashSecretConfigured}`);

  const email = getEmailConfigStatus();
  console.info("[EMAIL] provider: nodemailer-smtp");
  console.info(`[EMAIL] provider configured: ${email.providerConfigured}`);
  console.info(`[EMAIL] sender configured: ${email.senderConfigured}`);
  console.info(`[EMAIL] credentials configured: ${email.credentialsConfigured}`);
  console.info(`[OTP] Email configuration: ${email.providerConfigured && email.senderConfigured && email.credentialsConfigured ? "OK" : "FAILED"}`);

  if (process.env.NODE_ENV === "production" && !otpHashSecretConfigured) {
    logOtpFailure("otp_hash_configuration", "node-crypto", new Error("Missing OTP_HASH_SECRET"));
  }

  if (process.env.NODE_ENV === "production" && !redisConfigurationValid) {
    const missing = [
      !redis.urlConfigured && "UPSTASH_REDIS_REST_URL",
      !redis.tokenConfigured && "UPSTASH_REDIS_REST_TOKEN",
    ].filter(Boolean).join(", ");
    const error = new Error(`Missing required configuration: ${missing}`);
    console.error("[OTP] Redis configuration: FAILED");
    logOtpFailure("redis_configuration", "upstash", error);
  } else {
    try {
      const response = await getOtpLimiter().ping();
      if (String(response).toUpperCase() !== "PONG") throw new Error("Unexpected response to Redis PING");
      console.info("[OTP] Redis connectivity: OK");
    } catch (error) {
      console.error("[OTP] Redis connectivity: FAILED");
      logOtpFailure("redis_ping", process.env.NODE_ENV === "production" ? "upstash" : "memory", error);
    }
  }

  logOtpStage("OTP service initialization complete");
}
