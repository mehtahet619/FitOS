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
  Map<String, dynamic>? _plan;
  String _selectedStructure = "PPL";
  bool _generating = false;
  bool _choosingNewPlan = false;
  String? _banner;
  bool _bannerIsError = false;

  final _structures = const [
    ("PPL", "Push-Pull-Legs", "Push → Pull → Legs"),
    ("INDIVIDUAL", "Individual Muscle Split", "Chest → Back → Biceps → Triceps → Shoulders → Legs"),
    ("BRO", "Bro / Multi-Muscle Split", "Chest+Tri → Back+Bi → Legs+Shoulders"),
  ];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final plan = await ApiClient.instance.get("/workouts/plan") as Map<String, dynamic>;
      Map<String, dynamic>? workout;
      try {
        workout = await ApiClient.instance.get("/workouts/today") as Map<String, dynamic>;
      } on ApiException catch (e) {
        if (e.status != 404) rethrow;
      }
      setState(() {
        _plan = plan;
        _workout = workout;
        _choosingNewPlan = false;
        _loading = false;
      });
    } on ApiException catch (e) {
      setState(() {
        _banner = e.message;
        _bannerIsError = true;
        _loading = false;
      });
    } catch (_) {
      setState(() => _loading = false);
    }
  }

  Future<void> _selectPlan() async {
    setState(() => _generating = true);
    try {
      await ApiClient.instance.post("/workouts/plan", {"structureKey": _selectedStructure});
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

  Future<void> _generate({List<String>? scannedEquipment}) async {
    setState(() => _generating = true);
    try {
      await ApiClient.instance.post("/workouts/generate", scannedEquipment == null
          ? {"equipmentMode": "FULL_GYM"}
          : {"equipmentMode": "SCANNED", "detectedEquipmentNames": scannedEquipment});
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

  Future<void> _startCycle() async {
    setState(() => _generating = true);
    try {
      await ApiClient.instance.post("/workouts/plan/start-cycle", {});
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
    final names = await Navigator.of(context).push<List<String>>(MaterialPageRoute(
      builder: (_) => const EquipmentScanScreen(returnDetections: true),
    ));
    if (names != null && mounted) await _generate(scannedEquipment: names);
  }

  Future<void> _completeWorkout() async {
    await ApiClient.instance.post("/workouts/${_workout!["id"]}/complete", {});
    await _load();
  }

  bool get _hasPlan => _plan?["activePlan"] != null;
  bool get _cycleComplete => _plan?["cycleStatus"] == "COMPLETED";
  bool get _switchAllowed => _plan?["planSwitchAllowed"] == true;
  String get _nextLabel => _plan?["nextWorkout"]?["label"]?.toString() ?? "";

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 24),
        children: [
          Text("Workout", style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 4),
          Text(
            _workout != null
                ? "${_workout!["focus"]} · ${_workout!["durationMin"]} min · ${_workout!["status"]}"
                : _hasPlan
                    ? "${_plan?["activePlan"]?["structureLabel"] ?? "Active plan"} · ${_plan?["cycleStatus"]}"
                    : "Choose a workout structure first",
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          OutlineButton(label: "Scan my equipment", onPressed: _openScan),
          const SizedBox(height: 14),
          if (_banner != null) _bannerIsError ? InfoBanner.error(_banner!) : InfoBanner.success(_banner!),
          if (_loading) const Center(child: CircularProgressIndicator()),
          if (!_loading && _workout == null && (!_hasPlan || _choosingNewPlan)) _structurePicker(),
          if (!_loading && _workout == null && _hasPlan && !_choosingNewPlan) _activePlanCard(),
          if (!_loading && _workout != null) ...[
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text("Active: ${_plan?["activePlan"]?["structureLabel"] ?? ""}", style: const TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 4),
                  Text(
                    _switchAllowed ? "Plan switching unlocked" : "Plan switching locked until this cycle is finished",
                    style: const TextStyle(color: AppColors.muted, fontSize: 12),
                  ),
                ],
              ),
            ),
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
                          if (ex["requiresEquipment"] == true)
                            TextButton(
                              onPressed: () => _swap(ex["workoutExerciseId"]),
                              child: const Text("No equipment?"),
                            )
                          else
                            const Text("Bodyweight", style: TextStyle(color: AppColors.muted, fontSize: 12)),
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

  Widget _structurePicker() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text("Step 1: Choose your workout structure", style: TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              const Text("FitOS locks this structure until the full cycle is complete.", style: TextStyle(color: AppColors.muted, fontSize: 12)),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: _structures.map((item) {
                  final (key, label, detail) = item;
                  return ChoiceChip(
                    label: Text("$label\n$detail", style: const TextStyle(fontSize: 12)),
                    selected: _selectedStructure == key,
                    selectedColor: AppColors.mint,
                    backgroundColor: Colors.white,
                    side: const BorderSide(color: AppColors.border),
                    onSelected: (_) => setState(() => _selectedStructure = key),
                  );
                }).toList(),
              ),
            ],
          ),
        ),
        MintButton(label: "Start this plan", loading: _generating, onPressed: _selectPlan),
      ],
    );
  }

  Widget _activePlanCard() {
    final remaining = ((_plan?["remainingWorkouts"] as List?) ?? []).map((unit) => unit["label"]).join(" · ");
    return Column(
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text("Active Plan: ${_plan?["activePlan"]?["structureLabel"] ?? ""}", style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              Text("Cycle: ${_plan?["cycleId"]} · ${_plan?["cycleStatus"]}", style: const TextStyle(color: AppColors.muted, fontSize: 12)),
              const SizedBox(height: 8),
              Text("Remaining workouts: ${remaining.isEmpty ? "none" : remaining}", style: const TextStyle(fontSize: 13)),
              const SizedBox(height: 4),
              Text(_cycleComplete ? "Next workout: new cycle" : "Next workout: $_nextLabel", style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text(_switchAllowed ? "Plan switching: UNLOCKED" : "Plan switching: LOCKED", style: const TextStyle(color: AppColors.muted, fontSize: 12)),
            ],
          ),
        ),
        if (_cycleComplete) ...[
          MintButton(label: "Start next cycle", loading: _generating, onPressed: _startCycle),
          const SizedBox(height: 8),
          OutlineButton(label: "Switch structure", onPressed: _switchAllowed ? () {
            setState(() => _choosingNewPlan = true);
          } : null),
        ] else
          MintButton(label: "Generate $_nextLabel with full gym", loading: _generating, onPressed: () => _generate()),
      ],
    );
  }
}
