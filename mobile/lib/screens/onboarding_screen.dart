import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../theme/app_theme.dart';
import 'home_shell.dart';
import 'equipment_scan_screen.dart';

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});
  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final _name = TextEditingController();
  final _age = TextEditingController();
  final _height = TextEditingController();
  final _weight = TextEditingController();
  final _days = TextEditingController();
  final _budget = TextEditingController();
  final _allergies = TextEditingController();

  String _gender = "male";
  String _level = "intermediate";
  String _goal = "muscle_gain";
  String _diet = "vegetarian";

  List<dynamic> _equipmentList = [];
  final Set<String> _selected = {};
  bool _loadingEquipment = true;
  bool _submitting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadEquipment();
  }

  Future<void> _loadEquipment() async {
    try {
      final list = await ApiClient.instance.get("/equipment");
      setState(() {
        _equipmentList = list;
        _loadingEquipment = false;
      });
    } catch (_) {
      setState(() => _loadingEquipment = false);
    }
  }

  Future<void> _openScan() async {
    final detected = await Navigator.of(context).push<List<String>>(
      MaterialPageRoute(builder: (_) => const EquipmentScanScreen()),
    );
    if (detected != null && detected.isNotEmpty) {
      setState(() => _selected.addAll(detected));
    }
  }

  Future<void> _submit() async {
    if (_name.text.trim().isEmpty || _age.text.isEmpty || _height.text.isEmpty || _weight.text.isEmpty || _days.text.isEmpty) {
      setState(() => _error = "Please fill in all fields.");
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ApiClient.instance.put("/user/profile", {
        "name": _name.text.trim(),
        "age": int.parse(_age.text),
        "gender": _gender,
        "heightCm": double.parse(_height.text),
        "weightKg": double.parse(_weight.text),
        "fitnessLevel": _level,
        "primaryGoal": _goal,
        "daysPerWeek": int.parse(_days.text),
        "dietaryPref": _diet,
        "allergies": _allergies.text.split(",").map((s) => s.trim()).where((s) => s.isNotEmpty).toList(),
        "foodLikes": [],
        "dailyBudget": double.tryParse(_budget.text) ?? 0,
      });
      await ApiClient.instance.post("/equipment/user/equipment", {"equipmentNames": _selected.toList()});
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomeShell()));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Widget _dropdown(String label, String value, List<String> options, ValueChanged<String?> onChanged) {
    return DropdownButtonFormField<String>(
      value: value,
      decoration: InputDecoration(labelText: label),
      items: options.map((o) => DropdownMenuItem(value: o, child: Text(o))).toList(),
      onChanged: onChanged,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Set up your plan")),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 8, 18, 100),
          children: [
            Text("This tunes your workouts, nutrition targets, and equipment matching.", style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: 16),
            if (_error != null) InfoBanner.error(_error!),
            AppCard(
              child: Column(
                children: [
                  TextField(controller: _name, decoration: const InputDecoration(labelText: "Name")),
                  const SizedBox(height: 12),
                  Row(children: [
                    Expanded(child: TextField(controller: _age, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: "Age"))),
                    const SizedBox(width: 12),
                    Expanded(child: _dropdown("Gender", _gender, const ["male", "female", "other"], (v) => setState(() => _gender = v!))),
                  ]),
                  const SizedBox(height: 12),
                  Row(children: [
                    Expanded(child: TextField(controller: _height, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: "Height (cm)"))),
                    const SizedBox(width: 12),
                    Expanded(child: TextField(controller: _weight, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: "Weight (kg)"))),
                  ]),
                  const SizedBox(height: 12),
                  _dropdown("Fitness level", _level, const ["beginner", "intermediate", "advanced"], (v) => setState(() => _level = v!)),
                  const SizedBox(height: 12),
                  _dropdown("Primary goal", _goal, const ["muscle_gain", "fat_loss", "strength", "general_fitness", "endurance"], (v) => setState(() => _goal = v!)),
                  const SizedBox(height: 12),
                  Row(children: [
                    Expanded(child: TextField(controller: _days, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: "Days / week"))),
                  ]),
                  const SizedBox(height: 12),
                  _dropdown("Dietary preference", _diet, const ["vegetarian", "vegan", "non_vegetarian", "eggetarian"], (v) => setState(() => _diet = v!)),
                  const SizedBox(height: 12),
                  TextField(controller: _budget, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: "Daily food budget (₹)")),
                  const SizedBox(height: 12),
                  TextField(controller: _allergies, decoration: const InputDecoration(labelText: "Allergies (comma separated, optional)")),
                ],
              ),
            ),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text("🏋️ What equipment do you have?", style: TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 10),
                  OutlineButton(label: "📷 Scan with camera instead", onPressed: _openScan),
                  const SizedBox(height: 12),
                  _loadingEquipment
                      ? const Center(child: CircularProgressIndicator())
                      : Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: _equipmentList.map<Widget>((eq) {
                            final name = eq["name"] as String;
                            final active = _selected.contains(name);
                            return FilterChip(
                              label: Text(name),
                              selected: active,
                              selectedColor: AppColors.mint,
                              backgroundColor: Colors.white,
                              side: const BorderSide(color: AppColors.border),
                              onSelected: (v) => setState(() => v ? _selected.add(name) : _selected.remove(name)),
                            );
                          }).toList(),
                        ),
                ],
              ),
            ),
            MintButton(label: "Save & continue", loading: _submitting, onPressed: _submit),
          ],
        ),
      ),
    );
  }
}
