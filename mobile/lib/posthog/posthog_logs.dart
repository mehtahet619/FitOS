import 'package:posthog_flutter/posthog_flutter.dart';

import 'posthog.dart';

/// Emits only the purpose-written application logs selected for PostHog.
class PosthogAppLogger {
  PosthogAppLogger._();

  static void info(String message, [Map<String, Object>? attributes]) {
    if (!postHogConfigured) return;
    try {
      Posthog().logger.info(message, attributes);
    } catch (_) {}
  }

  static void warn(String message, [Map<String, Object>? attributes]) {
    if (!postHogConfigured) return;
    try {
      Posthog().logger.warn(message, attributes);
    } catch (_) {}
  }
}
