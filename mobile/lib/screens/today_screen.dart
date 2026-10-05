import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../theme/app_theme.dart';

class TodayScreen extends StatefulWidget {
  const TodayScreen({super.key});
  @override
  State<TodayScreen> createState() => _TodayScreenState();
}

class _TodayScreenState extends State<TodayScreen> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _dashboard;
  Map<String, dynamic>? _profile;
  Map<String, dynamic>? _nutrition;
  Map<String, dynamic>? _gym;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final dashboard = await ApiClient.instance.get("/progress/dashboard");
      final profile = await ApiClient.instance.get("/user/profile");
      Map<String, dynamic>? nutrition;
      try {
        nutrition = await ApiClient.instance.get("/nutrition/today");
      } catch (_) {}
      Map<String, dynamic>? gym;
      try {
        gym = await ApiClient.instance.get("/gym/today");
      } catch (_) {}
      setState(() {
        _dashboard = dashboard;
        _profile = profile;
        _nutrition = nutrition;
        _gym = gym;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = "Couldn't load your summary.";
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!, style: const TextStyle(color: AppColors.muted)));

    final plan = _dashboard?["todaysPlan"];
    final progress = _dashboard?["progress"] ?? {};
    final firstName = ((_profile?["name"] ?? "") as String).split(" ").first;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 24),
        children: [
          Text(firstName.isEmpty ? "Today" : "Hi, $firstName", style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 4),
          Text("Your day at a glance.", style: Theme.of(context).textTheme.bodyMedium),
          const SizedBox(height: 18),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text("Today's Workout", style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 6),
                plan != null
                    ? Text("${plan["focus"]}\n${plan["durationMin"]} min · ${plan["status"]}", style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800))
                    : const Text("No workout generated yet — head to the Workout tab.", style: TextStyle(color: AppColors.muted)),
              ],
            ),
          ),
          Row(children: [
            Expanded(
              child: AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text("🔥 Calories", style: TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 6),
                    Text(_nutrition != null ? "${_nutrition!["totals"]["calories"]}" : "—", style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text("📇 Gym", style: TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 6),
                    Text(_gym?["checkedIn"] == true ? "✓ checked in" : "—", style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                  ],
                ),
              ),
            ),
          ]),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text("📊 Weekly Volume", style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 6),
                Text("${progress["weeklyVolumeKg"] ?? 0} kg", style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                Text("${progress["workoutsThisWeek"] ?? 0} workouts this week", style: const TextStyle(color: AppColors.muted, fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
