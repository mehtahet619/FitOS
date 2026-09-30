import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

// - Running on web (flutter run -d chrome): auto-uses localhost, since the
//   Flutter web app runs as JS in your browser on the same machine as the
//   backend — this is why "flutter run on web" needs zero config here.
// - Physical phone: change PHYSICAL_DEVICE_BASE_URL below to your
//   computer's LAN IP, e.g. "http://192.168.1.23:4000" — "localhost" on a
//   phone means the phone itself, not your computer.
// - Android emulator: 10.0.2.2 is the emulator's alias for the host
//   machine's localhost (already set as the default below).
// - iOS simulator: "http://localhost:4000" works directly.
class ApiConfig {
  static const String _physicalDeviceOrEmulatorBaseUrl = String.fromEnvironment(
    "API_BASE_URL",
    defaultValue: "http://192.168.31.122:4000",
  );

  static String get baseUrl => kIsWeb ? "http://localhost:4000" : _physicalDeviceOrEmulatorBaseUrl;
}

class ApiException implements Exception {
  final int status;
  final String message;
  ApiException(this.status, this.message);
  @override
  String toString() => message;
}

class ApiClient {
  static final ApiClient instance = ApiClient._internal();
  ApiClient._internal();

  String? _accessToken;
  String? _refreshToken;

  Future<void> loadTokens() async {
    final prefs = await SharedPreferences.getInstance();
    _accessToken = prefs.getString("accessToken");
    _refreshToken = prefs.getString("refreshToken");
  }

  Future<Map<String, dynamic>> restoreSession() async {
    final result = await _request("GET", "/auth/me", retry: false);
    return Map<String, dynamic>.from(result as Map);
  }

  bool get isLoggedIn => _accessToken != null;

  Future<void> logout() async {
    try { await post("/auth/logout"); } catch (_) { /* clear local session even when offline */ }
    await clearTokens();
  }

  Future<void> setTokens({String? access, String? refresh}) async {
    final prefs = await SharedPreferences.getInstance();
    if (access != null) {
      _accessToken = access;
      await prefs.setString("accessToken", access);
    }
    if (refresh != null) {
      _refreshToken = refresh;
      await prefs.setString("refreshToken", refresh);
    }
  }

  Future<void> clearTokens() async {
    final prefs = await SharedPreferences.getInstance();
    _accessToken = null;
    _refreshToken = null;
    await prefs.remove("accessToken");
    await prefs.remove("refreshToken");
  }

  Future<dynamic> _request(String method, String path, {Map<String, dynamic>? body, bool retry = true}) async {
    final uri = Uri.parse("${ApiConfig.baseUrl}$path");
    final headers = {
      "Content-Type": "application/json",
      "X-FitOS-Client": "mobile",
      if (_accessToken != null) "Authorization": "Bearer $_accessToken",
    };

    http.Response res;
    switch (method) {
      case "GET":
        res = await http.get(uri, headers: headers);
        break;
      case "POST":
        res = await http.post(uri, headers: headers, body: body != null ? jsonEncode(body) : null);
        break;
      case "PUT":
        res = await http.put(uri, headers: headers, body: body != null ? jsonEncode(body) : null);
        break;
      default:
        throw ApiException(0, "Unsupported method $method");
    }

    if (res.statusCode == 401 && retry && _refreshToken != null && path != "/auth/refresh") {
      final refreshed = await http.post(
        Uri.parse("${ApiConfig.baseUrl}/auth/refresh"),
        headers: {"Content-Type": "application/json", "X-FitOS-Client": "mobile"},
        body: jsonEncode({"refreshToken": _refreshToken}),
      );
      if (refreshed.statusCode == 200) {
        final data = jsonDecode(refreshed.body);
        await setTokens(access: data["accessToken"]);
        return _request(method, path, body: body, retry: false);
      } else {
        await clearTokens();
      }
    }

    if (res.statusCode == 401 && path != "/auth/me" && path != "/auth/login" && path != "/auth/register/request-otp" && path != "/auth/register/verify-otp") await clearTokens();

    final decoded = res.body.isNotEmpty ? jsonDecode(res.body) : null;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      final msg = (decoded is Map && (decoded["message"] != null || decoded["error"] != null)) ? (decoded["message"] ?? decoded["error"]).toString() : res.reasonPhrase ?? "Request failed";
      throw ApiException(res.statusCode, msg);
    }
    return decoded;
  }

  Future<dynamic> get(String path) => _request("GET", path);
  Future<dynamic> post(String path, [Map<String, dynamic>? body]) => _request("POST", path, body: body ?? {});
  Future<dynamic> put(String path, [Map<String, dynamic>? body]) => _request("PUT", path, body: body ?? {});
}
