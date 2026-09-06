import 'package:flutter/material.dart';
import 'theme/app_theme.dart';
import 'api/api_client.dart';
import 'screens/auth_screen.dart';
import 'screens/onboarding_screen.dart';
import 'screens/home_shell.dart';

void main() {
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
      _goTo(const AuthScreen());
      return;
    }
    try {
      await ApiClient.instance.get("/user/profile");
      _goTo(const HomeShell());
    } on ApiException catch (e) {
      if (e.status == 404) {
        _goTo(const OnboardingScreen());
      } else {
        await ApiClient.instance.clearTokens();
        _goTo(const AuthScreen());
      }
    } catch (_) {
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
