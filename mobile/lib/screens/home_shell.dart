import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import 'today_screen.dart';
import 'workout_screen.dart';
import 'diet_screen.dart';
import 'vision_screen.dart';
import 'gym_screen.dart';
import '../api/api_client.dart';
import 'auth_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  final _screens = const [
    TodayScreen(),
    WorkoutScreen(),
    DietScreen(),
    VisionScreen(),
    GymScreen(),
  ];

  final _items = const [
    (icon: Icons.home_rounded, label: "Today"),
    (icon: Icons.fitness_center_rounded, label: "Workout"),
    (icon: Icons.restaurant_rounded, label: "Diet"),
    (icon: Icons.center_focus_strong_rounded, label: "Vision"),
    (icon: Icons.badge_rounded, label: "Gym"),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(actions: [IconButton(icon: const Icon(Icons.logout), tooltip: "Log out", onPressed: () async { await ApiClient.instance.logout(); if (!context.mounted) return; Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => const AuthScreen()), (_) => false); })]),
      body: SafeArea(child: IndexedStack(index: _index, children: _screens)),
      bottomNavigationBar: SafeArea(
        child: Container(
          decoration: const BoxDecoration(
            color: AppColors.bg,
            border: Border(top: BorderSide(color: AppColors.border)),
          ),
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: List.generate(_items.length, (i) {
              final active = i == _index;
              final item = _items[i];
              return GestureDetector(
                onTap: () => setState(() => _index = i),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                        color: active ? AppColors.mint : Colors.transparent,
                        shape: BoxShape.circle,
                      ),
                      child: Icon(item.icon, size: 20, color: AppColors.ink),
                    ),
                    const SizedBox(height: 2),
                    Text(item.label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: active ? AppColors.ink : AppColors.muted)),
                  ],
                ),
              );
            }),
          ),
        ),
      ),
    );
  }
}
