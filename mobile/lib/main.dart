import 'package:flutter/material.dart';
import 'theme/app_theme.dart';
import 'api/api_client.dart';
import 'screens/auth_screen.dart';
import 'screens/onboarding_screen.dart';
import 'screens/home_shell.dart';
import 'posthog/posthog.dart';
import 'posthog/posthog_logs.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await setupPostHog();
  PosthogAppLogger.info('application_booted');
  runApp(const AdaptiveFitApp());
}

class AdaptiveFitApp extends StatelessWidget {
  const AdaptiveFitApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Adaptive Fit',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      home: const BootScreen(),
    );
  }
}

class BootScreen extends StatefulWidget {
  const BootScreen({super.key});
  @override
  State<BootScreen> createState() => _BootScreenState();
}

class _BootScreenState extends State<BootScreen> {
  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    await ApiClient.instance.loadTokens();
    if (!ApiClient.instance.isLoggedIn) {
      PosthogAppLogger.info('boot_routed_to_authentication');
      _goTo(const AuthScreen());
      return;
    }
    try {
      final session = await ApiClient.instance.restoreSession();
      if (session["authenticated"] != true) {
        await ApiClient.instance.clearTokens();
        PosthogAppLogger.warn('stored_session_rejected');
        _goTo(const AuthScreen());
        return;
      }
      PosthogAppLogger.info('authenticated_session_restored');
      _goTo(const HomeShell());
    } on ApiException {
      await ApiClient.instance.clearTokens();
      PosthogAppLogger.warn('session_restore_request_failed');
      _goTo(const AuthScreen());
    } catch (_) {
      PosthogAppLogger.warn('session_restore_unexpected_failure');
      _goTo(const AuthScreen());
    }
  }

  void _goTo(Widget screen) {
    if (!mounted) return;
    Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => screen));
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(body: Center(child: CircularProgressIndicator()));
  }
}
