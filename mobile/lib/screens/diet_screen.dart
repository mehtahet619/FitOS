import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import '../api/api_client.dart';
import '../theme/app_theme.dart';

class DietScreen extends StatefulWidget {
  const DietScreen({super.key});
  @override
  State<DietScreen> createState() => _DietScreenState();
}

class _DietScreenState extends State<DietScreen> {
  bool _loading = true;
  bool _needsGenerate = false;
  bool _generating = false;
  Map<String, dynamic>? _nutrition;
  String? _error;

  // per-meal nearby results, keyed by foodId
  final Map<String, dynamic> _nearbyByFood = {};
  String? _nearbyLoadingFoodId;

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
      final n = await ApiClient.instance.get("/nutrition/today");
      setState(() {
        _nutrition = n;
        _needsGenerate = false;
        _loading = false;
      });
    } on ApiException catch (e) {
      setState(() {
        _needsGenerate = e.status == 404;
        _loading = false;
      });
    } catch (_) {
      setState(() => _loading = false);
    }
  }

  Future<void> _generate() async {
    setState(() => _generating = true);
    try {
      await ApiClient.instance.post("/nutrition/generate", {});
      await _load();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _generating = false);
    }
  }

  Future<void> _findNearby(String foodId, String foodName) async {
    setState(() => _nearbyLoadingFoodId = foodId);
    try {
      final permission = await Geolocator.checkPermission();
      LocationPermission granted = permission;
      if (granted == LocationPermission.denied) {
        granted = await Geolocator.requestPermission();
      }
      if (granted == LocationPermission.denied || granted == LocationPermission.deniedForever) {
        setState(() {
          _nearbyByFood[foodId] = {"error": "Location permission denied."};
          _nearbyLoadingFoodId = null;
        });
        return;
      }
      final pos = await Geolocator.getCurrentPosition();
      final result = await ApiClient.instance.get("/food/nearby?lat=${pos.latitude}&lng=${pos.longitude}&foodId=$foodId");
      setState(() {
        _nearbyByFood[foodId] = result;
        _nearbyLoadingFoodId = null;
      });
    } catch (e) {
      setState(() {
        _nearbyByFood[foodId] = {"error": "Couldn't get your location."};
        _nearbyLoadingFoodId = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());

    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 24),
        children: [
          Text("Diet", style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 4),
          Text("Approximate estimates, not medical advice.", style: Theme.of(context).textTheme.bodyMedium),
          const SizedBox(height: 14),
          if (_error != null) InfoBanner.error(_error!),
          if (_needsGenerate) ...[
            const Text("No nutrition plan generated for today yet.", style: TextStyle(color: AppColors.muted)),
            const SizedBox(height: 10),
            MintButton(label: "Generate today's meal plan", loading: _generating, onPressed: _generate),
          ],
          if (_nutrition != null) ...[
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text("Today's totals", style: TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 6),
                  Text("${_nutrition!["totals"]["calories"]} kcal", style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                  Text(
                    "P ${(_nutrition!["totals"]["proteinG"] as num).round()}g · C ${(_nutrition!["totals"]["carbsG"] as num).round()}g · F ${(_nutrition!["totals"]["fatG"] as num).round()}g",
                    style: const TextStyle(color: AppColors.muted, fontSize: 12),
                  ),
                ],
              ),
            ),
            AppCard(
              child: Column(
                children: [
                  for (final meal in (_nutrition!["meals"] as List)) _mealTile(meal),
                ],
              ),
            ),
            InfoBanner.info(_nutrition!["disclaimer"]),
          ],
        ],
      ),
    );
  }

  Widget _mealTile(dynamic meal) {
    final foodId = meal["foodId"] as String;
    final nearby = _nearbyByFood[foodId];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text((meal["slot"] as String).toUpperCase(), style: const TextStyle(color: AppColors.muted, fontSize: 11, fontWeight: FontWeight.w800)),
          Text(meal["name"], style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
          Text("${meal["calories"]} kcal · P${(meal["proteinG"] as num).round()}g · ₹${meal["estPriceInr"]}", style: const TextStyle(color: AppColors.muted, fontSize: 12)),
          const SizedBox(height: 6),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.ink,
                side: const BorderSide(color: AppColors.border),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
              ),
              onPressed: _nearbyLoadingFoodId == foodId ? null : () => _findNearby(foodId, meal["name"]),
              child: _nearbyLoadingFoodId == foodId
                  ? const SizedBox(height: 14, width: 14, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text("Find this near me", style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
            ),
          ),
          if (nearby != null) _nearbyResult(nearby),
        ],
      ),
    );
  }

  Widget _nearbyResult(dynamic nearby) {
    if (nearby["error"] != null) {
      return Padding(padding: const EdgeInsets.only(top: 8), child: InfoBanner.error(nearby["error"]));
    }
    if (nearby["configured"] == false) {
      return Padding(padding: const EdgeInsets.only(top: 8), child: InfoBanner.info(nearby["message"]));
    }
    final places = (nearby["places"] as List?) ?? [];
    if (places.isEmpty) {
      return const Padding(padding: EdgeInsets.only(top: 8), child: Text("No matches found nearby.", style: TextStyle(color: AppColors.muted, fontSize: 12)));
    }
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: places.map<Widget>((r) {
          final place = r["place"];
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Text(
              "${place["name"]} · ${(place["distanceKm"] as num).toStringAsFixed(1)} km · ⭐ ${place["rating"]}",
              style: const TextStyle(fontSize: 12),
            ),
          );
        }).toList(),
      ),
    );
  }
}
