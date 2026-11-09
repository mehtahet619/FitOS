import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:posthog_flutter/posthog_flutter.dart';

/// Build-time configuration supplied with `--dart-define`.
class PosthogEnv {
  static const projectToken = String.fromEnvironment('POSTHOG_PROJECT_TOKEN');
  static const host = String.fromEnvironment('POSTHOG_HOST');
}

bool _postHogConfigured = false;
bool get postHogConfigured => _postHogConfigured;

/// Configures the single PostHog client used throughout the native app.
Future<void> setupPostHog() async {
  if (PosthogEnv.projectToken.isEmpty) {
    if (kDebugMode) {
      throw StateError(
        'POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or '
        'un-configured, this causes events to be silently missed. This error '
        'stops appearing once POSTHOG_PROJECT_TOKEN is configured',
      );
    }
    return;
  }

  if (PosthogEnv.host.isEmpty) {
    if (kDebugMode) {
      throw StateError(
        'POSTHOG_HOST variable required by PostHog is missing or un-configured, '
        'this causes events to be silently missed. This error stops appearing '
        'once POSTHOG_HOST is configured',
      );
    }
    return;
  }

  final config = PostHogConfig(PosthogEnv.projectToken);
  config.host = PosthogEnv.host;
  config.debug = kDebugMode;
  config.logsConfig.serviceName = 'adaptive-fit-mobile';
  config.logsConfig.environment = kReleaseMode ? 'production' : 'development';

  // Capture uncaught Flutter framework and platform-dispatcher errors globally.
  // Handled errors can use Posthog().captureException() where useful.
  config.errorTrackingConfig.captureFlutterErrors = true;
  config.errorTrackingConfig.capturePlatformDispatcherErrors = true;

  await Posthog().setup(config);
  _postHogConfigured = true;
}

void capturePostHogEvent(
  String eventName, {
  Map<String, Object>? properties,
}) {
  if (!postHogConfigured) return;
  try {
    unawaited(
      Posthog()
          .capture(eventName: eventName, properties: properties)
          .catchError((Object _, StackTrace __) {}),
    );
  } catch (_) {}
}

void resetPostHog() {
  if (!postHogConfigured) return;
  try {
    unawaited(Posthog().reset().catchError((Object _, StackTrace __) {}));
  } catch (_) {}
}
