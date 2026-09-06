import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../theme/app_theme.dart';
import 'equipment_scan_screen.dart';

class WorkoutScreen extends StatefulWidget {
  const WorkoutScreen({super.key});
  @override
  State<WorkoutScreen> createState() => _WorkoutScreenState();
}

class _WorkoutScreenState extends State<WorkoutScreen> {
  bool _loading = true;
  Map<String, dynamic>? _workout;
  bool _showGeneratePrompt = false;
  String _selectedFocus = "Chest + Triceps";
  bool _generating = false;
  String? _banner;
  bool _bannerIsError = false;

  final _focuses = const ["Chest + Triceps", "Back + Biceps", "Legs", "Shoulders + Core", "Full Body"];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final w = await ApiClient.instance.get("/workouts/today");
      setState(() {
        _workout = w;
        _showGeneratePrompt = false;
        _loading = false;
      });
    } on ApiException catch (e) {
      setState(() {
        _showGeneratePrompt = e.status == 404;
        _loading = false;
      });
    } catch (_) {
      setState(() => _loading = false);
    }
  }

  Future<void> _generate() async {
    setState(() => _generating = true);
    try {
      await ApiClient.instance.post("/workouts/generate", {"focus": _selectedFocus});
      await _load();
    } on ApiException catch (e) {
      setState(() {
        _banner = e.message;
        _bannerIsError = true;
      });
    } finally {
      if (mounted) setState(() => _generating = false);
    }
  }

  Future<void> _swap(String workoutExerciseId) async {
    try {
      final result = await ApiClient.instance.post("/workouts/${_workout!["id"]}/replace-exercise", {
        "workoutExerciseId": workoutExerciseId,
        "reason": "no_equipment",
      });
      setState(() {
        _banner = result["explanation"];
        _bannerIsError = false;
      });
      await _load();
    } on ApiException catch (e) {
      setState(() {
        _banner = e.message;
        _bannerIsError = true;
      });
    }
  }

  Future<void> _openScan() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const EquipmentScanScreen(mergeIntoProfile: true)));
    if (mounted) setState(() {});
  }

  Future<void> _completeWorkout() async {
    await ApiClient.instance.post("/workouts/${_workout!["id"]}/complete", {});
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 24),
        children: [
          Text("Workout", style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 4),
          Text(
            _workout != null ? "${_workout!["focus"]} · ${_workout!["durationMin"]} min · ${_workout!["status"]}" : "No workout yet",
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          OutlineButton(label: "📷 Scan my equipment", onPressed: _openScan),
          const SizedBox(height: 14),
          if (_banner != null) _bannerIsError ? InfoBanner.error(_banner!) : InfoBanner.success(_banner!),
          if (_loading) const Center(child: CircularProgressIndicator()),
          if (!_loading && _showGeneratePrompt) ...[
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text("Choose today's focus", style: TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: _focuses.map((f) {
                      return ChoiceChip(
                        label: Text(f),
                        selected: _selectedFocus == f,
                        selectedColor: AppColors.mint,
                        backgroundColor: Colors.white,
                        side: const BorderSide(color: AppColors.border),
                        onSelected: (_) => setState(() => _selectedFocus = f),
                      );
                    }).toList(),
                  ),
                ],
              ),
            ),
            MintButton(label: "Generate workout", loading: _generating, onPressed: _generate),
          ],
          if (!_loading && _workout != null) ...[
            AppCard(
              child: Column(
                children: [
                  for (final ex in (_workout!["exercises"] as List))
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(ex["name"], style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
                                const SizedBox(height: 2),
                                Text("${ex["primaryMuscle"]} · ${ex["targetSets"]} sets × ${ex["repRangeLow"]}-${ex["repRangeHigh"]} reps",
                                    style: const TextStyle(color: AppColors.muted, fontSize: 12)),
                                Text("${ex["status"]}", style: const TextStyle(color: AppColors.muted, fontSize: 12)),
                              ],
                            ),
                          ),
                          TextButton(
                            onPressed: () => _swap(ex["workoutExerciseId"]),
                            child: const Text("No equipment?"),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            if (_workout!["status"] != "completed") MintButton(label: "Mark workout complete", onPressed: _completeWorkout),
          ],
        ],
      ),
    );
  }
}
