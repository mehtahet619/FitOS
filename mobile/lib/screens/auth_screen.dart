import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../theme/app_theme.dart';
import 'home_shell.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});
  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final _otpCtrl = TextEditingController();
  bool _isRegister = false;
  bool _verifyStep = false;
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
      if (_isRegister && !_verifyStep) {
        if (_nameCtrl.text.trim().isEmpty) throw ApiException(400, "Enter your name.");
        await ApiClient.instance.post("/auth/register/request-otp", {"name": _nameCtrl.text.trim(), "email": email, "password": password});
        if (mounted) setState(() { _verifyStep = true; _error = "Enter the 6-digit code sent to $email"; });
        return;
      }
      final data = _verifyStep
          ? await ApiClient.instance.post("/auth/register/verify-otp", {"email": email, "otp": _otpCtrl.text.trim()})
          : await ApiClient.instance.post("/auth/login", {"email": email, "password": password});
      await ApiClient.instance.setTokens(access: data["accessToken"], refresh: data["refreshToken"]);
      if (_verifyStep) { sessionStorageClear(); }
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomeShell()));
    } on ApiException catch (e) {
      if (e.status == 403) setState(() { _isRegister = true; _verifyStep = true; _error = e.message; });
      else setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = "Couldn't reach the server. Check ApiConfig.baseUrl in lib/api/api_client.dart.");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void sessionStorageClear() { _otpCtrl.clear(); }

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
                  if (_isRegister && !_verifyStep) TextField(controller: _nameCtrl, decoration: const InputDecoration(labelText: "Name"), textCapitalization: TextCapitalization.words),
                  TextField(controller: _emailCtrl, decoration: const InputDecoration(labelText: "Email"), keyboardType: TextInputType.emailAddress),
                  const SizedBox(height: 12),
                  if (!_verifyStep) TextField(controller: _passwordCtrl, decoration: const InputDecoration(labelText: "Password"), obscureText: true),
                  if (_verifyStep) TextField(controller: _otpCtrl, decoration: const InputDecoration(labelText: "6-digit verification code"), keyboardType: TextInputType.number, maxLength: 6),
                  const SizedBox(height: 18),
                  MintButton(label: _verifyStep ? "Verify email" : _isRegister ? "Sign up" : "Log in", loading: _loading, onPressed: _submit),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: () => setState(() { _isRegister = !_isRegister; _verifyStep = false; _error = null; }),
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
