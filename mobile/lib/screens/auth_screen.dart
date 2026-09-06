import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../theme/app_theme.dart';
import 'onboarding_screen.dart';
import 'home_shell.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});
  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  bool _isRegister = false;
  bool _loading = false;
  String? _error;

  Future<void> _submit() async {
    final email = _emailCtrl.text.trim();
    final password = _passwordCtrl.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() => _error = "Enter an email and password.");
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final path = _isRegister ? "/auth/register" : "/auth/login";
      final data = await ApiClient.instance.post(path, {"email": email, "password": password});
      await ApiClient.instance.setTokens(access: data["accessToken"], refresh: data["refreshToken"]);
      if (!mounted) return;
      try {
        await ApiClient.instance.get("/user/profile");
        Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomeShell()));
      } on ApiException catch (e) {
        if (e.status == 404) {
          Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const OnboardingScreen()));
        } else {
          rethrow;
        }
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = "Couldn't reach the server. Check ApiConfig.baseUrl in lib/api/api_client.dart.");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Center(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(_isRegister ? "Create your account" : "Welcome back", style: Theme.of(context).textTheme.headlineMedium),
                  const SizedBox(height: 6),
                  Text("Adaptive workouts, nutrition, and gym check-in — built around what you actually have.",
                      style: Theme.of(context).textTheme.bodyMedium),
                  const SizedBox(height: 20),
                  if (_error != null) InfoBanner.error(_error!),
                  TextField(controller: _emailCtrl, decoration: const InputDecoration(labelText: "Email"), keyboardType: TextInputType.emailAddress),
                  const SizedBox(height: 12),
                  TextField(controller: _passwordCtrl, decoration: const InputDecoration(labelText: "Password"), obscureText: true),
                  const SizedBox(height: 18),
                  MintButton(label: _isRegister ? "Sign up" : "Log in", loading: _loading, onPressed: _submit),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: () => setState(() => _isRegister = !_isRegister),
                    child: Text(_isRegister ? "Already have an account? Log in" : "New here? Create an account"),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
